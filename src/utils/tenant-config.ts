// SONIQ B2B Migration Worker — Tenant config + categorisation helpers
// Reads effective retention (tenant override -> licence -> default) from
// the public.tenant_effective_retention view in Supabase.
// Writes categorisation rows that soniqmail's Teams integration page reads.

import { supabase } from '../index';
import { logger } from './logger';
import type { LockMode } from './s3-archive';

export interface EffectiveRetention {
  retentionDays: number;
  lockMode: LockMode;
}

/**
 * Resolve effective Object Lock retention for a customer org.
 * Falls back to (90d, GOVERNANCE) if no licence found.
 */
export async function getEffectiveRetention(
  customerOrgId: string,
): Promise<EffectiveRetention> {
  const { data, error } = await supabase
    .from('tenant_effective_retention')
    .select('retention_days, lock_mode')
    .eq('customer_org_id', customerOrgId)
    .maybeSingle();

  if (error) {
    logger.warn(`Could not resolve retention for ${customerOrgId}, using defaults`, {
      error: error.message,
    });
    return { retentionDays: 90, lockMode: 'GOVERNANCE' };
  }

  if (!data) {
    return { retentionDays: 90, lockMode: 'GOVERNANCE' };
  }

  return {
    retentionDays: data.retention_days,
    lockMode: data.lock_mode as LockMode,
  };
}

// ─── User categorisation ───────────────────────────────────────────────────

interface GraphUser {
  id: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
  jobTitle?: string;
  department?: string;
  accountEnabled?: boolean;
  userType?: string;
}

export interface CategorisedUsers {
  members: GraphUser[];
  guests: GraphUser[];
  disabled: GraphUser[];
  sharedMailboxes: GraphUser[];
  rooms: GraphUser[];
  equipment: GraphUser[];
}

/**
 * Best-effort first-pass split. Definitive shared/room/equipment detection
 * needs Exchange Online recipientTypeDetails; this gets us a usable preview
 * within Graph-only application permissions.
 */
export function categoriseUsers(users: GraphUser[]): CategorisedUsers {
  const out: CategorisedUsers = {
    members: [],
    guests: [],
    disabled: [],
    sharedMailboxes: [],
    rooms: [],
    equipment: [],
  };

  for (const u of users) {
    if (u.userType === 'Guest') { out.guests.push(u); continue; }
    if (u.accountEnabled === false) { out.disabled.push(u); continue; }
    const upn = (u.userPrincipalName || '').toLowerCase();
    const local = upn.split('@')[0] || '';
    if (local.startsWith('room-') || local.startsWith('rm-') || local.includes('-room')) {
      out.rooms.push(u); continue;
    }
    if (local.startsWith('equip-') || local.startsWith('equ-') || local.includes('-equip')) {
      out.equipment.push(u); continue;
    }
    out.members.push(u);
  }
  return out;
}

// ─── Persist categorised resources (best-effort, never breaks discovery) ──

export async function upsertSharedMailboxes(
  customerOrgId: string,
  msTenantId: string,
  users: GraphUser[],
): Promise<void> {
  if (users.length === 0) return;

  const rows = users.map((u) => ({
    customer_org_id: customerOrgId,
    tenant_id: msTenantId,
    ms_user_id: u.id,
    display_name: u.displayName || u.mail || u.userPrincipalName,
    email: u.mail || u.userPrincipalName,
    is_monitored: false,
    last_sync_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('tenant_shared_mailboxes')
    .upsert(rows, { onConflict: 'customer_org_id,ms_user_id', ignoreDuplicates: false });

  if (error) {
    logger.warn(`upsertSharedMailboxes failed for ${customerOrgId}`, { error: error.message });
  } else {
    logger.info(`📥 Upserted ${rows.length} shared mailboxes for ${customerOrgId}`);
  }
}

export async function upsertSharedCalendars(
  customerOrgId: string,
  msTenantId: string,
  rooms: GraphUser[],
  equipment: GraphUser[],
): Promise<void> {
  const rows = [
    ...rooms.map((u) => ({
      customer_org_id: customerOrgId,
      tenant_id: msTenantId,
      ms_resource_id: u.id,
      display_name: u.displayName,
      email: u.mail || u.userPrincipalName,
      resource_type: 'room',
      is_visible: true,
      last_sync_at: new Date().toISOString(),
    })),
    ...equipment.map((u) => ({
      customer_org_id: customerOrgId,
      tenant_id: msTenantId,
      ms_resource_id: u.id,
      display_name: u.displayName,
      email: u.mail || u.userPrincipalName,
      resource_type: 'equipment',
      is_visible: true,
      last_sync_at: new Date().toISOString(),
    })),
  ];

  if (rows.length === 0) return;

  const { error } = await supabase
    .from('tenant_shared_calendars')
    .upsert(rows, { onConflict: 'customer_org_id,ms_resource_id', ignoreDuplicates: false });

  if (error) {
    logger.warn(`upsertSharedCalendars failed for ${customerOrgId}`, { error: error.message });
  } else {
    logger.info(`📥 Upserted ${rows.length} shared calendars for ${customerOrgId}`);
  }
}

interface GraphGroup {
  id: string;
  displayName?: string;
  description?: string;
  mailEnabled?: boolean;
  securityEnabled?: boolean;
  groupTypes?: string[];
  mail?: string;
  visibility?: string;
}

export async function upsertGroups(
  customerOrgId: string,
  msTenantId: string,
  groups: GraphGroup[],
): Promise<void> {
  if (groups.length === 0) return;

  const rows = groups.map((g) => ({
    customer_org_id: customerOrgId,
    tenant_id: msTenantId,
    ms_group_id: g.id,
    display_name: g.displayName,
    email: g.mail,
    description: g.description,
    group_type: classifyGroup(g),
    visibility: g.visibility,
    last_sync_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('tenant_groups')
    .upsert(rows, { onConflict: 'customer_org_id,ms_group_id', ignoreDuplicates: false });

  if (error) {
    logger.warn(`upsertGroups failed for ${customerOrgId}`, { error: error.message });
  } else {
    logger.info(`📥 Upserted ${rows.length} groups for ${customerOrgId}`);
  }
}

function classifyGroup(g: GraphGroup): string {
  if (g.groupTypes?.includes('Unified')) return 'm365';
  if (g.mailEnabled && g.securityEnabled) return 'mail_enabled_security';
  if (g.mailEnabled) return 'distribution';
  if (g.securityEnabled) return 'security';
  return 'unknown';
}
