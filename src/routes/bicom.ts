import { Router, Request, Response } from 'express'
import { migrateBicomTenant } from '../services/bicom-mapper'
import { runServerHealthCheck, analyseTenant, editBicomExtension, editBicomDid } from '../services/bicom-analysis'
import { captureGreetings } from '../services/greeting-capture'
import { logger } from '../utils/logger'
import { createClient } from '@supabase/supabase-js'
import axios from 'axios'

const router = Router()

router.post('/migrate', async (req: Request, res: Response) => {
  const { tenant_sync_id, server_url, api_key, bicom_tenant_id, target_org_id, dry_run } = req.body
  if (!tenant_sync_id || !server_url || !api_key || !bicom_tenant_id || !target_org_id)
    return res.status(400).json({ error: 'Missing required fields (tenant_sync_id, server_url, api_key, bicom_tenant_id, target_org_id)' })
  res.json({ ok: true, status: dry_run ? 'dry_run_started' : 'in_progress', tenant_sync_id })
  migrateBicomTenant({ tenant_sync_id, server_url, api_key, bicom_tenant_id, target_org_id, dry_run: !!dry_run })
    .catch(e => logger.error(`[BiCom] Migration failed: ${e.message}`))
})

router.post('/health-check', async (req: Request, res: Response) => {
  const { server_url, api_key } = req.body
  if (!server_url || !api_key) return res.status(400).json({ error: 'Missing server_url or api_key' })
  try {
    const result = await runServerHealthCheck(server_url, api_key)
    res.json({ ok: result.status === 'healthy', ...result })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/analyse', async (req: Request, res: Response) => {
  const { tenant_sync_id, server_url, api_key, bicom_tenant_id } = req.body
  if (!tenant_sync_id || !server_url || !api_key || !bicom_tenant_id)
    return res.status(400).json({ error: 'Missing required fields' })
  try {
    const analysis = await analyseTenant(tenant_sync_id, server_url, api_key, bicom_tenant_id)
    res.json({ ok: true, analysis })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/ext/edit', async (req: Request, res: Response) => {
  const { server_url, api_key, tenant_id, ext_id, fields } = req.body
  if (!server_url || !api_key || !tenant_id || !ext_id || !fields)
    return res.status(400).json({ error: 'Missing required fields' })
  try {
    const result = await editBicomExtension(server_url, api_key, tenant_id, ext_id, fields)
    res.json({ ok: true, result })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/did/edit', async (req: Request, res: Response) => {
  const { server_url, api_key, tenant_id, did_id, fields } = req.body
  if (!server_url || !api_key || !tenant_id || !did_id || !fields)
    return res.status(400).json({ error: 'Missing required fields' })
  try {
    const result = await editBicomDid(server_url, api_key, tenant_id, did_id, fields)
    res.json({ ok: true, result })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.get('/tenants', async (req: Request, res: Response) => {
  const { server_id, server_url, api_key } = req.query as Record<string, string>
  if (!server_id || !server_url || !api_key) return res.status(400).json({ error: 'Missing params' })
  try {
    const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data: srv } = await sb.from('bicom_servers').select('id').eq('id', server_id).single()
    if (!srv) return res.status(404).json({ error: 'Server not found' })
    const r = await axios.get(`${server_url.replace(/\/$/, '')}/index.php`, {
      params: { apikey: api_key, action: 'pbxware.tenant.list', server: '1' }, timeout: 30000,
    })
    const tenants = Object.entries(r.data as Record<string, any>).map(([id, t]) => ({
      server_id, bicom_tenant_id: id, bicom_tenant_name: (t as any).name?.trim() || `Tenant ${id}`,
    }))
    await sb.from('bicom_tenant_sync').upsert(tenants, { onConflict: 'server_id,bicom_tenant_id', ignoreDuplicates: false })
    await sb.from('bicom_servers').update({ tenant_count: tenants.length, last_synced_at: new Date().toISOString() }).eq('id', srv.id)
    res.json({ ok: true, count: tenants.length })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /bicom/capture-greetings -- place outbound calls to capture IVR greeting audio
router.post('/capture-greetings', async (req: Request, res: Response) => {
  const { tenant_sync_id, server_url, api_key, bicom_tenant_id, ivr_ids, capture_ddi } = req.body
  if (!tenant_sync_id) return res.status(400).json({ error: 'tenant_sync_id required' })
  try {
    const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data: sync } = await sb.from('bicom_tenant_sync')
      .select('pre_migration_analysis, server_id')
      .eq('id', tenant_sync_id).single()
    if (!sync?.pre_migration_analysis) return res.status(404).json({ error: 'No analysis found -- run analyse first' })

    // Get server creds if not provided directly
    let sUrl = server_url, sKey = api_key, sTenantId = bicom_tenant_id
    if (!sUrl && sync.server_id) {
      const { data: srv } = await sb.from('bicom_servers').select('server_url,api_key').eq('id', sync.server_id).single()
      if (srv) { sUrl = srv.server_url; sKey = srv.api_key }
    }
    if (!sUrl || !sKey) return res.status(400).json({ error: 'server_url and api_key required (or ensure server is linked to tenant sync)' })
    if (!sTenantId) {
      const { data: ts } = await sb.from('bicom_tenant_sync').select('bicom_tenant_id').eq('id', tenant_sync_id).single()
      if (ts) sTenantId = ts.bicom_tenant_id
    }
    if (!sTenantId) return res.status(400).json({ error: 'bicom_tenant_id required' })

    const { ivrs = [], dids = [] } = sync.pre_migration_analysis
    const ivrCount = (ivr_ids ? ivrs.filter((i: any) => ivr_ids.includes(i.bicom_id)) : ivrs).filter((i: any) => i.greeting).length
    const etaSecs = ivrCount * 50

    // Respond immediately — capture is async
    res.json({ ok: true, status: 'capturing', ivrs_with_greetings: ivrCount, eta_seconds: etaSecs, capture_ddi: capture_ddi || null })

    // Run captures in background
    captureGreetings(tenant_sync_id, sUrl, sKey, sTenantId, ivrs, dids, capture_ddi || null, ivr_ids)
      .then(r => logger.info(`[GreetingCapture] Done: ${JSON.stringify(r.map(x => ({ name: x.ivr_name, status: x.status, redirected: x.ddi_redirected })))}`))
      .catch(e => logger.error(`[GreetingCapture] Error: ${e.message}`))
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ─── CDR History Import ────────────────────────────────────────────────────
router.post('/import-cdrs', async (req, res) => {
  try {
    const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { tenant_sync_id, months_back = 12, dry_run = false } = req.body
    if (!tenant_sync_id) return res.status(400).json({ error: 'tenant_sync_id required' })

    // Load sync row to get server creds + org
    const { data: sync } = await sb
      .from('bicom_tenant_sync')
      .select('id, bicom_tenant_id, soniq_org_id, server_id, bicom_servers(server_url, api_key)')
      .eq('id', tenant_sync_id)
      .single()
    if (!sync) return res.status(404).json({ error: 'tenant_sync not found' })

    const sUrl     = (sync as any).bicom_servers?.server_url
    const sKey     = (sync as any).bicom_servers?.api_key
    const tenantId = sync.bicom_tenant_id
    const orgId    = (sync as any).soniq_org_id

    if (!sUrl || !sKey) return res.status(400).json({ error: 'No server credentials linked to this tenant sync' })
    if (!tenantId)      return res.status(400).json({ error: 'bicom_tenant_id missing on sync row' })
    if (!orgId)         return res.status(400).json({ error: 'soniq_org_id missing on sync row' })

    // Respond immediately, run in background
    res.json({ ok: true, status: 'importing', tenant_sync_id, months_back, dry_run })

    const { importBicomCdrs } = await import('../services/bicom-cdr-import')
    importBicomCdrs({ tenant_sync_id, server_url: sUrl, api_key: sKey, bicom_tenant_id: tenantId, soniq_org_id: orgId, months_back, dry_run })
      .then(r => logger.info(`[CDR] Import complete: ${JSON.stringify(r)}`))
      .catch(e => logger.error(`[CDR] Import error: ${e.message}`))

  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
