/**
 * Greeting Capture Service
 *
 * Uses SONIQ's LiveKit SIP stack to place outbound calls to DDIs that route
 * to IVRs with greetings, records the audio, and stores the .wav file in
 * Supabase Storage. This is the only way to obtain greeting files from
 * BiCom -- there is no API to download them from the server filesystem.
 *
 * Flow per IVR:
 *   1. Find a DDI that routes to this IVR (from analysis data)
 *   2. Create a LiveKit room for the capture session
 *   3. Start TrackEgress to S3/storage as a .wav file
 *   4. createSipParticipant → dials the DDI via OneHub outbound trunk
 *   5. Wait CAPTURE_DURATION_S seconds (greeting plays down the line)
 *   6. Remove SIP participant, stop egress
 *   7. Store the recording URL back into the analysis in Supabase
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
import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger'

const LIVEKIT_URL     = process.env.LIVEKIT_URL     || 'https://livekit.soniqlabs.co.uk'
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || ''
const LIVEKIT_SECRET  = process.env.LIVEKIT_API_SECRET || ''
// OneHub outbound trunk (UK PSTN calls)
const OUTBOUND_TRUNK  = process.env.LIVEKIT_TRUNK_ONEHUB_OUTBOUND || 'ST_LqJX6RiwjVYe'
// S3 bucket for greeting captures -- uses SONIQ prompts bucket
const S3_BUCKET   = process.env.S3_BUCKET || 'soniq-phone-prompts'
const S3_ENDPOINT = process.env.S3_ENDPOINT || 'https://s3.eu-west-1.peasoup.cloud'
const S3_KEY      = process.env.S3_ACCESS_KEY || ''
const S3_SECRET   = process.env.S3_SECRET_KEY || ''
const S3_REGION   = process.env.S3_REGION || 'eu-west-1'

// How long to record -- greeting + buffer + any IVR menu tone
const CAPTURE_DURATION_S = 40
// Caller ID to use for the outbound capture call
const CAPTURE_CALLER_ID  = process.env.GREETING_CAPTURE_CLI || '+442033754399'

function livekitWsUrl() {
  return LIVEKIT_URL.replace('https://', 'wss://').replace('http://', 'ws://')
}

export interface GreetingCaptureResult {
  ivr_bicom_id: string
  ivr_name: string
  ivr_ext: string
  ddi_called: string | null
  greeting_file: string       // original BiCom filename
  recording_url: string | null
  status: 'captured' | 'no_ddi' | 'failed' | 'skipped'
  error?: string
  duration_s?: number
}

export async function captureGreetings(
  tenantSyncId: string,
  ivrs: Array<{ bicom_id: string; name: string; ext: string; greeting: string | null }>,
  dids: Array<{ bicom_id: string; number: string; type: string; destination_ext: string | null }>,
  specificIvrIds?: string[]
): Promise<GreetingCaptureResult[]> {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const roomSvc   = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_SECRET)
  const egressSvc = new EgressClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_SECRET)
  const sipSvc    = new SipClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_SECRET)

  // Build DDI lookup: ext → first DDI number that routes to it
  const ddiByExt: Record<string, string> = {}
  for (const did of dids) {
    if (did.type === 'IVR' && did.destination_ext && !ddiByExt[did.destination_ext]) {
      // Normalise to E.164
      let num = did.number.replace(/\D/g, '')
      if (num.startsWith('0') && num.length === 11) num = '44' + num.slice(1)
      ddiByExt[did.destination_ext] = '+' + num
    }
  }

  // Filter IVRs: only ones with greeting files, optionally filtered by ID
  const targets = ivrs.filter(ivr =>
    ivr.greeting &&
    (!specificIvrIds || specificIvrIds.includes(ivr.bicom_id))
  )

  const results: GreetingCaptureResult[] = []

  for (const ivr of targets) {
    const ddi = ddiByExt[ivr.ext] || null
    const base: GreetingCaptureResult = {
      ivr_bicom_id: ivr.bicom_id, ivr_name: ivr.name, ivr_ext: ivr.ext,
      ddi_called: ddi, greeting_file: ivr.greeting!, recording_url: null, status: 'failed',
    }

    if (!ddi) {
      logger.warn(`[GreetingCapture] IVR ${ivr.name} (${ivr.ext}) -- no DDI found, skipping`)
      results.push({ ...base, status: 'no_ddi', error: 'No DDI routes to this IVR' })
      continue
    }

    const roomName = `greeting-capture-${tenantSyncId.slice(0, 8)}-${ivr.ext}-${Date.now()}`
    const s3Path   = `greeting-captures/${tenantSyncId}/${ivr.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${ivr.ext}.ogg`

    try {
      logger.info(`[GreetingCapture] Capturing ${ivr.name} (${ivr.ext}) via ${ddi} → room ${roomName}`)

      // Create room
      await roomSvc.createRoom({ name: roomName, emptyTimeout: 120, maxParticipants: 2 })

      // Start egress -- record the room audio as OGG (audio-only) to S3
      const s3Upload = new S3Upload({
        accessKey: S3_KEY,
        secret: S3_SECRET,
        region: S3_REGION,
        bucket: S3_BUCKET,
        endpoint: S3_ENDPOINT,
        forcePathStyle: true,   // Required for Peasoup/Ceph RGW
      })
      const fileOutput = new EncodedFileOutput({
        fileType: EncodedFileType.OGG,
        filepath: s3Path,
        output: { case: 's3', value: s3Upload },
      })
      const egressOpts: RoomCompositeOptions = { audioOnly: true }
      const egressInfo = await egressSvc.startRoomCompositeEgress(roomName, fileOutput, egressOpts)
      const egressId = egressInfo.egressId
      logger.info(`[GreetingCapture] Egress started: ${egressId}`)

      // Dial the DDI via SONIQ's OneHub outbound trunk
      const sipParticipant = await sipSvc.createSipParticipant(
        OUTBOUND_TRUNK,
        ddi,
        roomName,
        {
          participantIdentity: `greeting-bot-${ivr.ext}`,
          participantName:     `Greeting Capture (${ivr.name})`,
          fromNumber:          CAPTURE_CALLER_ID,
          playDialtone:        false,
          ringingTimeout:      30,
          maxCallDuration:     CAPTURE_DURATION_S + 30,
        }
      )
      logger.info(`[GreetingCapture] SIP participant: ${sipParticipant.participantIdentity}`)

      // Wait for the greeting to play (+ buffer)
      await sleep(CAPTURE_DURATION_S * 1000)

      // Hang up and stop egress
      await roomSvc.removeParticipant(roomName, sipParticipant.participantIdentity)
      await egressSvc.stopEgress(egressId)
      await sleep(3000) // brief wait for egress to finalise file

      // Build the public/signed URL for the recording
      const recordingUrl = buildS3Url(s3Path)

      // Update the analysis in Supabase with the recording URL
      const { data: sync } = await sb.from('bicom_tenant_sync')
        .select('pre_migration_analysis').eq('id', tenantSyncId).single()
      if (sync?.pre_migration_analysis) {
        const analysis = sync.pre_migration_analysis
        const ivrIndex = (analysis.ivrs || []).findIndex((i: any) => i.bicom_id === ivr.bicom_id)
        if (ivrIndex >= 0) {
          analysis.ivrs[ivrIndex].greeting_url = recordingUrl
          analysis.ivrs[ivrIndex].greeting_captured_at = new Date().toISOString()
          await sb.from('bicom_tenant_sync')
            .update({ pre_migration_analysis: analysis }).eq('id', tenantSyncId)
        }
      }

      logger.info(`[GreetingCapture] ✓ ${ivr.name} captured → ${recordingUrl}`)
      results.push({ ...base, status: 'captured', recording_url: recordingUrl, duration_s: CAPTURE_DURATION_S })

    } catch (e: any) {
      logger.error(`[GreetingCapture] Failed for ${ivr.name}: ${e.message}`)
      // Try to clean up the room
      await roomSvc.deleteRoom(roomName).catch(() => {})
      results.push({ ...base, status: 'failed', error: e.message })
    }

    // Brief pause between captures to avoid hammering the trunk
    await sleep(5000)
  }

  return results
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function buildS3Url(path: string): string {
  // Path-style URL required for Peasoup/Ceph RGW
  return `${S3_ENDPOINT}/${S3_BUCKET}/${path}`
}
