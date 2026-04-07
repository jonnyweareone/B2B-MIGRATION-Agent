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
  total_inserted: number
  total_skipped: number
  date_from: string
  date_to: string
  pages: number
  error?: string
}

const STATUS_MAP: Record<string, string> = {
  'Answered':  'completed',
  'No Answer': 'missed',
  'Busy':      'missed',
  'Failed':    'error',
  'Cancelled': 'cancelled',
}

const DIRECTION_MAP: Record<string, string> = {
  'Local':    'internal',
  'Inbound':  'inbound',
  'Outbound': 'outbound',
}

function formatBicomDate(d: Date): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[d.getMonth()]}-${String(d.getDate()).padStart(2,'0')}-${d.getFullYear()}`
}

async function fetchCdrPage(
  serverUrl: string,
  apiKey: string,
  tenantId: string,
  startStr: string,
  endStr: string,
  page: number,
): Promise<{ rows: any[][], headers: string[], hasMore: boolean }> {
  const r = await axios.get(`${serverUrl.replace(/\/$/, '')}/index.php`, {
    params: {
      apikey:    apiKey,
      action:    'pbxware.cdr.download.csv',
      server:    tenantId,
      start:     startStr,
      starttime: '00:00:00',
      end:       endStr,
      endtime:   '23:59:59',
      limit:     1000,
      page,
    },
    timeout: 60000,
  })
  const d = r.data
  if (d?.error) throw new Error(`BiCom CDR API error: ${d.error}`)
  return {
    rows:    d.csv    || [],
    headers: d.header || [],
    hasMore: d.next_page === true || d.next_page === 'true' || d.next_page === 1,
  }
}

export async function importBicomCdrs(params: CdrImportParams): Promise<CdrImportResult> {
  const {
    tenant_sync_id, server_url, api_key, bicom_tenant_id,
    soniq_org_id, months_back = 12, dry_run = false,
  } = params

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

  let totalFetched = 0
  let pageNum = 1
  let hasMore = true
  let headers: string[] = []

  try {
    while (hasMore) {
      const { rows, headers: h, hasMore: more } = await fetchCdrPage(
        server_url, api_key, bicom_tenant_id, startStr, endStr, pageNum,
      )
      if (pageNum === 1) headers = h
      hasMore = more
      if (rows.length === 0) break
      totalFetched += rows.length

      const idx = (name: string) => headers.indexOf(name)
      const iFrom      = idx('From')
      const iTo        = idx('To')
      const iDateTime  = idx('Date/Time')
      const iDuration  = idx('Total Duration')
      const iType      = idx('Location Type')
      const iStatus    = idx('Status')
      const iUniqueId  = idx('Unique ID')
      const iMos       = idx('MOS')
      const iRecording = idx('Recording Available')

      if (!dry_run) {
        const records = rows.map(row => {
          const uniqueId     = String(row[iUniqueId] || '')
          const unixTs       = parseInt(String(row[iDateTime] || '0'))
          const startedAt    = unixTs > 0 ? new Date(unixTs * 1000).toISOString() : null
          const durationSecs = parseInt(String(row[iDuration] || '0'))
          const status       = STATUS_MAP[String(row[iStatus])] || 'unknown'
          const direction    = DIRECTION_MAP[String(row[iType])] || 'inbound'
          const mosRaw       = row[iMos]
          const mos          = mosRaw !== '' && mosRaw != null ? parseFloat(String(mosRaw)) : null

          // duration_seconds + ring_duration_seconds are GENERATED columns — never insert them.
          // duration_seconds = ended_at - answered_at
          // ring_duration_seconds = answered_at - started_at
          // For BiCom: Total Duration = talk time (from answer). So:
          //   answered_at = started_at  (ring time not available from BiCom CDR)
          //   ended_at    = answered_at + duration
          const answered  = status === 'completed' && durationSecs > 0
          const answeredAt = answered && startedAt ? startedAt : null
          const endedAt    = answeredAt
            ? new Date(new Date(answeredAt).getTime() + durationSecs * 1000).toISOString()
            : null

          return {
            org_id:              soniq_org_id,
            source:              'bicom_import',
            source_id:           uniqueId,
            bicom_tenant_id,
            direction,
            status,
            caller_number:       String(row[iFrom] || ''),
            callee_number:       String(row[iTo]   || ''),
            started_at:          startedAt,
            answered_at:         answeredAt,
            ended_at:            endedAt,
            mos_score:           mos,
            recording_available: String(row[iRecording]) === 'True',
          }
        })

        // Upsert in batches of 200
        for (let i = 0; i < records.length; i += 200) {
          const batch = records.slice(i, i + 200)
          const { error } = await sb
            .from('call_logs')
            .upsert(batch, { onConflict: 'org_id,source_id', ignoreDuplicates: true })
          if (error) logger.warn(`[CDR] Batch error page ${pageNum} batch ${i}: ${error.message}`)
        }
      }

      logger.info(`[CDR] Page ${pageNum}: ${rows.length} rows | total fetched: ${totalFetched}`)
      pageNum++
      if (pageNum > 200) { logger.warn('[CDR] Safety cap: 200 pages reached'); hasMore = false }
    }

    // Get actual count from DB (ignoreDuplicates suppresses return rows)
    const { count } = await sb
      .from('call_logs')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', soniq_org_id)
      .eq('source', 'bicom_import')
    const totalInserted = count ?? 0

    await sb.from('bicom_tenant_sync').update({
      cdr_import_status:       'complete',
      cdr_import_count:        totalInserted,
      cdr_import_date_from:    dateFrom.toISOString(),
      cdr_import_date_to:      dateTo.toISOString(),
      cdr_import_completed_at: new Date().toISOString(),
    }).eq('id', tenant_sync_id)

    logger.info(`[CDR] Done: ${totalInserted} in DB, ${totalFetched} fetched, ${pageNum - 1} pages`)
    return {
      status: 'complete',
      total_fetched: totalFetched,
      total_inserted: totalInserted,
      total_skipped: Math.max(0, totalFetched - totalInserted),
      date_from: dateFrom.toISOString(),
      date_to: dateTo.toISOString(),
      pages: pageNum - 1,
    }

  } catch (e: any) {
    logger.error(`[CDR] Import failed: ${e.message}`)
    await sb.from('bicom_tenant_sync').update({
      cdr_import_status: 'error',
    }).eq('id', tenant_sync_id)
    return {
      status: 'error',
      total_fetched: totalFetched,
      total_inserted: 0,
      total_skipped: 0,
      date_from: dateFrom.toISOString(),
      date_to: dateTo.toISOString(),
      pages: pageNum - 1,
      error: e.message,
    }
  }
}
