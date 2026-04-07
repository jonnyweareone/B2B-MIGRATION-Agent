import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger'
import { VodiaClient } from './vodia-client'
import crypto from 'crypto'

function e164(raw: string): string {
  const d = (raw || '').replace(/\D/g, '')
  if (d.startsWith('44') && d.length >= 12) return `+${d}`
  if (d.startsWith('0') && d.length === 11) return `+44${d.slice(1)}`
  if (d.length === 10 && d.startsWith('7')) return `+44${d}`
  if (d.length === 0) return raw
  return d.startsWith('+') ? raw : `+${d}`
}

const DUMMY_EMAIL_RE = /^a@[bc]\.com$|^noemail|^no@email|^dummy|^placeholder|^none@|@none\.|^test@|@test\.|@example\.|^info@|^admin@|^sales@|^reception@|^office@|^accounts@|^hello@|^contact@/i

function isDummyEmail(email: string): boolean {
  return !email || DUMMY_EMAIL_RE.test(email.trim())
}

export interface VodiaMigrationParams {
  tenant_sync_id: string
  server_url: string
  username: string
  password: string
  vodia_domain: string   // the Vodia domain/tenant to migrate e.g. "acme.vodia.com"
  target_org_id: string
  dry_run?: boolean
}

export interface VodiaMigrationResult {
  status: 'synced' | 'partial' | 'error'
  extensionsSynced: number
  queuesSynced: number
  autoAttendantsSynced: number
  numbersSynced: number
  pendingInvites: Array<{ email: string; display_name: string; org_user_id: string }>
}

