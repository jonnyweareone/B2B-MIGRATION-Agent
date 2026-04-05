import { Router, Request, Response } from 'express'
import { migrateBicomTenant } from '../services/bicom-mapper'
import { runServerHealthCheck, analyseTenant, editBicomExtension, editBicomDid } from '../services/bicom-analysis'
import { captureGreetings } from '../services/greeting-capture'
import { logger } from '../utils/logger'
import { createClient } from '@supabase/supabase-js'
import axios from 'axios'

const router = Router()

router.post('/migrate', async (req: Request, res: Response) => {
  const { tenant_sync_id, server_url, api_key, bicom_tenant_id, target_org_id } = req.body
  if (!tenant_sync_id || !server_url || !api_key || !bicom_tenant_id)
    return res.status(400).json({ error: 'Missing required fields' })
  res.json({ ok: true, status: 'in_progress', tenant_sync_id })
  migrateBicomTenant({ tenant_sync_id, server_url, api_key, bicom_tenant_id, target_org_id })
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
  const { tenant_sync_id, ivr_ids } = req.body
  if (!tenant_sync_id) return res.status(400).json({ error: 'tenant_sync_id required' })
  try {
    const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data: sync } = await sb.from('bicom_tenant_sync')
      .select('pre_migration_analysis').eq('id', tenant_sync_id).single()
    if (!sync?.pre_migration_analysis) return res.status(404).json({ error: 'No analysis found -- run analyse first' })
    const { ivrs = [], dids = [] } = sync.pre_migration_analysis
    const ivrCount = ivrs.filter((i: any) => i.greeting).length
    // Respond immediately -- capture takes ~40s per IVR
    res.json({ ok: true, status: 'capturing', ivrs_with_greetings: ivrCount, message: `Capturing ${ivr_ids?.length || ivrCount} greeting(s) -- this takes ~${(ivr_ids?.length || ivrCount) * 45}s` })
    // Run captures in background
    captureGreetings(tenant_sync_id, ivrs, dids, ivr_ids)
      .then(results => logger.info(`[GreetingCapture] Complete: ${JSON.stringify(results.map(r => ({ name: r.ivr_name, status: r.status })))}`))
      .catch(e => logger.error(`[GreetingCapture] Error: ${e.message}`))
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
