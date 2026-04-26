import { Job } from 'bull';
import { Client } from '@microsoft/microsoft-graph-client';
import { supabase, migrationQueue } from '../index';
import { logger } from '../utils/logger';
import {
  categoriseUsers,
  upsertSharedMailboxes,
  upsertSharedCalendars,
  upsertGroups,
} from '../utils/tenant-config';

export type SyncMode = 'directory_only' | 'full';

interface DiscoveryJobData {
  migrationJobId: string;
  orgId: string;                                    // SONIQ customer_org_id
  accessToken: string;
  provider: 'microsoft365' | 'google_workspace';
  syncMode?: SyncMode;                              // default: 'directory_only'
  msTenantId?: string;                              // for categorisation rows
  tenantSyncJobId?: string;                         // soniqmail-side companion row
}

/**
 * Discovery: pull org info, all users, all groups from Microsoft Graph,
 * categorise (members/guests/disabled/rooms/equipment), and either:
 *   - sync_mode='directory_only': stop here, soniqmail uses categorised data
 *   - sync_mode='full': also queue per-user mail+calendar back-sync jobs
 */
export async function discoveryProcessor(job: Job<DiscoveryJobData>) {
  const {
    migrationJobId,
    orgId,
    accessToken,
    provider,
    syncMode = 'directory_only',
    msTenantId,
    tenantSyncJobId,
  } = job.data;

  logger.info(`🔍 Discovery start: migration=${migrationJobId} org=${orgId} mode=${syncMode}`);

  try {
    const client = Client.init({ authProvider: (done) => done(null, accessToken) });

    await supabase
      .from('migration_jobs')
      .update({ phase: 'discovery', status: 'running' })
      .eq('id', migrationJobId);

    // ── 1. Org info ────────────────────────────────────────────────────────
    job.progress(5);
    let resolvedTenantId = msTenantId || '';
    try {
      const org = await client.api('/organization').get();
      const orgInfo = org.value?.[0];
      resolvedTenantId = orgInfo?.id || resolvedTenantId;
      logger.info(`Org: ${orgInfo?.displayName} (tenant ${resolvedTenantId})`);
    } catch (err) {
      logger.warn('Could not read /organization, falling back to passed tenantId', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── 2. Users (paginated) ───────────────────────────────────────────────
    job.progress(15);
    const allUsers: any[] = [];
    let nextLink: string | null =
      '/users?$select=id,displayName,mail,userPrincipalName,jobTitle,department,accountEnabled,userType';

    while (nextLink) {
      const response: any = await client.api(nextLink).get();
      allUsers.push(...(response.value || []));
      nextLink = response['@odata.nextLink'] || null;
      if (allUsers.length % 200 === 0) logger.info(`  fetched ${allUsers.length} users…`);
    }
    logger.info(`✅ Discovered ${allUsers.length} users`);
    job.progress(35);

    // ── 3. Groups (paginated) ──────────────────────────────────────────────
    const allGroups: any[] = [];
    try {
      let groupNext: string | null =
        '/groups?$select=id,displayName,description,mailEnabled,securityEnabled,groupTypes,mail,visibility';
      while (groupNext) {
        const response: any = await client.api(groupNext).get();
        allGroups.push(...(response.value || []));
        groupNext = response['@odata.nextLink'] || null;
      }
      logger.info(`✅ Discovered ${allGroups.length} groups`);
    } catch (err) {
      logger.warn('Group discovery failed (likely missing Group.Read.All)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    job.progress(50);

    // ── 4. Categorise + persist ────────────────────────────────────────────
    const categorised = categoriseUsers(allUsers);
    logger.info('Categorisation', {
      members: categorised.members.length,
      guests: categorised.guests.length,
      disabled: categorised.disabled.length,
      rooms: categorised.rooms.length,
      equipment: categorised.equipment.length,
    });

    if (resolvedTenantId) {
      await upsertSharedMailboxes(orgId, resolvedTenantId, categorised.sharedMailboxes);
      await upsertSharedCalendars(orgId, resolvedTenantId, categorised.rooms, categorised.equipment);
      await upsertGroups(orgId, resolvedTenantId, allGroups);
    }
    job.progress(70);

    // ── 5. Update tenant_sync_jobs companion row (if present) ──────────────
    if (tenantSyncJobId) {
      await supabase
        .from('tenant_sync_jobs')
        .update({
          status: 'running',
          started_at: new Date().toISOString(),
          total_items: allUsers.length,
          preview_data: {
            counts: {
              members: categorised.members.length,
              guests: categorised.guests.length,
              disabled: categorised.disabled.length,
              shared_mailboxes: categorised.sharedMailboxes.length,
              rooms: categorised.rooms.length,
              equipment: categorised.equipment.length,
              groups: allGroups.length,
            },
          },
        })
        .eq('id', tenantSyncJobId);
    }

    // ── 6. Update migration_jobs aggregate stats ───────────────────────────
    await supabase
      .from('migration_jobs')
      .update({
        users_count: allUsers.length,
        mailboxes_count: categorised.members.length + categorised.sharedMailboxes.length,
        phase: syncMode === 'directory_only' ? 'completed' : 'staging',
        status: syncMode === 'directory_only' ? 'completed' : 'pending',
        completed_at: syncMode === 'directory_only' ? new Date().toISOString() : null,
      })
      .eq('id', migrationJobId);

    if (syncMode === 'directory_only') {
      // Mark the soniqmail companion row complete too
      if (tenantSyncJobId) {
        await supabase
          .from('tenant_sync_jobs')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            processed_items: allUsers.length,
            created_count: allUsers.length,
          })
          .eq('id', tenantSyncJobId);
      }
      job.progress(100);
      logger.info(`✅ Discovery complete (directory_only): ${allUsers.length} users`);
      return {
        usersCount: allUsers.length,
        groupsCount: allGroups.length,
        syncMode,
        usersQueued: 0,
      };
    }

    // ── 7. FULL mode only: create user_sync_state rows + queue mail-sync ───
    job.progress(80);
    const memberRows = categorised.members.map((u) => ({
      migration_job_id: migrationJobId,
      user_email: u.mail || u.userPrincipalName,
      provider_user_id: u.id,
      status: 'pending',
    }));

    if (memberRows.length > 0) {
      const { data: createdStates, error: statesError } = await supabase
        .from('user_sync_state')
        .insert(memberRows)
        .select();

      if (statesError) throw new Error(`user_sync_state insert failed: ${statesError.message}`);

      job.progress(90);
      for (const state of createdStates || []) {
        await migrationQueue.add(
          'mail-sync',
          {
            userSyncStateId: state.id,
            userId: state.provider_user_id,
            migrationJobId,
            orgId,
            accessToken,
          },
          { delay: 1000 },
        );
      }
      logger.info(`📨 Queued ${createdStates?.length || 0} mail-sync jobs`);
    }

    job.progress(100);
    return {
      usersCount: allUsers.length,
      groupsCount: allGroups.length,
      syncMode,
      usersQueued: memberRows.length,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Discovery failed for ${migrationJobId}`, { error: msg });

    await supabase
      .from('migration_jobs')
      .update({ status: 'failed', error_message: msg })
      .eq('id', migrationJobId);

    if (tenantSyncJobId) {
      await supabase
        .from('tenant_sync_jobs')
        .update({ status: 'failed', error_message: msg })
        .eq('id', tenantSyncJobId);
    }
    throw error;
  }
}
