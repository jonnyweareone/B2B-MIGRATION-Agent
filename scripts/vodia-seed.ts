#!/usr/bin/env tsx
/**
 * Vodia Test Data Seeder
 * Seeds two test tenants on a fresh Vodia AWS instance.
 * Usage: VODIA_URL=https://your-vodia.aws.com VODIA_USER=admin VODIA_PASS=xxx tsx scripts/vodia-seed.ts
 */
import axios from 'axios'
import crypto from 'crypto'

const VODIA_URL  = process.env.VODIA_URL  || 'http://localhost:8080'
const VODIA_USER = process.env.VODIA_USER || 'admin'
const VODIA_PASS = process.env.VODIA_PASS || 'admin'

class VodiaSeeder {
  private http: any
  private sessionId: string | null = null
  constructor() { this.http = axios.create({ baseURL: VODIA_URL, timeout: 15000 }) }

  async login() {
    const hash = crypto.createHash('md5').update(VODIA_PASS).digest('hex')
    const r = await this.http.put('/rest/system/session', JSON.stringify({ name: 'auth', value: `${VODIA_USER} ${hash}` }), {
      headers: { 'Content-Type': 'application/json' }, maxRedirects: 0, validateStatus: (s: number) => s < 400,
    })
    const setCookie = r.headers['set-cookie']
    if (setCookie) {
      const str = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie
      const m = str.match(/session=([^;]+)/)
      if (m) { this.sessionId = m[1]; return }
    }
    const bodyStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data)
    const m = bodyStr.match(/"?([a-zA-Z0-9]{10,30})"?/)
    if (m) { this.sessionId = m[1]; return }
    throw new Error(`Login failed: ${JSON.stringify(r.data)}`)
  }

  private h() { return { Cookie: `session=${this.sessionId}`, 'Content-Type': 'application/json' } }

  async put(path: string, data: any) {
    const r = await this.http.put(path, JSON.stringify(data), { headers: this.h(), validateStatus: (s: number) => s < 500 })
    return r.data
  }

  async get(path: string) {
    const r = await this.http.get(path, { headers: this.h() })
    return r.data
  }

  async createDomain(domain: string, settings: any) {
    await this.put('/rest/system/domains', { domain, ...settings })
    console.log(`  ✓ Domain: ${domain}`)
  }

  async createAccount(domain: string, ext: string, type: string, data: any) {
    await this.put(`/rest/domain/${domain}/addacc/${ext}`, { type, account_ext: ext, ...data })
    if (data.settings) await this.put(`/rest/domain/${domain}/user_settings/${ext}`, data.settings)
  }

  async createTrunk(domain: string, data: any) {
    await this.put(`/rest/domain/${domain}/domain_trunks/`, { name: data.name, aadr: data.address, reg_account: data.account, reg_pass: data.password })
    console.log(`    ✓ Trunk: ${data.name}`)
  }

  async createDialplan(domain: string, name: string) {
    await this.put(`/rest/domain/${domain}/dialplans/`, { name })
    console.log(`    ✓ Dial plan: ${name}`)
  }

  async listAccounts(domain: string, type = 'extensions') { return this.get(`/rest/domain/${domain}/userlist/${type}`) }
  async listDomains() { return this.get('/rest/system/domains') }
}

