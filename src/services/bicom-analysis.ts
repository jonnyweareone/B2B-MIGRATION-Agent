import axios from 'axios'
import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger'

const DUMMY_EMAIL_RE = /^a@[bc]\.com$|^noemail|^no@email|^dummy|^placeholder|^none@|@none\.|^test@|@test\.|@example\.|^info@|^admin@|^sales@|^reception@|^office@|^accounts@|^hello@|^contact@/i
function isDummy(email: string) { return DUMMY_EMAIL_RE.test(email.trim()) }

function e164(raw: string): string {
  const d = raw.replace(/\D/g, '')
  if (d.startsWith('44') && d.length >= 12) return `+${d}`
  if (d.startsWith('0') && d.length === 11) return `+44${d.slice(1)}`
  return raw
}

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

// Parse BLF config -- BiCom returns parallel arrays: exts[], labels[], functions[]
// NOT a blfs[] object of {ext,label} pairs
function parseBlfKeys(blfConf: any): Array<{extension: string; label: string; type: string; blf_enabled: boolean}> {
  if (!blfConf) return []
  const exts: string[] = blfConf.exts || []
  const labels: string[] = blfConf.labels || []
  const fns: string[] = blfConf.functions || []
  const blfs: number[] = blfConf.blfs || []
  return exts.map((ext: string, i: number) => ({
    extension: ext,
    label: labels[i] || ext,
    type: fns[i] === '1' ? 'speed_dial' : 'presence',
    blf_enabled: blfs[i] === 1,
  }))
}

// Parse ES states response -- services that are 'yes' are enabled
function parseEsStates(esStates: any): Record<string, boolean> {
  if (!esStates || esStates.error) return {}
  const result: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(esStates)) {
    result[k] = v === 'yes' || v === true
  }
  return result
}

// ── Server health check ───────────────────────────────────────────────────────
export async function runServerHealthCheck(serverUrl: string, apiKey: string) {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const results: Record<string, any> = { checked_at: new Date().toISOString() }
  try {
    const [extOnline, services, cpu, memory, tenants, sipRegs, calls] = await Promise.all([
      bicomGet(serverUrl, apiKey, 'pbxware.dashboard.ext_online'),
      bicomGet(serverUrl, apiKey, 'pbxware.dashboard.services'),
      bicomGet(serverUrl, apiKey, 'pbxware.dashboard.cpu').catch(() => null),
      bicomGet(serverUrl, apiKey, 'pbxware.dashboard.memory').catch(() => null),
      bicomGet(serverUrl, apiKey, 'pbxware.tenant.list'),
      bicomGet(serverUrl, apiKey, 'pbxware.dashboard.sip_registrations').catch(() => null),
      bicomGet(serverUrl, apiKey, 'pbxware.dashboard.calls').catch(() => null),
    ])
    results.extensions_online = extOnline?.count || 0
    results.services = services
    results.all_services_running = Object.values(services || {}).every(v => v === 'running')
    results.cpu_usage = cpu?.inuse || null
    results.memory_usage = memory?.inuse || null
    results.tenant_count = Object.keys(tenants || {}).length
    results.sip_registrations = sipRegs || null
    results.active_calls = calls || null
    results.status = 'healthy'; results.error = null
    await sb.from('bicom_servers')
      .update({ health_check: results, health_checked_at: results.checked_at, health_status: 'healthy' })
      .eq('server_url', serverUrl)
    logger.info(`[Health] ${serverUrl} healthy -- ${results.tenant_count} tenants`)
    return results
  } catch (e: any) {
    results.status = 'unreachable'; results.error = e.message
    await sb.from('bicom_servers')
      .update({ health_check: results, health_checked_at: results.checked_at, health_status: 'unreachable' })
      .eq('server_url', serverUrl)
    return results
  }
}

