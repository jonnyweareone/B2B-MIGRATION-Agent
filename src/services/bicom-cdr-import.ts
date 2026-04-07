import axios from 'axios'
import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger'

export interface CdrImportParams {
  tenant_sync_id: string
  server_url: string
  api_key: string
  bicom_tenant_id: string
  soniq_org_id: string
  months_back?: number
  dry_run?: boolean
}

export interface CdrImportResult {
  status: 'complete' | 'partial' | 'error'
  total_fetched: number
  total_calls: number
  total_inserted: number
  total_skipped: number
  date_from: string
  date_to: string
  pages: number
  error?: string
}

// ── Status / direction maps ──────────────────────────────────────────────────

const STATUS_MAP: Record<string, string> = {
  'Answered':     'completed',
  'Not Answered': 'missed',
  'No Answer':    'missed',
  'Busy':         'missed',
  'Failed':       'error',
  'Cancelled':    'cancelled',
}

const DIRECTION_MAP: Record<string, string> = {
  'Local':    'inbound',   // PSTN → DDI, treated as inbound
  'Inbound':  'inbound',
  'Outbound': 'outbound',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBicomDate(d: Date): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[d.getMonth()]}-${String(d.getDate()).padStart(2,'0')}-${d.getFullYear()}`
}

// Extension names look like "Phil (2001)" — return true if so
function isExtension(name: string): boolean {
  return /\(\d+\)/.test(name)
}

// Extract clean name and number from "Phil (2001)" → { name: "Phil", ext: "2001" }
function parseExtension(raw: string): { name: string; ext: string } | null {
  const m = raw.match(/^(.+?)\s*\((\d+)\)$/)
  if (!m) return null
  return { name: m[1].trim(), ext: m[2] }
}

interface RawRow { [key: string]: any }

// ── Core: merge BiCom CDR legs into one call record ─────────────────────────
//
// BiCom Asterisk CDR splits every call into multiple rows:
//   - PSTN inbound leg: From=external_number, To=DDI — sometimes duplicated
//   - Ring group legs:  From=IVR/Queue (3xxx), To=extension (Phil (2001))
//   - Outbound legs:    From=extension, To=PSTN number — usually one row
//
// We group by the unix-timestamp prefix of UniqueID, then build one rich record.
//
function mergeLegs(legs: RawRow[]): RawRow | null {
  if (legs.length === 0) return null

  const isExt = (r: RawRow) => isExtension(String(r['From'] || ''))

  // Separate inbound PSTN legs from internal ring/queue legs
  const pstnLegs     = legs.filter(r => !isExt(r))
  const internalLegs = legs.filter(r =>  isExt(r))

  // For outbound: From=extension, To=PSTN — no PSTN leg, internal leg is the call
  const isOutbound = pstnLegs.length === 0 && internalLegs.length > 0 &&
    !isExtension(String(internalLegs[0]['To'] || ''))

  if (isOutbound) {
    // Outbound: pick the answered leg (or longest duration)
    const sorted = [...internalLegs].sort((a, b) =>
      parseInt(String(b['Total Duration']||0)) - parseInt(String(a['Total Duration']||0))
    )
    const master = sorted[0]
    const parsed = parseExtension(String(master['From'] || ''))
    return {
      ...master,
      _direction:   'outbound',
      _caller:      parsed?.name || master['From'],
      _caller_num:  parsed?.ext  || master['From'],
      _callee:      null,
      _callee_num:  String(master['To'] || ''),
      _answered_by: parsed?.name || null,
      _ring_targets: internalLegs.map(r => String(r['To'] || '')),
    }
  }

  // Inbound: master = PSTN leg with best status/duration
  // Deduplicate exact-same UniqueIDs, then pick the one with Answered or max duration
  const uniquePstn = Array.from(
    new Map(pstnLegs.map(r => [
      `${r['Unique ID']}::${r['Status']}::${r['Total Duration']}`, r
    ])).values()
  )
  const masterPstn = uniquePstn.sort((a, b) => {
    // Prefer Answered, then longest duration
    const aAns = a['Status'] === 'Answered' ? 1 : 0
    const bAns = b['Status'] === 'Answered' ? 1 : 0
    if (bAns !== aAns) return bAns - aAns
    return parseInt(String(b['Total Duration']||0)) - parseInt(String(a['Total Duration']||0))
  })[0]

  // Who answered? — internal leg with Answered status
  const answeredLeg = internalLegs.find(r => r['Status'] === 'Answered')
  const answeredParsed = answeredLeg ? parseExtension(String(answeredLeg['To'] || '')) : null

  // Who was attempted? — all internal To targets
  const ringTargets = [...new Set(internalLegs.map(r => String(r['To'] || '')))]

  return {
    ...masterPstn,
    _direction:    'inbound',
    _caller:       null,
    _caller_num:   String(masterPstn['From'] || ''),
    _callee:       answeredParsed?.name || null,
    _callee_num:   answeredParsed?.ext  || String(masterPstn['To'] || ''),
    _answered_by:  answeredParsed?.name || null,
    _ring_targets: ringTargets,
  }
}

// ── BiCom API fetch ──────────────────────────────────────────────────────────

async function fetchCdrPage(
  serverUrl: string, apiKey: string, tenantId: string,
  startStr: string, endStr: string, page: number,
): Promise<{ rows: any[][], headers: string[], hasMore: boolean }> {
  const r = await axios.get(`${serverUrl.replace(/\/$/, '')}/index.php`, {
    params: {
      apikey: apiKey, action: 'pbxware.cdr.download.csv',
      server: tenantId, start: startStr, starttime: '00:00:00',
      end: endStr, endtime: '23:59:59', limit: 1000, page,
    },
    timeout: 60000,
  })
  const d = r.data
  if (d?.error) throw new Error(`BiCom CDR API: ${d.error}`)
  return {
    rows:    d.csv    || [],
    headers: d.header || [],
    hasMore: d.next_page === true || d.next_page === 'true' || d.next_page === 1,
  }
}

// ── Main import ──────────────────────────────────────────────────────────────

export async function importBicomCdrs(params: CdrImportParams): Promise<CdrImportResult> {
  const { tenant_sync_id, server_url, api_key, bicom_tenant_id,
          soniq_org_id, months_back = 12, dry_run = false } = params

  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  const dateTo   = new Date()
  const dateFrom = new Date()
  dateFrom.setMonth(dateFrom.getMonth() - months_back)
  const startStr = formatBicomDate(dateFrom)
  const endStr   = formatBicomDate(dateTo)

  logger.info(`[CDR] ${bicom_tenant_id} → org ${soniq_org_id} | ${startStr}→${endStr} | dry_run=${dry_run}`)

  await sb.from('bicom_tenant_sync').update({
    cdr_import_status:     'in_progress',
    cdr_import_started_at: new Date().toISOString(),
  }).eq('id', tenant_sync_id)

  // Accumulate ALL rows across pages (so we can group across page boundaries)
  const allRows:    any[][] = []
  let   allHeaders: string[] = []
  let   pageNum = 1
  let   hasMore = true

  try {
    while (hasMore) {
      const { rows, headers, hasMore: more } = await fetchCdrPage(
        server_url, api_key, bicom_tenant_id, startStr, endStr, pageNum,
      )
      if (pageNum === 1) allHeaders = headers
      hasMore = more
      if (rows.length === 0) break
      allRows.push(...rows)
      logger.info(`[CDR] Page ${pageNum}: ${rows.length} rows | total raw: ${allRows.length}`)
      pageNum++
      if (pageNum > 200) { logger.warn('[CDR] Safety cap 200 pages'); hasMore = false }
    }

    const totalFetched = allRows.length

    // Build header→index map
    const idx = (name: string) => allHeaders.indexOf(name)
    const iFrom      = idx('From')
    const iTo        = idx('To')
    const iDateTime  = idx('Date/Time')
    const iDuration  = idx('Total Duration')
    const iType      = idx('Location Type')
    const iStatus    = idx('Status')
    const iUniqueId  = idx('Unique ID')
    const iMos       = idx('MOS')
    const iRecording = idx('Recording Available')

    // Convert rows to objects
    const rawRecs: RawRow[] = allRows.map(row => ({
      'From':                 row[iFrom],
      'To':                   row[iTo],
      'Date/Time':            row[iDateTime],
      'Total Duration':       row[iDuration],
      'Location Type':        row[iType],
      'Status':               row[iStatus],
      'Unique ID':            row[iUniqueId],
      'MOS':                  row[iMos],
      'Recording Available':  row[iRecording],
    }))

    // Group by call timestamp (integer part of UniqueID)
    const groups = new Map<string, RawRow[]>()
    for (const rec of rawRecs) {
      const uid = String(rec['Unique ID'] || '')
      const key = uid.split('.')[0]  // unix timestamp = call key
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(rec)
    }

    logger.info(`[CDR] ${totalFetched} raw rows → ${groups.size} unique calls after leg merge`)

    if (!dry_run) {
      const records: any[] = []

      for (const [callKey, legs] of groups) {
        const merged = mergeLegs(legs)
        if (!merged) continue

        const unixTs       = parseInt(String(merged['Date/Time'] || '0'))
        const startedAt    = unixTs > 0 ? new Date(unixTs * 1000).toISOString() : null
        const durationSecs = parseInt(String(merged['Total Duration'] || '0'))
        const status       = STATUS_MAP[String(merged['Status'])] || 'unknown'
        const direction    = merged._direction as string
        const mos          = merged['MOS'] != null && merged['MOS'] !== '' && merged['MOS'] !== 0
          ? parseFloat(String(merged['MOS'])) : null

        // duration_seconds + ring_duration_seconds are GENERATED columns — never insert
        // Set answered_at = started_at for answered calls (BiCom duration = talk time from answer)
        const answered   = status === 'completed' && durationSecs > 0
        const answeredAt = answered && startedAt ? startedAt : null
        const endedAt    = answeredAt
          ? new Date(new Date(answeredAt).getTime() + durationSecs * 1000).toISOString()
          : null

        records.push({
          org_id:              soniq_org_id,
          source:              'bicom_import',
          source_id:           callKey,               // one record per call (by timestamp)
          bicom_tenant_id,
          direction,
          status,
          caller_number:       merged._caller_num  || null,
          caller_name:         merged._caller       || null,
          callee_number:       merged._callee_num   || null,
          callee_name:         merged._callee        || null,
          started_at:          startedAt,
          answered_at:         answeredAt,
          ended_at:            endedAt,
          mos_score:           mos,
          recording_available: String(merged['Recording Available']) === 'True',
          // Store ring targets + answered_by in notes as JSON for call history display
          notes: JSON.stringify({
            answered_by:  merged._answered_by  || null,
            ring_targets: merged._ring_targets || [],
            bicom_uid:    merged['Unique ID'],
          }),
        })
      }

      // Upsert in batches of 200
      let batchErrors = 0
      for (let i = 0; i < records.length; i += 200) {
        const batch = records.slice(i, i + 200)
        const { error } = await sb
          .from('call_logs')
          .upsert(batch, { onConflict: 'org_id,source_id', ignoreDuplicates: true })
        if (error) {
          logger.warn(`[CDR] Batch upsert error at offset ${i}: ${error.message}`)
          batchErrors++
        }
      }

      if (batchErrors > 0) logger.warn(`[CDR] ${batchErrors} batch errors during upsert`)

      // True count from DB
      const { count } = await sb
        .from('call_logs')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', soniq_org_id)
        .eq('source', 'bicom_import')
      const totalInserted = count ?? 0
      const totalSkipped  = Math.max(0, groups.size - totalInserted)

      await sb.from('bicom_tenant_sync').update({
        cdr_import_status:       'complete',
        cdr_import_count:        totalInserted,
        cdr_import_date_from:    dateFrom.toISOString(),
        cdr_import_date_to:      dateTo.toISOString(),
        cdr_import_completed_at: new Date().toISOString(),
      }).eq('id', tenant_sync_id)

      logger.info(`[CDR] Done: ${totalInserted} inserted, ${totalSkipped} skipped, ${totalFetched} raw rows, ${groups.size} calls, ${pageNum-1} pages`)

      return {
        status: 'complete',
        total_fetched: totalFetched,
        total_calls: groups.size,
        total_inserted: totalInserted,
        total_skipped: totalSkipped,
        date_from: dateFrom.toISOString(),
        date_to: dateTo.toISOString(),
        pages: pageNum - 1,
      }
    } else {
      // Dry run
      await sb.from('bicom_tenant_sync').update({
        cdr_import_status: 'complete',
        cdr_import_count: groups.size,
        cdr_import_date_from: dateFrom.toISOString(),
        cdr_import_date_to: dateTo.toISOString(),
        cdr_import_completed_at: new Date().toISOString(),
      }).eq('id', tenant_sync_id)

      return {
        status: 'complete',
        total_fetched: totalFetched,
        total_calls: groups.size,
        total_inserted: 0,
        total_skipped: 0,
        date_from: dateFrom.toISOString(),
        date_to: dateTo.toISOString(),
        pages: pageNum - 1,
      }
    }

  } catch (e: any) {
    logger.error(`[CDR] Import failed: ${e.message}`)
    await sb.from('bicom_tenant_sync').update({ cdr_import_status: 'error' }).eq('id', tenant_sync_id)
    return {
      status: 'error',
      total_fetched: allRows.length,
      total_calls: 0,
      total_inserted: 0,
      total_skipped: 0,
      date_from: dateFrom.toISOString(),
      date_to: dateTo.toISOString(),
      pages: pageNum - 1,
      error: e.message,
    }
  }
}