const TENANTS = [
  {
    domain: 'acme-solicitors.test', name: 'Acme Solicitors',
    extensions: [
      { ext: '101', first_name: 'Sarah',   last_name: 'Johnson',  email: 'sarah.johnson@acmesolicitors.test',  settings: { ani: '01202100101', dnd: 'false' } },
      { ext: '102', first_name: 'Michael', last_name: 'Chen',     email: 'michael.chen@acmesolicitors.test',   settings: { ani: '01202100102', dnd: 'false' } },
      { ext: '103', first_name: 'Emma',    last_name: 'Williams', email: 'emma.williams@acmesolicitors.test',  settings: { ani: '01202100103', dnd: 'false' } },
      { ext: '104', first_name: 'James',   last_name: 'Patel',    email: 'james.patel@acmesolicitors.test',    settings: { ani: '01202100104', cfa: '103'   } },
      { ext: '105', first_name: 'Lucy',    last_name: 'Thompson', email: 'lucy.thompson@acmesolicitors.test',  settings: { ani: '01202100105', dnd: 'false' } },
    ],
    autoAttendants: [{ ext: '900', name: 'Acme Main Menu',      settings: { key_1: '101', key_2: '103', key_3: '800', key_0: '101', timeout: '10', operator: '101' } }],
    queues:         [{ ext: '800', name: 'New Enquiries',        settings: { timeout: '30', max_wait_time: '300', ring_strategy: 'simultaneous' } }],
    trunk: { name: 'Acme PSTN Trunk',       address: 'sip.test-carrier.co.uk', account: 'acme-test-01',    password: 'AcmeT3st2026!'    },
  },
  {
    domain: 'city-motors.test', name: 'City Motors Group',
    extensions: [
      { ext: '201', first_name: 'David',  last_name: 'Harris',   email: 'david.harris@citymotors.test',  settings: { ani: '01179200201', dnd: 'false' } },
      { ext: '202', first_name: 'Rachel', last_name: 'Foster',   email: 'rachel.foster@citymotors.test', settings: { ani: '01179200202', dnd: 'false' } },
      { ext: '203', first_name: 'Tom',    last_name: 'Mitchell', email: 'tom.mitchell@citymotors.test',  settings: { ani: '01179200203', dnd: 'false' } },
      { ext: '204', first_name: 'Priya',  last_name: 'Kumar',    email: 'priya.kumar@citymotors.test',   settings: { ani: '01179200204', dnd: 'false' } },
      { ext: '205', first_name: 'Craig',  last_name: 'Stewart',  email: '',                              settings: { ani: '01179200205' } },
      { ext: '206', first_name: 'Nicky',  last_name: 'Walsh',    email: 'nicky.walsh@citymotors.test',   settings: { ani: '01179200206', dnd: 'false' } },
      { ext: '207', first_name: 'Sales',  last_name: 'Team',     email: 'info@citymotors.test',          settings: { ani: '01179200207' } },
    ],
    autoAttendants: [{ ext: '900', name: 'City Motors Welcome',  settings: { key_1: '850', key_2: '860', key_3: '201', key_0: '202', timeout: '8',  operator: '202' } }],
    queues: [
      { ext: '850', name: 'Sales Enquiries',  settings: { timeout: '25', max_wait_time: '180', ring_strategy: 'sequential'   } },
      { ext: '860', name: 'Service Bookings', settings: { timeout: '20', max_wait_time: '240', ring_strategy: 'simultaneous' } },
    ],
    trunk: { name: 'City Motors PSTN Trunk', address: 'sip.test-carrier.co.uk', account: 'citymotors-01', password: 'CityM0t0rs2026!' },
  },
]

async function main() {
  console.log(`\n🚀 Vodia Seeder  →  ${VODIA_URL}\n`)
  const s = new VodiaSeeder()
  await s.login()
  console.log('🔐 Authenticated\n')
  console.log('Existing domains:', JSON.stringify(await s.listDomains()), '\n')

  for (const t of TENANTS) {
    console.log(`\n🏢 ${t.name}  (${t.domain})`)
    try { await s.createDomain(t.domain, { name: t.name, country_code: '44', time_zone: 'Europe/London', language: 'en' }) }
    catch (e: any) { console.log(`  ⚠️  Domain (may exist): ${e.message}`) }

    console.log('  Extensions:')
    for (const ext of t.extensions) {
      try {
        await s.createAccount(t.domain, ext.ext, 'extensions', ext)
        console.log(`    ✓ ${ext.ext}: ${ext.first_name} ${ext.last_name}${!ext.email ? ' [no email — tests dummy path]' : ''}`)
        await new Promise(r => setTimeout(r, 250))
      } catch (e: any) { console.log(`    ⚠️  ${ext.ext}: ${e.message}`) }
    }

    console.log('  Auto Attendants:')
    for (const aa of t.autoAttendants) {
      try { await s.createAccount(t.domain, aa.ext, 'auto_attendants', aa); console.log(`    ✓ ${aa.ext}: ${aa.name}`) }
      catch (e: any) { console.log(`    ⚠️  AA ${aa.ext}: ${e.message}`) }
    }

    console.log('  ACD Queues:')
    for (const q of t.queues) {
      try { await s.createAccount(t.domain, q.ext, 'acd', q); console.log(`    ✓ ${q.ext}: ${q.name}`) }
      catch (e: any) { console.log(`    ⚠️  Queue ${q.ext}: ${e.message}`) }
    }

    try { await s.createTrunk(t.domain, t.trunk) } catch (e: any) { console.log(`    ⚠️  Trunk: ${e.message}`) }
    try { await s.createDialplan(t.domain, 'Inbound DID Routing') } catch (e: any) { console.log(`    ⚠️  Dialplan: ${e.message}`) }

    const count = (d: any) => Array.isArray(d) ? d.length : Object.keys(d || {}).length
    const [exts, aas, acds] = await Promise.all([
      s.listAccounts(t.domain, 'extensions').catch(() => []),
      s.listAccounts(t.domain, 'auto_attendants').catch(() => []),
      s.listAccounts(t.domain, 'acd').catch(() => []),
    ])
    console.log(`  → Verified: ${count(exts)} extensions, ${count(aas)} AAs, ${count(acds)} queues`)
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Done. Run migration:
   POST /vodia/health-check
   POST /vodia/analyse  (tenant_sync_id, vodia_domain, ...)
   POST /vodia/migrate  (dry_run: true then false)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)
}

main().catch(e => { console.error(`\n❌ ${e.message}`); process.exit(1) })
