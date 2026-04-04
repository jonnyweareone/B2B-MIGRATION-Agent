import axios from 'axios'
import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger'
import { fetchOtimes, wrapWithSchedule } from './bicom-schedules'

async function bicomGet(serverUrl: string, apiKey: string, action: string, serverId?: string, extra: Record<string, string> = {}) {
  const params: Record<string, string> = { apikey: apiKey, action, ...extra }
  if (serverId) params.server = serverId
  const r = await axios.get(`${serverUrl.replace(/\/$/, '')}/index.php`, { params, timeout: 30000 })
  if (r.data?.error) throw new Error(`BiCom API (${action}): ${r.data.error}`)
  return r.data
}

function toArray(d: any): any[] {
  if (!d || d.error || typeof d !== 'object') return []
  if (Array.isArray(d)) return d
  return Object.entries(d).map(([id, v]: [string, any]) => ({ _id: id, ...v }))
}

function e164(raw: string): string {
  const d = raw.replace(/\D/g, '')
  if (d.startsWith('44') && d.length >= 12) return `+${d}`
  if (d.startsWith('0') && d.length === 11) return `+44${d.slice(1)}`
  if (d.length === 10 && d.startsWith('7')) return `+44${d}`
  return d.startsWith('+') ? raw : `+${d}`
}

export interface MigrationParams {
  tenant_sync_id: string; server_url: string; api_key: string
  bicom_tenant_id: string; target_org_id: string; dry_run?: boolean
}

interface MigrationResult {
  status: 'synced' | 'partial' | 'error'
  extensionsSynced: number; ringsSynced: number; ivrsSynced: number; didsSynced: number
  pendingInvites: Array<{ email: string; display_name: string; org_user_id: string }>
}