// ── Edit extension in BiCom ───────────────────────────────────────────────────
export async function editBicomExtension(serverUrl: string, apiKey: string, tenantId: string, bicomExtId: string, fields: Record<string, string>) {
  const result = await bicomGet(serverUrl, apiKey, 'pbxware.ext.edit', tenantId, { id: bicomExtId, ...fields })
  if (!result.success) throw new Error(`Edit failed: ${JSON.stringify(result)}`)
  logger.info(`[BiCom] Edited ext ${bicomExtId}: ${JSON.stringify(fields)}`)
  return result
}

// ── Edit DID in BiCom ─────────────────────────────────────────────────────────
export async function editBicomDid(serverUrl: string, apiKey: string, tenantId: string, bicomDidId: string, fields: Record<string, string>) {
  const result = await bicomGet(serverUrl, apiKey, 'pbxware.did.edit', tenantId, { id: bicomDidId, ...fields })
  if (!result.success) throw new Error(`DID edit failed: ${JSON.stringify(result)}`)
  logger.info(`[BiCom] Edited DID ${bicomDidId}: ${JSON.stringify(fields)}`)
  return result
}

// ES services available on this system (skip ones that require optional modules)
const ES_SERVICES = 'callfwd,callerid,followme,callfilters,dnd,callscreening,blflist,speeddial,callpickup,lastcaller,delrecordings,listenrecordings,remoteaccess,callmonitoring,extoperationtimes,operationtimes,smsnotifications'

// ── Deep extension detail: config + BLF + caller IDs + call fwd + ES states ──
async function getExtDetail(serverUrl: string, apiKey: string, tenantId: string, extId: string) {
  const [conf, clidConf, blfConf, cfwdConf, esStates] = await Promise.all([
    bicomGet(serverUrl, apiKey, 'pbxware.ext.configuration', tenantId, { id: extId })
      .then(d => Object.values(d)[0] as any).catch(() => null),
    bicomGet(serverUrl, apiKey, 'pbxware.ext.es.callerid.configuration', tenantId, { id: extId }).catch(() => null),
    bicomGet(serverUrl, apiKey, 'pbxware.ext.es.blflist.configuration', tenantId, { id: extId }).catch(() => null),
    bicomGet(serverUrl, apiKey, 'pbxware.ext.es.callfwd.configuration', tenantId, { id: extId }).catch(() => null),
    bicomGet(serverUrl, apiKey, 'pbxware.ext.es.states.get', tenantId, { id: extId, services: ES_SERVICES }).catch(() => null),
  ])
  const opts = conf?.options || {}

  // BLF: parallel arrays exts[]/labels[]/functions[] -- NOT a blfs object
  const blf_keys = parseBlfKeys(blfConf)

  // ES states: which enhanced services are enabled for this extension
  const es_enabled = parseEsStates(esStates)

  return {
    mac: opts.mac || conf?.macaddress || null,
    sn: opts.sn || null,
    additional_macs: conf?.additional_macaddress
      ? Object.values(conf.additional_macaddress as Record<string, string>)
      : [],
    autoprov: opts.autoprovisiong === '1',
    dhcp: opts.dhcp === '1',
    sip_username: opts.username || null,
    ring_timeout: parseInt(opts.ringtime || '30'),
    incoming_limit: parseInt(opts.incominglimit || '3'),
    outgoing_limit: parseInt(opts.outgoinglimit || '3'),
    voicemail: opts.voicemail === '1' || opts.voicemail === 1,
    timezone: opts.ext_timezone || 'Europe/London',
    codec_allow: opts.allow || ['ulaw', 'alaw'],
    caller_id: {
      default: clidConf?.default_callerid || null,
      allowed: Object.values(clidConf?.allowed_callerids || {}).map((c: any) => ({
        number: c.callerid, label: c.label, short_code: c.short_code || null,
      })),
      per_trunk: Object.entries(clidConf || {})
        .filter(([k]) => k.startsWith('callerid:') && !k.endsWith(':privacy'))
        .reduce((acc: any, [k, v]) => { acc[k.replace('callerid:', '')] = v; return acc }, {}),
    },
    blf_keys,  // Fixed: now correctly parsed from parallel arrays
    call_forward: cfwdConf ? {
      enabled: cfwdConf.enabled || [],
      destination: cfwdConf.destinations || null,
      timeout: cfwdConf.timeouts || null,
    } : null,
    es_enabled, // All enabled enhanced services
  }
}

