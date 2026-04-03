import { Job } from 'bull';
import { supabase } from '../index';
import { BiComClient } from '../services/bicom-client';
import { BiComMapper } from '../services/bicom-mapper';
import { logger } from '../utils/logger';

const mapper = new BiComMapper();

export async function bicomMigrationProcessor(job: Job) {
  const { syncId, serverUrl, apiKey, bicomTenantId, dryRun } = job.data;
  const client = new BiComClient(serverUrl, apiKey);
  const results = { org_id: null as string | null, users: 0, ring_groups: 0, queues: 0, ivrs: 0, dids: 0, errors: [] as string[] };

  await supabase.from('bicom_tenant_sync')
    .update({ status: 'in_progress', last_sync_at: new Date().toISOString() })
    .eq('id', syncId);

  try {
    job.progress(5);
    logger.info(`[BiCom ${syncId}] Fetching tenant data...`);

    const [tenant, rawExtensions, rawRingGroups, rawQueues, rawIVRs, rawDIDs] = await Promise.all([
      client.getTenant(bicomTenantId).catch(() => ({ id: bicomTenantId })),
      client.listExtensions(bicomTenantId).catch(() => []),
      client.listRingGroups(bicomTenantId).catch(() => []),
      client.listQueues(bicomTenantId).catch(() => []),
      client.listIVRs(bicomTenantId).catch(() => []),
      client.listDIDs(bicomTenantId).catch(() => []),
    ]);

    logger.info(`[BiCom ${syncId}] ext:${rawExtensions.length} rg:${rawRingGroups.length} q:${rawQueues.length} ivr:${rawIVRs.length} did:${rawDIDs.length}`);
    job.progress(15);

    // Update counts
    await supabase.from('bicom_tenant_sync').update({
      extensions_count: rawExtensions.length,
      ring_groups_count: rawRingGroups.length,
      ivrs_count: rawIVRs.length,
      dids_count: rawDIDs.length,
    }).eq('id', syncId);

    if (dryRun) {
      await supabase.from('bicom_tenant_sync').update({
        status: 'synced',
        sync_summary: { dry_run: true, counts: { extensions: rawExtensions.length, ring_groups: rawRingGroups.length, ivrs: rawIVRs.length, dids: rawDIDs.length } },
      }).eq('id', syncId);
      return results;
    }

    // ── Get or create org ────────────────────────────────────────────────────
    const { data: existingSync } = await supabase.from('bicom_tenant_sync').select('soniq_org_id').eq('id', syncId).single();
    let orgId = existingSync?.soniq_org_id;

    if (!orgId) {
      const orgData = mapper.mapTenantToOrg(tenant, bicomTenantId);
      const { data: org, error: orgErr } = await supabase.from('orgs').insert(orgData).select('id').single();
      if (orgErr) throw new Error(`Failed to create org: ${orgErr.message}`);
      orgId = org.id;
      await supabase.from('bicom_tenant_sync').update({ soniq_org_id: orgId }).eq('id', syncId);
    }
    results.org_id = orgId;
    job.progress(25);

    // ── Extensions ───────────────────────────────────────────────────────────
    const orgUsersByExt: Record<string, any> = {};
    for (const ext of rawExtensions) {
      try {
        const { orgUser, sipCred } = mapper.mapExtension(ext, orgId!);
        const { data: user, error } = await supabase.from('org_users')
          .upsert(orgUser, { onConflict: 'org_id,extension' }).select('id').single();
        if (error) { results.errors.push(`Ext ${orgUser.extension}: ${error.message}`); continue; }
        orgUsersByExt[orgUser.extension] = { id: user.id };
        (sipCred as any).org_user_id = user.id;
        await supabase.from('sip_credentials').upsert(sipCred, { onConflict: 'org_id,extension' });
        results.users++;
      } catch (e: any) { results.errors.push(`Ext ${ext.extension}: ${e.message}`); }
    }
    job.progress(45);

    // ── Ring groups ──────────────────────────────────────────────────────────
    const ringGroupsByBicomId: Record<string, any> = {};
    for (const rg of rawRingGroups) {
      try {
        const fullRG = await client.getRingGroup(bicomTenantId, rg.id).catch(() => rg);
        const { group, members } = mapper.mapRingGroup(fullRG, orgId!, orgUsersByExt);
        const { data: g, error } = await supabase.from('user_groups').upsert(group, { onConflict: 'org_id,name' }).select('id').single();
        if (error) { results.errors.push(`RG ${group.name}: ${error.message}`); continue; }
        ringGroupsByBicomId[String(rg.id)] = { id: g.id };
        await supabase.from('user_group_members').delete().eq('group_id', g.id);
        if (members.length) await supabase.from('user_group_members').insert(members.map(m => ({ group_id: g.id, ...m })));
        results.ring_groups++;
      } catch (e: any) { results.errors.push(`RG ${rg.name}: ${e.message}`); }
    }
    job.progress(60);

    // ── Queues ───────────────────────────────────────────────────────────────
    for (const q of rawQueues) {
      try {
        const fullQ = await client.getQueue(bicomTenantId, q.id).catch(() => q);
        const { queue, members } = mapper.mapQueue(fullQ, orgId!, orgUsersByExt);
        const { data: qRow, error } = await supabase.from('call_queues').upsert(queue, { onConflict: 'org_id,name' }).select('id').single();
        if (error) { results.errors.push(`Q ${queue.name}: ${error.message}`); continue; }
        await supabase.from('queue_members').delete().eq('queue_id', qRow.id);
        if (members.length) await supabase.from('queue_members').insert(members.map(m => ({ queue_id: qRow.id, ...m })));
        results.queues++;
      } catch (e: any) { results.errors.push(`Q ${q.name}: ${e.message}`); }
    }
    job.progress(72);

    // ── IVRs ─────────────────────────────────────────────────────────────────
    for (const ivr of rawIVRs) {
      try {
        const fullIVR = await client.getIVR(bicomTenantId, ivr.id).catch(() => ivr);
        await supabase.from('call_flows').upsert(mapper.mapIVR(fullIVR, orgId!), { onConflict: 'org_id,name' });
        results.ivrs++;
      } catch (e: any) { results.errors.push(`IVR ${ivr.name}: ${e.message}`); }
    }
    job.progress(85);

    // ── DIDs ─────────────────────────────────────────────────────────────────
    for (const did of rawDIDs) {
      try {
        const fullDID = await client.getDID(bicomTenantId, did.id).catch(() => did);
        const { flow, phoneNumber } = mapper.mapDID(fullDID, orgId!);
        const { data: flowRow } = await supabase.from('call_flows').upsert(flow, { onConflict: 'org_id,name' }).select('id').single();
        if (flowRow) (phoneNumber as any).call_flow_id = flowRow.id;
        await supabase.from('phone_numbers').upsert(phoneNumber, { onConflict: 'number' });
        results.dids++;
      } catch (e: any) { results.errors.push(`DID: ${e.message}`); }
    }
    job.progress(98);

    // ── Finalise ─────────────────────────────────────────────────────────────
    const finalStatus = results.errors.length > 0 ? 'partial' : 'synced';
    await supabase.from('bicom_tenant_sync').update({
      status: finalStatus,
      soniq_org_id: orgId,
      extensions_synced: results.users,
      ring_groups_synced: results.ring_groups,
      ivrs_synced: results.ivrs,
      dids_synced: results.dids,
      last_sync_at: new Date().toISOString(),
      last_error: results.errors.length > 0 ? results.errors.slice(0, 5).join('; ') : null,
      sync_summary: results,
    }).eq('id', syncId);

    job.progress(100);
    logger.info(`[BiCom ${syncId}] Done. users:${results.users} rg:${results.ring_groups} ivr:${results.ivrs} did:${results.dids} errors:${results.errors.length}`);
    return results;

  } catch (err: any) {
    logger.error(`[BiCom ${syncId}] Fatal: ${err.message}`);
    await supabase.from('bicom_tenant_sync').update({
      status: 'error', last_error: err.message, last_sync_at: new Date().toISOString(),
    }).eq('id', syncId);
    throw err;
  }
}