export async function migrateBicomTenant(params: MigrationParams): Promise<MigrationResult> {
  const { tenant_sync_id, server_url, api_key, bicom_tenant_id, target_org_id, dry_run = false } = params
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  async function updateSync(status: string, error?: string, extra?: Record<string, any>) {
    await sb.from('bicom_tenant_sync').update({
      status, last_error: error || null,
      last_sync_at: new Date().toISOString(), ...extra,
    }).eq('id', tenant_sync_id)
  }

  try {
    logger.info(`[BiCom] Starting migration — tenant ${bicom_tenant_id} → org ${target_org_id}`)
    if (!dry_run) await updateSync('in_progress')

    // ── Step 1: Fetch all BiCom data ─────────────────────────────────────────
    const [rawExts, rawRings, rawIVRs, rawDIDs] = await Promise.all([
      bicomGet(server_url, api_key, 'pbxware.ext.list', bicom_tenant_id),
      bicomGet(server_url, api_key, 'pbxware.ring_group.list', bicom_tenant_id),
      bicomGet(server_url, api_key, 'pbxware.ivr.list', bicom_tenant_id),
      bicomGet(server_url, api_key, 'pbxware.did.list', bicom_tenant_id),
    ])
    const extensions = toArray(rawExts)
    const ringGroups = toArray(rawRings)
    const ivrs       = toArray(rawIVRs)
    const dids       = toArray(rawDIDs)
    logger.info(`[BiCom] ${extensions.length} exts, ${ringGroups.length} rings, ${ivrs.length} IVRs, ${dids.length} DIDs`)

    if (!dry_run) await updateSync('in_progress', undefined, {
      extensions_count: extensions.length, ring_groups_count: ringGroups.length,
      ivrs_count: ivrs.length, dids_count: dids.length,
    })
    if (dry_run) return { status: 'synced', extensionsSynced: 0, ringsSynced: 0, ivrsSynced: 0, didsSynced: 0, pendingInvites: [] }

    // ── Step 2: Extensions → org_users ───────────────────────────────────────
    const extToOrgUserId: Record<string, string> = {}
    const pendingInvites: Array<{ email: string; display_name: string; org_user_id: string }> = []
    let extensionsSynced = 0

    for (const ext of extensions) {
      if (!ext.email) { logger.warn(`[BiCom] Ext ${ext.ext} no email — skip`); continue }
      if (ext.status === '0' || ext.status === 'disabled') continue
      try {
        // Fetch full config, caller IDs, BLF keys, call forward — in parallel
        const [fullConf, clidConf, blfConf, cfwdConf] = await Promise.all([
          bicomGet(server_url, api_key, 'pbxware.ext.configuration', bicom_tenant_id, { id: ext._id })
            .then(d => Object.values(d)[0] as any).catch(() => null),
          bicomGet(server_url, api_key, 'pbxware.ext.es.callerid.configuration', bicom_tenant_id, { id: ext._id }).catch(() => null),
          bicomGet(server_url, api_key, 'pbxware.ext.es.blflist.configuration', bicom_tenant_id, { id: ext._id }).catch(() => null),
          bicomGet(server_url, api_key, 'pbxware.ext.es.callfwd.configuration', bicom_tenant_id, { id: ext._id }).catch(() => null),
        ])
        const opts = fullConf?.options || {}

        const callerIdSettings = clidConf ? {
          default_number: clidConf.default_callerid || clidConf.callerid || null,
          allowed_numbers: Object.values(clidConf.allowed_callerids || {}).map((c: any) => ({
            number: c.callerid, label: c.label, short_code: c.short_code || null,
          })),
          per_trunk: Object.entries(clidConf)
            .filter(([k]) => k.startsWith('callerid:') && !k.endsWith(':privacy'))
            .reduce((acc: any, [k, v]) => { acc[k.replace('callerid:', '')] = v; return acc }, {}),
        } : null

        const blfKeys = (blfConf?.blfs || []).map((b: any) => ({
          extension: b.ext || b.extension, label: b.name || b.label || b.ext, type: b.type || 'presence',
        }))

        const callForward = cfwdConf ? {
          enabled: cfwdConf.enabled || [], destination: cfwdConf.destinations || null, timeout: cfwdConf.timeouts || null,
        } : null

        // Find or create Supabase auth user
        let userId: string
        const { data: { users } } = await sb.auth.admin.listUsers().catch(() => ({ data: { users: [] } }))
        const existing = users?.find((u: any) => u.email === ext.email)
        if (existing) {
          userId = existing.id
        } else {
          const { data: nu, error: ae } = await sb.auth.admin.createUser({
            email: ext.email, email_confirm: false,
            user_metadata: { display_name: ext.name, source: 'bicom_migration' },
          })
          if (ae || !nu?.user) throw new Error(`Auth: ${ae?.message}`)
          userId = nu.user.id
        }

        const { data: ou, error: ouErr } = await sb.from('org_users').upsert({
          org_id: target_org_id, user_id: userId, email: ext.email,
          display_name: ext.name, role: 'member', extension: ext.ext,
          department: ext.department || null,
          caller_id_name: opts.callerid ? opts.callerid.split('<')[0].trim() : ext.name,
          caller_id_number: clidConf?.default_callerid || opts.callerid?.match(/<(.+)>/)?.[1] || null,
          voicemail_enabled: opts.voicemail === '1' || opts.voicemail === 1,
          voicemail_transcription: true,
          dnd_enabled: false,
          invite_token: null, phone_provisioned: false, onboarding_completed: false,
          settings: {
            bicom_id: ext._id, bicom_tenant_id,
            phone_model: ext.ua_name || null, phone_model_full: ext.ua_fullname || null,
            mac_address: fullConf?.macaddress || null, sip_username: opts.username || null,
            incoming_limit: parseInt(opts.incominglimit || '3'),
            outgoing_limit: parseInt(opts.outgoinglimit || '3'),
            ring_timeout: parseInt(opts.ringtime || '30'),
            timezone: opts.ext_timezone || 'Europe/London',
            caller_id_settings: callerIdSettings,
            blf_keys: blfKeys.length > 0 ? blfKeys : null,
            call_forward: callForward,
            codec_allow: opts.allow || ['ulaw', 'alaw'],
            migrated_at: new Date().toISOString(),
          },
        }, { onConflict: 'org_id,user_id' }).select('id').single()

        if (ouErr) throw new Error(`org_users: ${ouErr.message}`)
        extToOrgUserId[ext.ext] = ou!.id
        pendingInvites.push({ email: ext.email, display_name: ext.name, org_user_id: ou!.id })
        extensionsSynced++
        logger.info(`[BiCom] ✓ User ${ext.name} (ext ${ext.ext})`)
      } catch (e: any) { logger.warn(`[BiCom] Ext ${ext.ext}: ${e.message}`) }
    }
    await updateSync('in_progress', undefined, { extensions_synced: extensionsSynced })

    // ── Step 3: Ring groups → call_flows (with operation times) ─────────────
    const extToFlowId: Record<string, string> = {}
    let ringsSynced = 0

    for (const rg of ringGroups) {
      try {
        const rgConf = await bicomGet(server_url, api_key, 'pbxware.ring_group.configuration', bicom_tenant_id, { id: rg._id })
          .then(d => (Object.values(d)[0] as any)?.options || {}).catch(() => ({}))
        const memberExts = (rg.destinations || '').split(',').map((e: string) => e.trim()).filter(Boolean)

        const baseSteps = [
          { id: 'ring', type: 'ring_user', config: {
            timeout: parseInt(rgConf.timeout || '30'),
            ring_mode: rgConf.ring_strategy === 'all' ? 'simultaneous' : 'sequential',
            extensions: memberExts, callerid_override: rgConf.callerid || null,
          }},
          { id: 'vm', type: 'voicemail', config: {
            greeting: 'default', transcription: true, overflow_ext: rgConf.last_dest || null,
          }},
        ]

        // Fetch open/close schedule + bank holiday overrides
        const otimes = await fetchOtimes(server_url, api_key, bicom_tenant_id, 'dial_group', rg._id)
        const workflowSteps = wrapWithSchedule(baseSteps, otimes)

        const { data: flow, error } = await sb.from('call_flows').upsert({
          org_id: target_org_id, name: rg.name, flow_type: 'ring_group',
          entrypoint: 'start', is_active: true,
          settings: {
            extension: rg.ext, bicom_id: rg._id, bicom_tenant_id,
            callerid_override: rgConf.callerid || null,
            ring_strategy: rgConf.ring_strategy || 'all',
            max_callers: parseInt(rgConf.max_limit || '5'),
            record_calls: rgConf.record === '1',
            has_schedule: !!otimes, migrated_at: new Date().toISOString(),
          },
          workflow_steps: workflowSteps,
        }, { onConflict: 'org_id,name' }).select('id').single()

        if (error) throw new Error(error.message)
        extToFlowId[rg.ext] = flow!.id
        ringsSynced++
        logger.info(`[BiCom] ✓ Ring group "${rg.name}" (${rg.ext})${otimes ? ' [schedule]' : ''}`)
      } catch (e: any) { logger.warn(`[BiCom] Ring group "${rg.name}": ${e.message}`) }
    }
    await updateSync('in_progress', undefined, { ring_groups_synced: ringsSynced })

    // ── Step 4: IVRs → call_flows (with operation times) ────────────────────
    let ivrsSynced = 0

    for (const ivr of ivrs) {
      try {
        const options: Record<string, any> = {}
        if (ivr.keymap && typeof ivr.keymap === 'object') {
          for (const [key, dest] of Object.entries(ivr.keymap) as any) {
            const targetExt = dest?.value
            options[key] = {
              type: dest?.destination === 'Ring Group' ? 'ring_group'
                  : dest?.destination === 'IVR'        ? 'ivr'
                  : dest?.destination === 'Extension'  ? 'extension' : 'unknown',
              target_extension: targetExt,
              call_flow_id: extToFlowId[targetExt] || null,
            }
          }
        }

        const ivrMenuStep = {
          id: 'menu', type: 'ivr_menu',
          config: { greeting_file: ivr.greeting || null, options, timeout: 10 },
        }

        // Fetch open/close schedule + bank holidays for this IVR
        const otimes = await fetchOtimes(server_url, api_key, bicom_tenant_id, 'ivr', ivr._id)
        const workflowSteps = wrapWithSchedule([ivrMenuStep], otimes)

        const { data: flow, error } = await sb.from('call_flows').upsert({
          org_id: target_org_id, name: ivr.name, flow_type: 'ivr',
          entrypoint: 'start', is_active: ivr.status !== 'disabled',
          settings: {
            extension: ivr.ext, bicom_id: ivr._id, bicom_tenant_id,
            operator: ivr.operator || null,
            has_schedule: !!otimes, migrated_at: new Date().toISOString(),
          },
          workflow_steps: workflowSteps,
        }, { onConflict: 'org_id,name' }).select('id').single()

        if (error) throw new Error(error.message)
        extToFlowId[ivr.ext] = flow!.id
        ivrsSynced++
        logger.info(`[BiCom] ✓ IVR "${ivr.name}" (${ivr.ext})${otimes ? ' [schedule]' : ''}`)
      } catch (e: any) { logger.warn(`[BiCom] IVR "${ivr.name}": ${e.message}`) }
    }
    await updateSync('in_progress', undefined, { ivrs_synced: ivrsSynced })

    // ── Step 5: DIDs → phone_numbers ─────────────────────────────────────────
    let didsSynced = 0

    for (const did of dids) {
      if (!did.number || did.status === 'disabled') continue
      try {
        const normalised = e164(did.number)
        let callFlowId: string | null = extToFlowId[did.ext] || null

        // DID points to bare extension — auto-create a direct ring flow
        if (!callFlowId && did.type === 'Extension' && did.ext) {
          const { data: flow } = await sb.from('call_flows').upsert({
            org_id: target_org_id, name: `Direct — ${did.ext}`, flow_type: 'direct',
            entrypoint: 'start', is_active: true,
            settings: { extension: did.ext, bicom_tenant_id, migrated_at: new Date().toISOString() },
            workflow_steps: [
              { id: 'ring', type: 'ring_user', config: { timeout: 30, ring_mode: 'simultaneous', extensions: [did.ext] } },
              { id: 'vm',   type: 'voicemail', config: { greeting: 'default', transcription: true } },
            ],
          }, { onConflict: 'org_id,name' }).select('id').single()
          callFlowId = flow?.id || null
          if (callFlowId) extToFlowId[did.ext] = callFlowId
        }

        const { error } = await sb.from('phone_numbers').upsert({
          org_id: target_org_id, number: normalised,
          label: did.name || normalised, number_type: 'geographic',
          provider: 'gamma', status: 'active', is_active: true,
          voice_enabled: true, sms_enabled: false,
          call_flow_id: callFlowId,
          provider_number_id: `bicom_${did._id}`,
        }, { onConflict: 'org_id,number' })

        if (error) throw new Error(error.message)
        didsSynced++
        logger.info(`[BiCom] ✓ DID ${normalised} → flow ${callFlowId}`)
      } catch (e: any) { logger.warn(`[BiCom] DID ${did.number}: ${e.message}`) }
    }
    await updateSync('in_progress', undefined, { dids_synced: didsSynced })

    // ── Step 6: Store pending invites — NOT sent yet ──────────────────────────
    // Superadmin reviews migration first, then triggers invite send separately
    await sb.from('bicom_tenant_sync').update({
      sync_summary: {
        pending_invites: pendingInvites,
        invite_sent: false,
        completed_at: new Date().toISOString(),
      },
    }).eq('id', tenant_sync_id)

    // ── Step 7: Mark complete ─────────────────────────────────────────────────
    const totalExpected = extensions.filter(e => e.email && e.status !== '0').length
      + ringGroups.length + ivrs.length
      + dids.filter((d: any) => d.status !== 'disabled').length
    const totalSynced = extensionsSynced + ringsSynced + ivrsSynced + didsSynced
    const status = totalSynced >= totalExpected ? 'synced' : 'partial'

    await updateSync(status, undefined, {
      soniq_org_id: target_org_id,
      extensions_synced: extensionsSynced, ring_groups_synced: ringsSynced,
      ivrs_synced: ivrsSynced, dids_synced: didsSynced,
    })

    logger.info(`[BiCom] ✅ ${status} (${totalSynced}/${totalExpected}) — ${pendingInvites.length} invites pending review`)
    return { status, extensionsSynced, ringsSynced, ivrsSynced, didsSynced, pendingInvites }

  } catch (e: any) {
    logger.error(`[BiCom] ❌ FAILED tenant ${bicom_tenant_id}: ${e.message}`)
    await updateSync('error', e.message)
    throw e
  }
}