// ── Full tenant analysis ──────────────────────────────────────────────────────
export async function analyseTenant(tenantSyncId: string, serverUrl: string, apiKey: string, bicomTenantId: string) {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  // Fetch everything in parallel
  const [rawExts, rawRings, rawIVRs, rawDIDs, tenantConf, tenantTrunks, allTrunks, monitorData] = await Promise.all([
    bicomGet(serverUrl, apiKey, 'pbxware.ext.list', bicomTenantId),
    bicomGet(serverUrl, apiKey, 'pbxware.ring_group.list', bicomTenantId),
    bicomGet(serverUrl, apiKey, 'pbxware.ivr.list', bicomTenantId),
    bicomGet(serverUrl, apiKey, 'pbxware.did.list', bicomTenantId),
    bicomGet(serverUrl, apiKey, 'pbxware.tenant.configuration', '1', { id: bicomTenantId }).catch(() => null),
    bicomGet(serverUrl, apiKey, 'pbxware.tenant.trunks.list', '1', { tenant: bicomTenantId }).catch(() => null),
    bicomGet(serverUrl, apiKey, 'pbxware.trunk.list', '1').catch(() => ({})),
    bicomGet(serverUrl, apiKey, 'pbxware.monitor.list', bicomTenantId).catch(() => ({})),
  ])

  const extensions = toArray(rawExts).filter(e => e.status !== '0' && e.status !== 'disabled')
  const ringGroups = toArray(rawRings)
  const ivrs = toArray(rawIVRs)
  const dids = toArray(rawDIDs)

  // Trunk carrier map
  const trunkMap: Record<string, string> = {}
  const trunkCarrierMap: Record<string, string> = {}
  for (const [tid, t] of Object.entries(allTrunks as Record<string, any>)) {
    trunkMap[tid] = t.name
    const name = (t.name || '').toLowerCase()
    trunkCarrierMap[tid] = name.includes('gamma') || name.includes('onecom') ? 'onehub'
      : name.includes('twilio') ? 'twilio'
      : name.includes('voiceflex') ? 'voiceflex' : 'other'
  }

  // Monitor data: live status, DND, IP, UA string
  const monitorMap: Record<string, any> = {}
  for (const [eid, mon] of Object.entries(monitorData as Record<string, any>)) {
    monitorMap[eid] = mon
  }

  // Deep fetch per extension (BLF, caller IDs, ES states, device info)
  const extDetails: Record<string, any> = {}
  await Promise.all(extensions.map(async ext => {
    extDetails[ext._id] = await getExtDetail(serverUrl, apiKey, bicomTenantId, ext._id).catch(() => ({}))
  }))

  // Operation times per IVR and ring group
  const ivrOtimes: Record<string, any> = {}
  const rgOtimes: Record<string, any> = {}
  await Promise.all([
    ...ivrs.map(async ivr => {
      const ot = await bicomGet(serverUrl, apiKey, 'pbxware.otimes.ivr.list', bicomTenantId, { id: ivr._id }).catch(() => null)
      if (ot && !Array.isArray(ot)) ivrOtimes[ivr._id] = ot[ivr._id] || Object.values(ot)[0]
    }),
    ...ringGroups.map(async rg => {
      const ot = await bicomGet(serverUrl, apiKey, 'pbxware.otimes.dial_group.list', bicomTenantId, { id: rg._id }).catch(() => null)
      if (ot && !Array.isArray(ot)) rgOtimes[rg._id] = ot[rg._id] || Object.values(ot)[0]
    }),
  ])

  // Ring group configs
  const rgConfigs: Record<string, any> = {}
  await Promise.all(ringGroups.map(async rg => {
    const c = await bicomGet(serverUrl, apiKey, 'pbxware.ring_group.configuration', bicomTenantId, { id: rg._id }).catch(() => null)
    if (c) rgConfigs[rg._id] = (Object.values(c)[0] as any)?.options || {}
  }))

  // Email analysis
  const emailMap: Record<string, any[]> = {}
  const emailIssues: any[] = []

  // Build users with all detail
  const users = extensions.map(ext => {
    const email = (ext.email || '').trim().toLowerCase()
    if (!emailMap[email]) emailMap[email] = []
    emailMap[email].push({ ext: ext.ext, name: ext.name, bicom_id: ext._id })
    const detail = extDetails[ext._id] || {}
    const monitor = monitorMap[ext._id] || {}
    return {
      bicom_id: ext._id, name: ext.name, ext: ext.ext,
      email: email || null, email_is_dummy: isDummy(email),
      phone_model: ext.ua_name || null, phone_model_full: ext.ua_fullname || null,
      // Device from config (autoprov stored SN/MAC)
      mac: detail.mac || null, sn: detail.sn || null,
      additional_macs: detail.additional_macs || [],
      autoprov: detail.autoprov || false, dhcp: detail.dhcp !== false,
      sip_username: detail.sip_username || null,
      ring_timeout: detail.ring_timeout || 30,
      incoming_limit: detail.incoming_limit || 3,
      outgoing_limit: detail.outgoing_limit || 3,
      voicemail: detail.voicemail || false,
      timezone: detail.timezone || 'Europe/London',
      codec_allow: detail.codec_allow || [],
      caller_id: detail.caller_id || null,
      blf_keys: detail.blf_keys || [],  // Now correctly parsed
      call_forward: detail.call_forward || null,
      es_enabled: detail.es_enabled || {},  // All enhanced service states
      // Live monitor data
      live_status: monitor.status || 'unknown',
      live_ip: monitor.ip || null,
      live_ua: monitor.ua || null,
      live_dnd: !!monitor.dnd,
      live_on_call: !!monitor.on_call,
    }
  })

  for (const [email, exts] of Object.entries(emailMap)) {
    if (!email) emailIssues.push({ type: 'missing', email: null, extensions: exts })
    else if (isDummy(email)) emailIssues.push({ type: 'dummy', email, extensions: exts })
    else if (exts.length > 1) emailIssues.push({ type: 'intra_tenant_duplicate', email, extensions: exts, note: 'Shared login -- multiple handsets' })
  }

  const devices = users.map(u => ({
    bicom_id: u.bicom_id, ext: u.ext, name: u.name,
    model: u.phone_model_full || u.phone_model || 'Unknown',
    mac: u.mac, sn: u.sn, additional_macs: u.additional_macs,
    autoprov: u.autoprov, dhcp: u.dhcp,
    live_status: u.live_status, live_ip: u.live_ip, live_ua: u.live_ua,
  }))

  // DIDs with E.164 and carrier info
  const didList = dids.map(did => ({
    bicom_id: did._id, number: e164(did.number || ''), number_raw: did.number,
    label: did.name || null, type: did.type || 'Unknown',
    destination_ext: did.ext || null,
    trunk_id: did.trunk || null, trunk_name: trunkMap[did.trunk] || did.trunk || null,
    actual_carrier: trunkCarrierMap[did.trunk] || 'other',
    status: did.status || 'enabled',
  }))

  // IVRs with greeting file names
  const ivrList = ivrs.map(ivr => {
    const ot = ivrOtimes[ivr._id]
    return {
      bicom_id: ivr._id, name: ivr.name, ext: ivr.ext, type: 'ivr' as const,
      key_count: ivr.keymap ? Object.keys(ivr.keymap).length : 0,
      is_active: ivr.status !== 'disabled', operator: ivr.operator || null,
      greeting: ivr.greeting || null,  // Greeting file name
      keymap: ivr.keymap || {},
      has_schedule: !!(ot && ot.status === 'on'),
      schedule_closed_dates: ot?.closed_dates?.length || 0,
      schedule_closed_dest: ot?.default_dest_ext || null,
    }
  })

  // Ring groups
  const ringGroupList = ringGroups.map(rg => {
    const conf = rgConfigs[rg._id] || {}
    const ot = rgOtimes[rg._id]
    const memberExts = (rg.destinations || '').split(',').map((e: string) => e.trim()).filter(Boolean)
    return {
      bicom_id: rg._id, name: rg.name, ext: rg.ext, type: 'ring_group' as const,
      ring_strategy: conf.ring_strategy || 'all', timeout: parseInt(conf.timeout || '30'),
      members: memberExts, member_count: memberExts.length,
      overflow_ext: conf.last_dest || null, callerid_override: conf.callerid || null,
      record_calls: conf.record === '1',
      greeting: conf.greeting || null,  // Ring group greeting if any
      has_schedule: !!(ot && ot.status === 'on'),
      schedule_closed_dates: ot?.closed_dates?.length || 0,
      schedule_closed_dest: ot?.default_dest_ext || null,
    }
  })

  // Directory = extensions list (BiCom has no separate phonebook API)
  const directory = users.map(u => ({
    ext: u.ext, name: u.name, email: u.email,
    phone_model: u.phone_model_full || u.phone_model,
    caller_id_number: u.caller_id?.default || null,
    live_status: u.live_status,
  }))

  const uadCounts: Record<string, number> = {}
  for (const u of users) {
    const m = u.phone_model_full || u.phone_model || 'Unknown'
    uadCounts[m] = (uadCounts[m] || 0) + 1
  }

  const analysis = {
    analysed_at: new Date().toISOString(),
    summary: {
      extensions: users.length, ring_groups: ringGroups.length,
      ivrs: ivrs.length, dids: dids.length,
      emails_real: Object.entries(emailMap).filter(([e]) => e && !isDummy(e)).length,
      emails_dummy: Object.entries(emailMap).filter(([e]) => isDummy(e)).length,
      emails_missing: Object.entries(emailMap).filter(([e]) => !e).length,
      invites_ready: Object.entries(emailMap).filter(([e]) => e && !isDummy(e) && emailMap[e].length === 1).length,
      needs_attention: emailIssues.length,
      devices_with_sn: users.filter(u => u.sn).length,
      devices_with_mac: users.filter(u => u.mac).length,
      extensions_online: users.filter(u => u.live_status === 'online').length,
    },
    email_issues: emailIssues, uad_breakdown: uadCounts,
    users, devices, dids: didList, ring_groups: ringGroupList, ivrs: ivrList, directory,
    channel_info: tenantConf ? {
      incoming_limit: tenantConf.incominglimit, outgoing_limit: tenantConf.outgoinglimit,
      concurrent_calls: tenantConf.conch, queue_channels: tenantConf.quech,
      emergency_email: tenantConf.es_notification_email, autoprovision_user: tenantConf.apusername,
      status: tenantConf.status,
    } : null,
    trunk_assignments: tenantTrunks ? {
      primary: tenantTrunks.primary_trunk, secondary: tenantTrunks.secondary_trunk,
      tertiary: tenantTrunks.tertiary_trunk, all: tenantTrunks.trunks,
    } : null,
    migration_readiness: {
      can_auto_migrate: emailIssues.filter((i: any) => i.type === 'dummy' || i.type === 'missing').length === 0,
      warnings: emailIssues.length, blockers: 0,
    },
  }

  await sb.from('bicom_tenant_sync')
    .update({ pre_migration_analysis: analysis, analysis_run_at: analysis.analysed_at })
    .eq('id', tenantSyncId)

  logger.info(`[Analysis] Tenant ${bicomTenantId}: ${users.length} users, ${users.filter(u => u.blf_keys.length > 0).length} with BLF keys, ${users.filter(u => u.sn).length} SNs`)
  return analysis
}