export async function migrateVodiaDomain(params: VodiaMigrationParams): Promise<VodiaMigrationResult> {
  const { tenant_sync_id, server_url, username, password, vodia_domain, target_org_id, dry_run = false } = params
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const client = new VodiaClient(server_url, username, password)
  const SIP_REALM = 'sip.soniqlabs.co.uk'

  async function updateSync(status: string, error?: string, extra?: Record<string, any>) {
    await sb.from('vodia_tenant_sync').update({
      status, last_error: error || null,
      last_sync_at: new Date().toISOString(), ...extra,
    }).eq('id', tenant_sync_id)
  }

  try {
    logger.info(`[Vodia] Starting migration -- domain ${vodia_domain} → org ${target_org_id}`)
    if (!dry_run) await updateSync('in_progress')

    // ── Login ─────────────────────────────────────────────────────────────────
    await client.login()
    logger.info(`[Vodia] Authenticated to ${server_url}`)

    // ── Fetch all data ────────────────────────────────────────────────────────
    const [extensions, queues, autoAttendants, trunks, dialplans] = await Promise.all([
      client.listAccounts(vodia_domain, 'extensions'),
      client.listQueues(vodia_domain),
      client.listAutoAttendants(vodia_domain),
      client.listTrunks(vodia_domain),
      client.listDialplans(vodia_domain),
    ])

    logger.info(`[Vodia] ${extensions.length} exts, ${queues.length} queues, ${autoAttendants.length} AAs, ${trunks.length} trunks`)

    if (!dry_run) await updateSync('in_progress', undefined, {
      extensions_count: extensions.length,
      queues_count: queues.length,
      auto_attendants_count: autoAttendants.length,
    })

    if (dry_run) {
      return { status: 'synced', extensionsSynced: 0, queuesSynced: 0, autoAttendantsSynced: 0, numbersSynced: 0, pendingInvites: [] }
    }

    // ── Org slug for SIP username ─────────────────────────────────────────────
    const { data: orgData } = await sb.from('orgs').select('slug').eq('id', target_org_id).single()
    const orgSlug = orgData?.slug || 'soniq'

    // ── Step 1: Extensions → org_users + sip_credentials ─────────────────────
    const extToOrgUserId: Record<string, string> = {}
    const pendingInvites: Array<{ email: string; display_name: string; org_user_id: string }> = []
    let extensionsSynced = 0

    for (const ext of extensions) {
      const account = ext.account || ext.account_ext || ext.id
      if (!account) continue

      try {
        // Fetch full settings for this extension
        const settings = await client.getUserSettings(vodia_domain, account).catch(() => ({}))
        const email = ((settings.email || ext.email || '')).trim().toLowerCase()
        const displayName = [settings.first_name || ext.first_name, settings.last_name || ext.last_name]
          .filter(Boolean).join(' ') || `Ext ${account}`
        const hasRealEmail = !isDummyEmail(email)
        const authEmail = hasRealEmail ? email : null

        // Find or create auth user
        let userId: string
        const targetEmail = authEmail || `ext.${account}.${vodia_domain.replace(/\./g, '-')}@vodia.internal`
        const { data: created, error: createErr } = await sb.auth.admin.createUser({
          email: targetEmail,
          email_confirm: !!authEmail,
          user_metadata: { display_name: displayName, source: 'vodia_migration' },
        })
        if (created?.user) {
          userId = created.user.id
        } else if (createErr?.message?.includes('already') || createErr?.status === 422) {
          const { data: list } = await sb.auth.admin.listUsers({ perPage: 1000 })
          const found = list?.users?.find((u: any) => u.email === targetEmail)
          if (!found) throw new Error(`Auth user not found after duplicate error for ${targetEmail}`)
          userId = found.id
        } else {
          throw new Error(`Auth createUser failed: ${createErr?.message}`)
        }

        // Caller ID — Vodia stores as 'ani' field
        const callerIdNumber = settings.ani || settings.cid_number || null

        // Call forward settings
        const callForward = {
          unconditional: settings.cfa || null,
          busy: settings.cfb || null,
          no_answer: settings.cfr || null,
          dnd: settings.dnd === 'true' || settings.dnd === true,
        }

        const { data: ou, error: ouErr } = await sb.from('org_users').upsert({
          org_id: target_org_id,
          user_id: userId,
          email: authEmail,
          display_name: displayName,
          role: 'member',
          extension: account,
          department: settings.department || null,
          caller_id_name: displayName,
          caller_id_number: callerIdNumber,
          voicemail_enabled: settings.no_vpa !== 'true',
          voicemail_transcription: true,
          dnd_enabled: callForward.dnd,
          invite_token: null,
          phone_provisioned: false,
          onboarding_completed: false,
          settings: {
            vodia_account: account,
            vodia_domain,
            vodia_cell: settings.cell || null,
            vodia_mac: settings.mac || null,
            caller_id_number: callerIdNumber,
            call_forward: callForward,
            has_real_email: hasRealEmail,
            vodia_email: email || null,
            email_note: !hasRealEmail ? `Vodia had no real email -- needs update before invite` : null,
            migrated_at: new Date().toISOString(),
          },
        }, { onConflict: 'org_id,user_id', ignoreDuplicates: false }).select('id')

        if (ouErr) throw new Error(`org_users upsert: ${ouErr.message}`)
        const orgUserId = ou?.[0]?.id
        if (!orgUserId) {
          const { data: existing } = await sb.from('org_users')
            .select('id').eq('org_id', target_org_id).eq('user_id', userId).single()
          if (existing) extToOrgUserId[account] = existing.id
        } else {
          extToOrgUserId[account] = orgUserId
        }

        if (hasRealEmail && authEmail && extToOrgUserId[account]) {
          pendingInvites.push({ email: authEmail, display_name: displayName, org_user_id: extToOrgUserId[account] })
        }

        // SIP credentials
        const sipUsername = `${account}.${orgSlug}`
        const sipPassword = crypto.randomBytes(12).toString('hex').slice(0, 20)
        const { data: hashData } = await sb.rpc('crypt_password', { plain_password: sipPassword })
        if (hashData) {
          await sb.from('sip_credentials').upsert({
            org_id: target_org_id,
            org_user_id: extToOrgUserId[account],
            extension: account,
            username: sipUsername,
            password_hash: hashData,
            password_plain: sipPassword,
            display_name: displayName,
            realm: SIP_REALM,
            enabled: true,
          }, { onConflict: 'org_id,extension' })
        }

        // Device record if MAC present
        if (settings.mac) {
          await sb.from('sip_devices').upsert({
            org_id: target_org_id,
            org_user_id: extToOrgUserId[account],
            extension: account,
            name: displayName,
            label: displayName,
            mac_address: settings.mac.toUpperCase().replace(/(.{2})(?=.)/g, '$1:'),
            status: 'pending_migration',
            rps_status: 'needs_update',
            settings: { vodia_domain, vodia_account: account, migrated_at: new Date().toISOString() },
          }, { onConflict: 'org_id,extension' })
        }

        extensionsSynced++
        logger.info(`[Vodia] [OK] Ext ${account} (${displayName}) ${hasRealEmail ? 'invite queued' : 'no real email'}`)
      } catch (e: any) {
        logger.warn(`[Vodia] Ext ${account}: ${e.message}`)
      }
    }
    await updateSync('in_progress', undefined, { extensions_synced: extensionsSynced })

    // ── Step 2: ACD Queues → call_flows ──────────────────────────────────────
    let queuesSynced = 0
    const accountToFlowId: Record<string, string> = {}

    for (const q of queues) {
      const account = q.account || q.id
      if (!account) continue
      try {
        const settings = await client.getQueueSettings(vodia_domain, account).catch(() => ({}))
        const memberExts = (settings.agents || []).map((a: any) => a.account || a).filter(Boolean)

        const { data: flow, error } = await sb.from('call_flows').upsert({
          org_id: target_org_id,
          name: settings.name || q.name || `Queue ${account}`,
          flow_type: 'hunt_group',
          entrypoint: 'start',
          is_active: true,
          settings: {
            extension: account,
            vodia_account: account,
            vodia_domain,
            ring_strategy: settings.ring_strategy || 'simultaneous',
            max_wait_time: parseInt(settings.max_wait_time || '300'),
            migrated_at: new Date().toISOString(),
          },
          workflow_steps: [
            {
              id: 'ring', type: 'ring_user',
              config: {
                timeout: parseInt(settings.timeout || '30'),
                ring_mode: settings.ring_strategy === 'sequential' ? 'sequential' : 'simultaneous',
                extensions: memberExts,
              },
            },
            { id: 'vm', type: 'voicemail', config: { greeting: 'default', transcription: true } },
          ],
        }, { onConflict: 'org_id,name' }).select('id').single()

        if (error) throw new Error(error.message)
        accountToFlowId[account] = flow!.id
        queuesSynced++
        logger.info(`[Vodia] [OK] Queue ${account} (${settings.name || account})`)
      } catch (e: any) {
        logger.warn(`[Vodia] Queue ${account}: ${e.message}`)
      }
    }
    await updateSync('in_progress', undefined, { queues_synced: queuesSynced })

    // ── Step 3: Auto Attendants (IVRs) → call_flows ───────────────────────────
    let autoAttendantsSynced = 0

    for (const aa of autoAttendants) {
      const account = aa.account || aa.id
      if (!account) continue
      try {
        const settings = await client.getAutoAttendantSettings(vodia_domain, account).catch(() => ({}))

        // Vodia AA key map: digit → destination account
        const options: Record<string, any> = {}
        for (const key of ['0','1','2','3','4','5','6','7','8','9','*','#']) {
          const dest = settings[`key_${key}`] || settings[key]
          if (dest) {
            options[key] = {
              type: accountToFlowId[dest] ? 'call_flow' : 'extension',
              target: dest,
              call_flow_id: accountToFlowId[dest] || null,
            }
          }
        }

        const { data: flow, error } = await sb.from('call_flows').upsert({
          org_id: target_org_id,
          name: settings.name || aa.name || `AA ${account}`,
          flow_type: 'ivr',
          entrypoint: 'start',
          is_active: settings.disabled !== 'true',
          settings: {
            extension: account,
            vodia_account: account,
            vodia_domain,
            operator: settings.operator || null,
            migrated_at: new Date().toISOString(),
          },
          workflow_steps: [
            {
              id: 'menu', type: 'ivr_menu',
              config: {
                greeting_file: settings.prompt || null,
                options,
                timeout: parseInt(settings.timeout || '10'),
                retries: parseInt(settings.retries || '3'),
              },
            },
          ],
        }, { onConflict: 'org_id,name' }).select('id').single()

        if (error) throw new Error(error.message)
        accountToFlowId[account] = flow!.id
        autoAttendantsSynced++
        logger.info(`[Vodia] [OK] AA ${account} (${settings.name || account})`)
      } catch (e: any) {
        logger.warn(`[Vodia] AA ${account}: ${e.message}`)
      }
    }
    await updateSync('in_progress', undefined, { auto_attendants_synced: autoAttendantsSynced })

    // ── Step 4: Trunks → phone_numbers (DIDs from dial plans) ─────────────────
    // Vodia doesn't expose DIDs directly — extract inbound numbers from dial plans
    let numbersSynced = 0

    for (const dp of dialplans) {
      const dpId = dp.id || dp.name
      if (!dpId) continue
      try {
        const dpSettings = await client.getDialplanSettings(vodia_domain, dpId).catch(() => null)
        if (!dpSettings?.dps) continue
        for (const entry of dpSettings.dps) {
          const pattern = entry.settings?.pattern
          // Only process entries that look like DID numbers (10+ digits)
          if (!pattern || !/^\+?\d{7,}/.test(pattern)) continue
          const normalised = e164(pattern.replace(/[^0-9+]/g, ''))
          if (!normalised || normalised.length < 7) continue

          // Find call flow for destination
          const destTrunk = entry.settings?.trunk
          const callFlowId = Object.values(accountToFlowId)[0] || null // default to first flow

          const { error } = await sb.from('phone_numbers').upsert({
            org_id: target_org_id,
            number: normalised,
            label: normalised,
            number_type: 'local',
            provider: 'vodia_byoc',
            status: 'active',
            is_active: true,
            voice_enabled: true,
            sms_enabled: false,
            call_flow_id: callFlowId,
            provider_number_id: `vodia_${vodia_domain}_${dpId}_${normalised}`,
          }, { onConflict: 'org_id,number' })

          if (!error) {
            numbersSynced++
            logger.info(`[Vodia] [OK] Number ${normalised}`)
          }
        }
      } catch (e: any) {
        logger.warn(`[Vodia] Dialplan ${dpId}: ${e.message}`)
      }
    }

    // ── Step 5: Store trunks for reference ────────────────────────────────────
    for (const trunk of trunks) {
      const { error: trunkErr } = await sb.from('vodia_trunk_reference').upsert({
        tenant_sync_id,
        vodia_domain,
        trunk_id: trunk.id,
        name: trunk.name || `Trunk ${trunk.id}`,
        type: trunk.type || 'register',
        proxy: trunk.proxy || null,
        registrar: trunk.registrar || null,
        account: trunk.account || null,
        raw_config: trunk,
      }, { onConflict: 'tenant_sync_id,trunk_id', ignoreDuplicates: true })
      if (trunkErr) logger.warn(`[Vodia] Trunk ref upsert: ${trunkErr.message}`)
    }

    // ── Step 6: Store pending invites + complete ───────────────────────────────
    await sb.from('vodia_tenant_sync').update({
      sync_summary: {
        pending_invites: pendingInvites,
        invite_sent: false,
        completed_at: new Date().toISOString(),
      },
    }).eq('id', tenant_sync_id)

    const totalSynced = extensionsSynced + queuesSynced + autoAttendantsSynced
    const totalExpected = extensions.length + queues.length + autoAttendants.length
    const status = totalSynced >= totalExpected ? 'synced' : 'partial'

    await updateSync(status, undefined, {
      vodia_domain,
      extensions_synced: extensionsSynced,
      queues_synced: queuesSynced,
      auto_attendants_synced: autoAttendantsSynced,
      numbers_synced: numbersSynced,
    })

    logger.info(`[Vodia] [OK] ${status} (${totalSynced}/${totalExpected}) -- ${pendingInvites.length} invites pending`)
    return { status, extensionsSynced, queuesSynced, autoAttendantsSynced, numbersSynced, pendingInvites }

  } catch (e: any) {
    logger.error(`[Vodia] [ERR] FAILED domain ${vodia_domain}: ${e.message}`)
    await updateSync('error', e.message)
    throw e
  }
}

