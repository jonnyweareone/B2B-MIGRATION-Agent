/**
 * Greeting Capture Service
 *
 * Uses SONIQ's LiveKit SIP stack to capture IVR greeting audio.
 *
 * Strategy:
 *   1. IVRs with an existing direct DDI → call it directly
 *   2. IVRs with no direct DDI → temporarily redirect a "capture DDI" in BiCom
 *      to point at the target IVR, capture, then restore the DDI
 *
 * The capture DDI is the first available DDI in the tenant (preferring ones
 * already pointed at IVRs, falling back to any DDI we can redirect safely).
 * A "spare" DDI number can be specified explicitly via the captureDdi param.
 *
 * For OOH-only greetings: we capture the IVR at whatever it's currently set to.
 * The caller can re-trigger capture after manually enabling/disabling OOH if needed.
 *
 * BiCom dest_type codes (discovered empirically):
 *   1 = Extension  3 = IVR  5 = External Number  7 = Voicemail
 *  11 = Fax        13 = Deny Access
 */

import {
  RoomServiceClient,
  EgressClient,
  SipClient,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
} from 'livekit-server-sdk'
import type { RoomCompositeOptions } from 'livekit-server-sdk'
import axios from 'axios'
import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger'

const LIVEKIT_URL     = (process.env.LIVEKIT_URL || 'https://livekit.soniqlabs.co.uk').trim()
const LIVEKIT_API_KEY = (process.env.LIVEKIT_API_KEY || '').trim()
const LIVEKIT_SECRET  = (process.env.LIVEKIT_API_SECRET || '').trim()
const OUTBOUND_TRUNK  = (process.env.LIVEKIT_TRUNK_ONEHUB_OUTBOUND || 'ST_LqJX6RiwjVYe').trim()
const S3_BUCKET       = (process.env.S3_BUCKET || 'soniq-phone-prompts').trim()
const S3_ENDPOINT     = (process.env.S3_ENDPOINT || 'https://s3.eu-west-1.peasoup.cloud').trim()
const S3_KEY          = (process.env.S3_ACCESS_KEY || '').trim()
const S3_SECRET_KEY   = (process.env.S3_SECRET_KEY || '').trim()
const S3_REGION       = (process.env.S3_REGION || 'eu-west-1').trim()
const CAPTURE_CLI     = (process.env.GREETING_CAPTURE_CLI || '+442033754399').trim()
const CAPTURE_SECS    = 38  // long enough for greeting + menu tones

const DEST_TYPE_IVR         = '3'
const DEST_TYPE_DENY_ACCESS = '13'

// ── BiCom DID helpers ─────────────────────────────────────────────────────────

async function bicomGet(serverUrl: string, apiKey: string, params: Record<string, string>) {
  const r = await axios.get(`${serverUrl.replace(/\/$/, '')}/index.php`, {
    params: { apikey: apiKey, ...params }, timeout: 12000,
  })
  return r.data
}

/** Redirect a DID to an IVR extension using dest_type=3 */
async function redirectDidToIvr(
  serverUrl: string, apiKey: string, tenantId: string, didId: string, ivrExt: string
) {
  const r = await bicomGet(serverUrl, apiKey, {
    action: 'pbxware.did.edit', server: tenantId,
    id: didId, dest_type: DEST_TYPE_IVR, destination: ivrExt,
  })
  if (!r.success) throw new Error(`Failed to redirect DID ${didId} to IVR ${ivrExt}: ${JSON.stringify(r)}`)
  logger.info(`[GreetingCapture] DID ${didId} → IVR ext ${ivrExt}`)
}

/** Restore a DID to its original destination */
async function restoreDid(
  serverUrl: string, apiKey: string, tenantId: string, didId: string,
  origType: string, origExt: string
) {
  const typeMap: Record<string, string> = {
    'IVR': '3', 'Extension': '1', 'Ring Group': '1', 'Multi User': '1',
    'Voicemail': '7', 'External Number': '5',
    'Fax to E-mail': '11', 'Deny Access': '13', '-': '13',
  }
  const destType = typeMap[origType] || '13'
  const params: Record<string, string> = {
    action: 'pbxware.did.edit', server: tenantId,
    id: didId, dest_type: destType, destination: origExt || '',
  }
  await bicomGet(serverUrl, apiKey, params)
  logger.info(`[GreetingCapture] DID ${didId} restored → ${origType || 'Deny Access'} "${origExt}"`)
}

