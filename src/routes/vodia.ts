import { Router, Request, Response } from 'express'
import { migrateVodiaDomain, analyseVodiaDomain } from '../services/vodia-mapper'
import { VodiaClient } from '../services/vodia-client'
import { logger } from '../utils/logger'
import { createClient } from '@supabase/supabase-js'

const router = Router()

// POST /vodia/health-check — verify credentials and connectivity
router.post('/health-check', async (req: Request, res: Response) => {
  const { server_url, username, password } = req.body
  if (!server_url || !username || !password)
    return res.status(400).json({ error: 'Missing server_url, username or password' })
  try {
    const client = new VodiaClient(server_url, username, password)
    await client.login()
    const domainInfo = await client.getDomainInfo()
    const domains = await client.listDomains()
    res.json({ ok: true, status: 'healthy', domain_count: domains.length, server_info: domainInfo })
  } catch (e: any) {
    res.status(500).json({ ok: false, status: 'error', error: e.message })
  }
})

// GET /vodia/domains — list all domains on a Vodia server
router.post('/domains', async (req: Request, res: Response) => {
  const { server_url, username, password, server_id } = req.body
  if (!server_url || !username || !password)
    return res.status(400).json({ error: 'Missing server_url, username or password' })
  try {
    const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const client = new VodiaClient(server_url, username, password)
    await client.login()
    const domains = await client.listDomains()

    // Upsert into vodia_tenant_sync if server_id provided
    if (server_id && domains.length > 0) {
      const rows = domains.map((d: any) => ({
        server_id,
        vodia_domain: d.domain || d.name || d,
        vodia_domain_name: d.name || d.domain || d,
        status: 'discovered',
      }))
      await sb.from('vodia_tenant_sync').upsert(rows, {
        onConflict: 'server_id,vodia_domain', ignoreDuplicates: false,
      })
    }

    res.json({ ok: true, count: domains.length, domains })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /vodia/analyse — pre-migration scan, no writes to SONIQ
router.post('/analyse', async (req: Request, res: Response) => {
  const { tenant_sync_id, server_url, username, password, vodia_domain } = req.body
  if (!tenant_sync_id || !server_url || !username || !password || !vodia_domain)
    return res.status(400).json({ error: 'Missing required fields: tenant_sync_id, server_url, username, password, vodia_domain' })
  try {
    const analysis = await analyseVodiaDomain(tenant_sync_id, server_url, username, password, vodia_domain)
    res.json({ ok: true, analysis })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /vodia/migrate — run the full migration
router.post('/migrate', async (req: Request, res: Response) => {
  const { tenant_sync_id, server_url, username, password, vodia_domain, target_org_id, dry_run } = req.body
  if (!tenant_sync_id || !server_url || !username || !password || !vodia_domain || !target_org_id)
    return res.status(400).json({ error: 'Missing required fields: tenant_sync_id, server_url, username, password, vodia_domain, target_org_id' })

  // Respond immediately, run async
  res.json({ ok: true, status: dry_run ? 'dry_run_started' : 'in_progress', tenant_sync_id })

  migrateVodiaDomain({ tenant_sync_id, server_url, username, password, vodia_domain, target_org_id, dry_run: !!dry_run })
    .catch(e => logger.error(`[Vodia] Migration failed: ${e.message}`))
})

export default router
