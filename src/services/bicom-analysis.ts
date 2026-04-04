import axios from 'axios'
import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger'

async function bicomGet(serverUrl: string, apiKey: string, action: string, serverId = '1', extra: Record<string, string> = {}) {
  const params: Record<string, string> = { apikey: apiKey, action, server: serverId, ...extra }
  const r = await axios.get(`${serverUrl.replace(/\/$/, '')}/index.php`, { params, timeout: 15000 })
  if (r.data?.error) throw new Error(`BiCom (${action}): ${r.data.error}`)
  return r.data
}

function toArray(d: any): any[] {
  if (!d || d.error || typeof d !== 'object') return []
  if (Array.isArray(d)) return d
  return Object.entries(d).map(([id, v]: [string, any]) => ({ _id: id, ...v }))
}

const DUMMY_EMAIL_RE = /^a@[bc]\.com$|^noemail|^no@email|^dummy|^placeholder|^none@|@none\.|^test@|@test\.|@example\.|^info@|^admin@|^sales@|^reception@|^office@|^accounts@|^hello@|^contact@/i
function isDummy(email: string) { return DUMMY_EMAIL_RE.test(email.trim()) }

// ── Server health check ───────────────────────────────────────────────────────
export async function runServerHealthCheck(serverUrl: string, apiKey: string, serverId: string) {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const results: Record<string, any> = { checked_at: new Date().toISOString() }

  try {
    // 1. Basic connectivity - extensions online count
    const extOnline = await bicomGet(serverUrl, apiKey, 'pbxware.dashboard.ext_online')
    results.extensions_online = extOnline?.count || 0

    // 2. Services status
    const services = await bicomGet(serverUrl, apiKey, 'pbxware.dashboard.services')
    results.services = services
    results.all_services_running = Object.values(services || {}).every(v => v === 'running')

    // 3. Server resources
    const [cpu, memory] = await Promise.all([
      bicomGet(serverUrl, apiKey, 'pbxware.dashboard.cpu').catch(() => null),
      bicomGet(serverUrl, apiKey, 'pbxware.dashboard.memory').catch(() => null),
    ])
    results.cpu_usage = cpu?.inuse || null
    results.memory_usage = memory?.inuse || null

    // 4. Tenant count
    const tenants = await bicomGet(serverUrl, apiKey, 'pbxware.tenant.list')
    results.tenant_count = Object.keys(tenants || {}).length

    // 5. SIP registrations
    const sipRegs = await bicomGet(serverUrl, apiKey, 'pbxware.dashboard.sip_registrations').catch(() => null)
    results.sip_registrations = sipRegs || null

    // 6. Calls overview
    const calls = await bicomGet(serverUrl, apiKey, 'pbxware.dashboard.calls').catch(() => null)
    results.active_calls = calls || null

    results.status = 'healthy'
    results.error = null

    // Store in bicom_servers
    await sb.from('bicom_servers')
      .update({ health_check: results, health_checked_at: results.checked_at, health_status: 'healthy' })
      .eq('server_url', serverUrl)

    logger.info(`[Health] Server ${serverUrl} healthy — ${results.tenant_count} tenants, ${results.extensions_online} exts online`)
    return results

  } catch (e: any) {
    results.status = 'unreachable'
    results.error = e.message
    await sb.from('bicom_servers')
      .update({ health_check: results, health_checked_at: results.checked_at, health_status: 'unreachable' })
      .eq('server_url', serverUrl)
    logger.error(`[Health] Server ${serverUrl} unreachable: ${e.message}`)
    return results
  }
}