/** E.164 normalise a UK number */
function toE164(raw: string): string {
  const d = raw.replace(/\D/g, '')
  if (d.startsWith('44') && d.length >= 12) return `+${d}`
  if (d.startsWith('0') && d.length === 11) return `+44${d.slice(1)}`
  return `+${d}`
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GreetingCaptureResult {
  ivr_bicom_id: string
  ivr_name: string
  ivr_ext: string
  ddi_called: string | null
  ddi_redirected: boolean    // true if we temporarily changed a DDI routing
  greeting_file: string
  recording_url: string | null
  status: 'captured' | 'no_ddi' | 'failed' | 'skipped'
  error?: string
}

// ── Main capture function ─────────────────────────────────────────────────────

export async function captureGreetings(
  tenantSyncId: string,
  serverUrl: string,
  apiKey: string,
  bicomTenantId: string,
  ivrs: Array<{ bicom_id: string; name: string; ext: string; greeting: string | null }>,
  dids: Array<{ bicom_id: string; number: string; number_raw?: string; type: string; destination_ext: string | null }>,
  captureDdi?: string | null,   // optional spare DDI to use (e.g. '01264837125')
  specificIvrIds?: string[]
): Promise<GreetingCaptureResult[]> {
  const sb  = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const roomSvc   = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_SECRET)
  const egressSvc = new EgressClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_SECRET)
  const sipSvc    = new SipClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_SECRET)

  // Build a map: ivr_ext → first DDI already pointing at it
  const directDdiByExt: Record<string, { id: string; number: string; number_raw: string }> = {}
  for (const did of dids) {
    if (did.type === 'IVR' && did.destination_ext && !directDdiByExt[did.destination_ext]) {
      directDdiByExt[did.destination_ext] = {
        id: did.bicom_id,
        number: did.number,
        number_raw: did.number_raw || did.number,
      }
    }
  }

  // Choose a "redirect DDI" — the spare DDI if given, else first IVR-routed DDI in the tenant
  // We'll temporarily reroute it for IVRs that have no direct DDI
  let redirectDid: { id: string; number: string; orig_type: string; orig_ext: string } | null = null

  if (captureDdi) {
    // User specified a spare DDI number — find it in the did list by number match
    const normalised = captureDdi.replace(/\D/g, '')
    const spare = dids.find(d => {
      const n = (d.number_raw || d.number || '').replace(/\D/g, '')
      return n === normalised || n.endsWith(normalised) || normalised.endsWith(n)
    })
    if (spare) {
      // Store the actual current type/ext for accurate restore
      redirectDid = {
        id: spare.bicom_id,
        number: toE164(spare.number_raw || spare.number),
        orig_type: spare.type || 'Deny Access',
        orig_ext: spare.destination_ext || '',
      }
      logger.info(`[GreetingCapture] Spare DDI found: DID ${spare.bicom_id} (${redirectDid.number}), currently ${spare.type}`)
    } else {
      logger.warn(`[GreetingCapture] Spare DDI ${captureDdi} not found in tenant DID list — re-run analyse to refresh, or add it to the tenant first`)
    }
  }

  if (!redirectDid) {
    // Fall back: pick the first IVR-routed DDI as our redirect candidate
    const firstIvrDid = dids.find(d => d.type === 'IVR' && d.destination_ext)
    if (firstIvrDid) {
      redirectDid = {
        id: firstIvrDid.bicom_id, number: toE164(firstIvrDid.number),
        orig_type: 'IVR', orig_ext: firstIvrDid.destination_ext!,
      }
    }
  }

  // Filter IVRs to capture
  const targets = ivrs.filter(ivr =>
    ivr.greeting && (!specificIvrIds || specificIvrIds.includes(ivr.bicom_id))
  )

  const results: GreetingCaptureResult[] = []

  for (const ivr of targets) {
    const s3Path    = `greeting-captures/${tenantSyncId}/${ivr.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${ivr.ext}.ogg`
    const roomName  = `greeting-cap-${tenantSyncId.slice(0, 8)}-${ivr.ext}-${Date.now()}`
    const directDdi = directDdiByExt[ivr.ext]
    const base: GreetingCaptureResult = {
      ivr_bicom_id: ivr.bicom_id, ivr_name: ivr.name, ivr_ext: ivr.ext,
      ddi_called: null, ddi_redirected: false,
      greeting_file: ivr.greeting!, recording_url: null, status: 'failed',
    }

    let ddiNumber: string
    let didRedirected = false

    try {
      if (directDdi) {
        // IVR already has a direct DDI — call it directly
        ddiNumber = toE164(directDdi.number_raw || directDdi.number)
        logger.info(`[GreetingCapture] ${ivr.name} (${ivr.ext}): calling direct DDI ${ddiNumber}`)
      } else if (redirectDid) {
        // Temporarily redirect the capture DDI to this IVR
        logger.info(`[GreetingCapture] ${ivr.name} (${ivr.ext}): no direct DDI, redirecting ${redirectDid.number} via DID ${redirectDid.id}`)
        await redirectDidToIvr(serverUrl, apiKey, bicomTenantId, redirectDid.id, ivr.ext)
        didRedirected = true
        ddiNumber = redirectDid.number
        await sleep(2000) // brief wait for BiCom routing table to propagate
      } else {
        logger.warn(`[GreetingCapture] ${ivr.name} (${ivr.ext}): no DDI available, skipping`)
        results.push({ ...base, status: 'no_ddi', error: 'No DDI available — provide a spare DDI number' })
        continue
      }

      // Create the LiveKit room
      await roomSvc.createRoom({ name: roomName, emptyTimeout: 120, maxParticipants: 2 })

      // Start egress to S3 (audio-only OGG)
      const s3Upload = new S3Upload({
        accessKey: S3_KEY, secret: S3_SECRET_KEY,
        region: S3_REGION, bucket: S3_BUCKET,
        endpoint: S3_ENDPOINT, forcePathStyle: true,
      })
      const fileOutput = new EncodedFileOutput({
        fileType: EncodedFileType.OGG, filepath: s3Path,
        output: { case: 's3', value: s3Upload },
      })
      const egressOpts: RoomCompositeOptions = { audioOnly: true }
      const egressInfo = await egressSvc.startRoomCompositeEgress(roomName, fileOutput, egressOpts)
      const egressId = egressInfo.egressId
      logger.info(`[GreetingCapture] Egress ${egressId} → s3://${S3_BUCKET}/${s3Path}`)

      // Dial the DDI via OneHub outbound trunk
      const sipParticipant = await sipSvc.createSipParticipant(
        OUTBOUND_TRUNK, ddiNumber, roomName,
        {
          participantIdentity: `greeting-bot-${ivr.ext}`,
          participantName:     `Greeting Capture (${ivr.name})`,
          fromNumber:          CAPTURE_CLI,
          playDialtone:        false,
          ringingTimeout:      25,
          maxCallDuration:     CAPTURE_SECS + 20,
        }
      )
      logger.info(`[GreetingCapture] Dialling ${ddiNumber} → SIP participant ${sipParticipant.participantIdentity}`)

      // Record for CAPTURE_SECS (greeting plays within this window)
      await sleep(CAPTURE_SECS * 1000)

      // Clean up
      await roomSvc.removeParticipant(roomName, sipParticipant.participantIdentity).catch(() => {})
      await egressSvc.stopEgress(egressId)
      await sleep(3000) // wait for egress to flush file

      const recordingUrl = `${S3_ENDPOINT}/${S3_BUCKET}/${s3Path}`

      // Persist recording URL into analysis in Supabase
      const { data: syncRow } = await sb.from('bicom_tenant_sync')
        .select('pre_migration_analysis').eq('id', tenantSyncId).single()
      if (syncRow?.pre_migration_analysis) {
        const analysis = syncRow.pre_migration_analysis
        const ivrIdx = (analysis.ivrs || []).findIndex((i: any) => i.bicom_id === ivr.bicom_id)
        if (ivrIdx >= 0) {
          analysis.ivrs[ivrIdx].greeting_url = recordingUrl
          analysis.ivrs[ivrIdx].greeting_captured_at = new Date().toISOString()
          await sb.from('bicom_tenant_sync').update({ pre_migration_analysis: analysis }).eq('id', tenantSyncId)
        }
      }

      logger.info(`[GreetingCapture] ✓ ${ivr.name} captured → ${recordingUrl}`)
      results.push({ ...base, ddi_called: ddiNumber, ddi_redirected: didRedirected, status: 'captured', recording_url: recordingUrl })

    } catch (e: any) {
      logger.error(`[GreetingCapture] Failed for ${ivr.name}: ${e.message}`)
      await roomSvc.deleteRoom(roomName).catch(() => {})
      results.push({ ...base, ddi_called: redirectDid?.number || null, ddi_redirected: didRedirected, status: 'failed', error: e.message })
    } finally {
      // ALWAYS restore the redirected DDI — even if capture failed
      if (didRedirected && redirectDid) {
        await restoreDid(serverUrl, apiKey, bicomTenantId, redirectDid.id, redirectDid.orig_type, redirectDid.orig_ext)
          .catch(e => logger.error(`[GreetingCapture] FAILED TO RESTORE DID ${redirectDid!.id}: ${e.message}`))
      }
    }

    await sleep(5000) // pause between captures
  }

  return results
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
