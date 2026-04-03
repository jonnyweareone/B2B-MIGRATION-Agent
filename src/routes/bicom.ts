import { Router } from 'express';
import { migrationQueue, supabase } from '../index';
import { BiComClient } from '../services/bicom-client';
import { logger } from '../utils/logger';

const router = Router();

const verifyApiKey = (req: any, res: any, next: any) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

router.use(verifyApiKey);

// ── Servers ───────────────────────────────────────────────────────────────────

router.get('/servers', async (req, res) => {
  const { data, error } = await supabase.from('bicom_servers')
    .select('id, name, server_url, tenant_count, last_synced_at, is_active, partner_id, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/servers', async (req, res) => {
  const { name, server_url, api_key, partner_id } = req.body;
  if (!name || !server_url || !api_key) return res.status(400).json({ error: 'name, server_url, api_key required' });
  try {
    const client = new BiComClient(server_url, api_key);
    await client.ping();
  } catch (e: any) {
    return res.status(400).json({ error: `Cannot connect to BiCom: ${e.message}` });
  }
  const { data, error } = await supabase.from('bicom_servers')
    .insert({ name, server_url, api_key, partner_id: partner_id || null })
    .select('id, name, server_url, tenant_count').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/servers/:id/test', async (req, res) => {
  const { data: server } = await supabase.from('bicom_servers').select('server_url, api_key').eq('id', req.params.id).single();
  if (!server) return res.status(404).json({ error: 'Not found' });
  try {
    const tenants = await new BiComClient(server.server_url, server.api_key).listTenants();
    res.json({ ok: true, tenant_count: tenants.length });
  } catch (e: any) { res.status(400).json({ ok: false, error: e.message }); }
});

router.post('/servers/:id/discover', async (req, res) => {
  const { data: server } = await supabase.from('bicom_servers').select('*').eq('id', req.params.id).single();
  if (!server) return res.status(404).json({ error: 'Not found' });
  try {
    const client = new BiComClient(server.server_url, server.api_key);
    const tenants = await client.listTenants();
    for (const t of tenants) {
      await supabase.from('bicom_tenant_sync').upsert({
        server_id: server.id,
        bicom_tenant_id: String(t.id || t.tenant_id),
        bicom_tenant_name: t.name || t.company || `Tenant ${t.id}`,
      }, { onConflict: 'server_id,bicom_tenant_id', ignoreDuplicates: true });
    }
    await supabase.from('bicom_servers').update({ tenant_count: tenants.length, last_synced_at: new Date().toISOString() }).eq('id', server.id);
    res.json({ ok: true, tenants_found: tenants.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Tenants ───────────────────────────────────────────────────────────────────

router.get('/tenants', async (req, res) => {
  const { server_id, status } = req.query;
  let q = supabase.from('bicom_tenant_sync')
    .select('id, bicom_tenant_id, bicom_tenant_name, status, last_sync_at, last_error, extensions_count, ring_groups_count, ivrs_count, dids_count, extensions_synced, ring_groups_synced, ivrs_synced, dids_synced, soniq_org_id, created_at, bicom_servers(id, name, server_url)')
    .order('bicom_tenant_name');
  if (server_id) q = q.eq('server_id', server_id as string);
  if (status) q = q.eq('status', status as string);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/tenants/:id', async (req, res) => {
  const { data, error } = await supabase.from('bicom_tenant_sync')
    .select('*, bicom_servers(name, server_url)').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.get('/tenants/:id/preview', async (req, res) => {
  const { data: sync } = await supabase.from('bicom_tenant_sync')
    .select('*, bicom_servers(server_url, api_key)').eq('id', req.params.id).single();
  if (!sync) return res.status(404).json({ error: 'Not found' });
  try {
    const client = new BiComClient((sync as any).bicom_servers.server_url, (sync as any).bicom_servers.api_key);
    const tid = sync.bicom_tenant_id;
    const [tenant, extensions, ringGroups, queues, ivrs, dids] = await Promise.all([
      client.getTenant(tid).catch(() => null),
      client.listExtensions(tid).catch(() => []),
      client.listRingGroups(tid).catch(() => []),
      client.listQueues(tid).catch(() => []),
      client.listIVRs(tid).catch(() => []),
      client.listDIDs(tid).catch(() => []),
    ]);
    res.json({
      tenant,
      counts: { extensions: extensions.length, ring_groups: ringGroups.length, queues: queues.length, ivrs: ivrs.length, dids: dids.length },
      extensions: extensions.map((e: any) => ({ id: e.id, extension: e.extension || e.exten, name: e.name, email: e.email })),
      ring_groups: ringGroups.map((r: any) => ({ id: r.id, name: r.name, extension: r.extension })),
      queues: queues.map((q: any) => ({ id: q.id, name: q.name })),
      ivrs: ivrs.map((i: any) => ({ id: i.id, name: i.name, extension: i.extension })),
      dids: dids.map((d: any) => ({ id: d.id, number: d.did || d.number, name: d.name })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/tenants/:id/migrate', async (req, res) => {
  const { dry_run = false } = req.body;
  const { data: sync } = await supabase.from('bicom_tenant_sync')
    .select('*, bicom_servers(server_url, api_key)').eq('id', req.params.id).single();
  if (!sync) return res.status(404).json({ error: 'Not found' });
  if (sync.status === 'in_progress') return res.status(409).json({ error: 'Migration already in progress' });

  const job = await migrationQueue.add('bicom-migration', {
    syncId: sync.id,
    serverUrl: (sync as any).bicom_servers.server_url,
    apiKey: (sync as any).bicom_servers.api_key,
    bicomTenantId: sync.bicom_tenant_id,
    dryRun: dry_run,
  });

  logger.info(`[BiCom] Queued migration for tenant ${sync.bicom_tenant_name} (job ${job.id})`);
  res.json({ ok: true, sync_id: sync.id, job_id: job.id, dry_run });
});

router.post('/tenants/:id/reset', async (req, res) => {
  await supabase.from('bicom_tenant_sync').update({ status: 'not_synced', last_error: null, sync_summary: {} }).eq('id', req.params.id);
  res.json({ ok: true });
});

export default router;