// ── Tenant pre-migration analysis ─────────────────────────────────────────────
export async function analyseTenant(
  tenantSyncId: string,
  serverUrl: string,
  apiKey: string,
  bicomTenantId: string
) {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  // Fetch everything in parallel
  const [rawExts, rawRings, rawIVRs, rawDIDs, tenantConf, tenantTrunks] = await Promise.all([
    bicomGet(serverUrl, apiKey, 'pbxware.ext.list', bicomTenantId),
    bicomGet(serverUrl, apiKey, 'pbxware.ring_group.list', bicomTenantId),
    bicomGet(serverUrl, apiKey, 'pbxware.ivr.list', bicomTenantId),
    bicomGet(serverUrl, apiKey, 'pbxware.did.list', bicomTenantId),
    bicomGet(serverUrl, apiKey, 'pbxware.tenant.configuration', '1', { id: bicomTenantId }).catch(() => null),
    bicomGet(serverUrl, apiKey, 'pbxware.tenant.trunks.list', '1', { tenant: bicomTenantId }).catch(() => null),
  ])

  const extensions = toArray(rawExts)
  const ringGroups = toArray(rawRings)
  const ivrs = toArray(rawIVRs)
  const dids = toArray(rawDIDs)

  // Email analysis
  const emailMap: Record<string, any[]> = {}
  const emailIssues: any[] = []

  for (const ext of extensions) {
    if (ext.status === '0' || ext.status === 'disabled') continue
    const email = (ext.email || '').trim().toLowerCase()
    if (!emailMap[email]) emailMap[email] = []
    emailMap[email].push({ ext: ext.ext, name: ext.name, bicom_id: ext._id })
  }

  for (const [email, exts] of Object.entries(emailMap)) {
    if (!email) {
      emailIssues.push({ type: 'missing', email: null, extensions: exts })
    } else if (isDummy(email)) {
      emailIssues.push({ type: 'dummy', email, extensions: exts })
    } else if (exts.length > 1) {
      emailIssues.push({ type: 'intra_tenant_duplicate', email, extensions: exts,
        note: 'Same real email on multiple extensions — will share one login' })
    }
  }

  // UAD breakdown — which phone models are in use
  const uadCounts: Record<string, number> = {}
  const macAddresses: Array<{ ext: string; name: string; model: string; mac: string }> = []

  for (const ext of extensions) {
    const model = ext.ua_name || ext.ua_fullname || 'Unknown'
    uadCounts[model] = (uadCounts[model] || 0) + 1
    if (ext.macaddress || ext.additional_macaddress) {
      macAddresses.push({
        ext: ext.ext, name: ext.name, model,
        mac: ext.macaddress || ext.additional_macaddress
      })
    }
  }

  // Channel capacity from tenant config
  const channelInfo = tenantConf ? {
    incoming_limit: tenantConf.incominglimit,
    outgoing_limit: tenantConf.outgoinglimit,
    concurrent_calls: tenantConf.conch,
    queue_channels: tenantConf.quech,
    erg_channels: tenantConf.ergch,
    emergency_email: tenantConf.es_notification_email,
    autoprovision_user: tenantConf.apusername,
    status: tenantConf.status,
    country: tenantConf.country,
  } : null

  const analysis = {
    analysed_at: new Date().toISOString(),
    summary: {
      extensions: extensions.filter(e => e.status !== '0').length,
      extensions_disabled: extensions.filter(e => e.status === '0').length,
      ring_groups: ringGroups.length,
      ivrs: ivrs.length,
      dids: dids.length,
      emails_real: Object.entries(emailMap).filter(([e]) => e && !isDummy(e)).length,
      emails_dummy: Object.entries(emailMap).filter(([e]) => isDummy(e)).length,
      emails_missing: Object.entries(emailMap).filter(([e]) => !e).length,
      invites_ready: Object.entries(emailMap).filter(([e]) => e && !isDummy(e) && emailMap[e].length === 1).length,
      needs_attention: emailIssues.length,
    },
    email_issues: emailIssues,
    uad_breakdown: uadCounts,
    phones_with_mac: macAddresses,
    channel_info: channelInfo,
    trunk_assignments: tenantTrunks ? {
      primary: tenantTrunks.primary_trunk,
      secondary: tenantTrunks.secondary_trunk,
      tertiary: tenantTrunks.tertiary_trunk,
      all: tenantTrunks.trunks,
    } : null,
    // Ready to migrate?
    migration_readiness: {
      can_auto_migrate: emailIssues.filter(i => i.type === 'dummy' || i.type === 'missing').length === 0,
      warnings: emailIssues.length,
      blockers: 0,
    }
  }

  await sb.from('bicom_tenant_sync')
    .update({ pre_migration_analysis: analysis, analysis_run_at: analysis.analysed_at })
    .eq('id', tenantSyncId)

  logger.info(`[Analysis] Tenant ${bicomTenantId}: ${analysis.summary.extensions} exts, ${analysis.email_issues.length} email issues`)
  return analysis
}
