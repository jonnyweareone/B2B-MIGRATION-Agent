import { Router, Request, Response } from 'express'
import { migrateBicomTenant } from '../services/bicom-mapper'
import { runServerHealthCheck, analyseTenant } from '../services/bicom-analysis'
import { logger } from '../utils/logger'

const router = Router()

// POST /bicom/migrate — called by Vercel /api/bicom/migrate
router.post('/migrate', async (req: Request, res: Response) => {
  const { tenant_sync_id, server_url, api_key, bicom_tenant_id, target_org_id } = req.body

  if (!tenant_sync_id || !server_url || !api_key || !bicom_tenant_id) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  // Respond immediately — migration runs async
  res.json({ ok: true, status: 'in_progress', tenant_sync_id })

  // Run migration in background
  migrateBicomTenant({
    tenant_sync_id,
    server_url,
    api_key,
    bicom_tenant_id,
    target_org_id: target_org_id || process.env.DEFAULT_SONIQ_ORG_ID || 'a0000000-0000-0000-0000-000000000000',
  }).catch(e => logger.error(`[BiCom] Background migration failed: ${e.message}`))
})

// GET /bicom/servers — list from Supabase
router.get('/servers', async (_req: Request, res: Response) => {
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data, error } = await sb.from('bicom_servers').select('*').eq('is_active', true).order('name')
    if (error) throw error
    res.json(data || [])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /bicom/servers — add server
router.post('/servers', async (req: Request, res: Response) => {
  try {
    const { name, server_url, api_key, partner_id, org_id } = req.body
    if (!name || !server_url || !api_key) return res.status(400).json({ error: 'name, server_url, api_key required' })

    // Test connectivity first
    const testUrl = `${server_url.replace(/\/$/, '')}/index.php`
    const axios = (await import('axios')).default
    const r = await axios.get(testUrl, { params: { apikey: api_key, action: 'pbxware.tenant.list' }, timeout: 10000 })
    if (r.data?.error) throw new Error(`BiCom API error: ${r.data.error}`)

    const tenantCount = typeof r.data === 'object' ? Object.keys(r.data).length : 0

    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data, error } = await sb.from('bicom_servers').insert({
      name, server_url: server_url.replace(/\/$/, ''), api_key,
      partner_id: partner_id || null,
      org_id: org_id || null,
      is_active: true,
      tenant_count: tenantCount,
    }).select().single()
    if (error) throw error
    res.json(data)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET /bicom/tenants — list from Supabase
router.get('/tenants', async (req: Request, res: Response) => {
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    let query = sb.from('bicom_tenant_sync').select('*, bicom_servers(id, name)').order('bicom_tenant_name')
    if (req.query.server_id) query = query.eq('server_id', req.query.server_id as string)
    if (req.query.status) query = query.eq('status', req.query.status as string)
    const { data, error } = await query
    if (error) throw error
    res.json(data || [])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /bicom/servers/:id/discover — pull tenants from BiCom into Supabase
router.post('/servers/:id/discover', async (req: Request, res: Response) => {
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data: srv, error: srvErr } = await sb.from('bicom_servers').select('*').eq('id', req.params.id).single()
    if (srvErr || !srv) return res.status(404).json({ error: 'Server not found' })

    const axios = (await import('axios')).default
    const r = await axios.get(`${srv.server_url}/index.php`, {
      params: { apikey: srv.api_key, action: 'pbxware.tenant.list' }, timeout: 15000,
    })
    const data = r.data
    if (!data || data.error) throw new Error(data?.error || 'No data')

    const tenants = Object.entries(data).map(([id, t]: [string, any]) => ({
      server_id: srv.id,
      bicom_tenant_id: id,
      bicom_tenant_name: t.name?.trim() || `Tenant ${id}`,
    }))

    const { error: upsertErr } = await sb.from('bicom_tenant_sync').upsert(tenants, {
      onConflict: 'server_id,bicom_tenant_id', ignoreDuplicates: false,
    })
    if (upsertErr) throw upsertErr

    await sb.from('bicom_servers').update({
      tenant_count: tenants.length, last_synced_at: new Date().toISOString(),
    }).eq('id', srv.id)

    res.json({ ok: true, count: tenants.length })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /bicom/health-check — run server health check, store results
router.post('/health-check', async (req: Request, res: Response) => {
  const { server_url, api_key } = req.body
  if (!server_url || !api_key) return res.status(400).json({ error: 'Missing server_url or api_key' })
  try {
    const result = await runServerHealthCheck(server_url, api_key, '1')
    res.json({ ok: result.status === 'healthy', ...result })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /bicom/analyse — pre-migration tenant analysis (email issues, UADs, counts etc)
router.post('/analyse', async (req: Request, res: Response) => {
  const { tenant_sync_id, server_url, api_key, bicom_tenant_id } = req.body
  if (!tenant_sync_id || !server_url || !api_key || !bicom_tenant_id) {
    return res.status(400).json({ error: 'Missing required fields' })
  }
  try {
    const analysis = await analyseTenant(tenant_sync_id, server_url, api_key, bicom_tenant_id)
    res.json({ ok: true, analysis })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