// ── Analysis (pre-migration scan, no writes) ──────────────────────────────────
export async function analyseVodiaDomain(
  tenant_sync_id: string,
  server_url: string,
  username: string,
  password: string,
  vodia_domain: string,
) {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const client = new VodiaClient(server_url, username, password)
  await client.login()

  const [extensions, queues, autoAttendants, trunks, dialplans, domainSettings] = await Promise.all([
    client.listAccounts(vodia_domain, 'extensions'),
    client.listQueues(vodia_domain),
    client.listAutoAttendants(vodia_domain),
    client.listTrunks(vodia_domain),
    client.listDialplans(vodia_domain),
    client.getDomainSettings(vodia_domain).catch(() => ({})),
  ])

  // Deep-fetch extension details
  const users = await Promise.all(
    extensions.slice(0, 100).map(async (ext: any) => {
      const account = ext.account || ext.account_ext || ext.id
      const settings = await client.getUserSettings(vodia_domain, account).catch(() => ({}))
      const email = (settings.email || ext.email || '').trim().toLowerCase()
      return {
        account,
        display_name: [settings.first_name, settings.last_name].filter(Boolean).join(' ') || `Ext ${account}`,
        email: email || null,
        has_real_email: !isDummyEmail(email),
        mac: settings.mac || null,
        voicemail: settings.no_vpa !== 'true',
        dnd: settings.dnd === 'true',
        cfa: settings.cfa || null,
        ani: settings.ani || null,
        cell: settings.cell || null,
      }
    })
  )

  const analysis = {
    domain: vodia_domain,
    users,
    queues: queues.map(q => ({ account: q.account || q.id, name: q.name })),
    auto_attendants: autoAttendants.map(aa => ({ account: aa.account || aa.id, name: aa.name })),
    trunks: trunks.map(t => ({ id: t.id, name: t.name, type: t.type, proxy: t.proxy })),
    dialplan_count: dialplans.length,
    domain_settings: {
      country_code: domainSettings.country_code || null,
      time_zone: domainSettings.time_zone || null,
      language: domainSettings.language || null,
    },
    summary: {
      extensions: extensions.length,
      queues: queues.length,
      auto_attendants: autoAttendants.length,
      trunks: trunks.length,
      users_with_real_email: users.filter(u => u.has_real_email).length,
      users_needing_email: users.filter(u => !u.has_real_email).length,
      users_with_mac: users.filter(u => u.mac).length,
    },
    analysed_at: new Date().toISOString(),
  }

  await sb.from('vodia_tenant_sync').update({
    pre_migration_analysis: analysis,
    status: 'analysed',
    extensions_count: extensions.length,
    queues_count: queues.length,
    auto_attendants_count: autoAttendants.length,
  }).eq('id', tenant_sync_id)

  return analysis
}
