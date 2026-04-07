import axios, { AxiosInstance } from 'axios';

// Vodia REST API
// Auth: session cookie from POST /rest/system/session with MD5 password hash
// Base: https://{host}/rest/...
// Domains:    GET  /rest/system/domains
// Users:      GET  /rest/domain/{domain}/userlist/extensions
// User cfg:   GET  /rest/domain/{domain}/user_settings/{account}
// Trunks:     GET  /rest/domain/{domain}/domain_trunks/
// Dial plans: GET  /rest/domain/{domain}/dialplans/
// AAs:        GET  /rest/domain/{domain}/userlist/auto_attendants

import crypto from 'crypto';

export class VodiaClient {
  private base: string;
  private username: string;
  private password: string;
  private sessionId: string | null = null;
  private http: AxiosInstance;

  constructor(serverUrl: string, username: string, password: string) {
    this.base = serverUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.http = axios.create({ baseURL: this.base, timeout: 30000 });
  }

  async login(): Promise<void> {
    const passwordHash = crypto.createHash('md5').update(this.password).digest('hex');
    const body = JSON.stringify({ name: 'auth', value: `${this.username} ${passwordHash}` });
    const r = await this.http.put('/rest/system/session', body, {
      headers: { 'Content-Type': 'application/json' },
      maxRedirects: 0,
      validateStatus: s => s < 400,
    });
    // Session ID returned in body or Set-Cookie header
    const setCookie = r.headers['set-cookie'];
    if (setCookie) {
      const match = Array.isArray(setCookie)
        ? setCookie.join('; ').match(/session=([^;]+)/)
        : setCookie.match(/session=([^;]+)/);
      if (match) { this.sessionId = match[1]; return; }
    }
    // Some versions return session ID directly in body
    const bodyStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    const bodyMatch = bodyStr.match(/"?([a-zA-Z0-9]{10,30})"?/);
    if (bodyMatch) { this.sessionId = bodyMatch[1]; return; }
    throw new Error('Vodia login failed — no session ID received');
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.sessionId) await this.login();
    const r = await this.http.get<T>(path, {
      headers: { Cookie: `session=${this.sessionId}` },
    });
    return r.data;
  }

  async ping(): Promise<boolean> {
    await this.login();
    return true;
  }

  // ── System ──────────────────────────────────────────────────────────────────
  async getDomainInfo(): Promise<any> {
    return this.get('/rest/system/domaininfo');
  }

  // ── Domains (tenants) ────────────────────────────────────────────────────────
  async listDomains(): Promise<any[]> {
    const data = await this.get<any>('/rest/system/domains');
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') return Object.values(data);
    return [];
  }

  async getDomainSettings(domain: string): Promise<any> {
    return this.get(`/rest/domain/${domain}/settings`);
  }

  // ── Accounts / Users ─────────────────────────────────────────────────────────
  // type: extensions | auto_attendants | acd | vmgroups | agents | ivr
  async listAccounts(domain: string, type: string = 'extensions'): Promise<any[]> {
    const data = await this.get<any>(`/rest/domain/${domain}/userlist/${type}`);
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') return Object.values(data);
    return [];
  }

  async getUserSettings(domain: string, account: string): Promise<any> {
    return this.get(`/rest/domain/${domain}/user_settings/${account}`);
  }

  // ── Trunks ───────────────────────────────────────────────────────────────────
  async listTrunks(domain: string): Promise<any[]> {
    const data = await this.get<any>(`/rest/domain/${domain}/domain_trunks/`);
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') return Object.values(data);
    return [];
  }

  async getTrunkSettings(domain: string, trunkId: string): Promise<any> {
    return this.get(`/rest/domain/${domain}/edit_trunk/${trunkId}`);
  }

  // ── Dial plans ────────────────────────────────────────────────────────────────
  async listDialplans(domain: string): Promise<any[]> {
    const data = await this.get<any>(`/rest/domain/${domain}/dialplans/`);
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') return Object.values(data);
    return [];
  }

  async getDialplanSettings(domain: string, dpId: string): Promise<any> {
    return this.get(`/rest/domain/${domain}/edit_dialplan/${dpId}`);
  }

  // ── Address book ─────────────────────────────────────────────────────────────
  async getAddressBook(domain: string): Promise<any[]> {
    const data = await this.get<any>(`/rest/domain/${domain}/adrbook/`);
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') return Object.values(data);
    return [];
  }

  // ── ACD queues ────────────────────────────────────────────────────────────────
  async listQueues(domain: string): Promise<any[]> {
    return this.listAccounts(domain, 'acd');
  }

  async getQueueSettings(domain: string, account: string): Promise<any> {
    return this.getUserSettings(domain, account);
  }

  // ── Auto attendants (IVRs) ────────────────────────────────────────────────────
  async listAutoAttendants(domain: string): Promise<any[]> {
    return this.listAccounts(domain, 'auto_attendants');
  }

  async getAutoAttendantSettings(domain: string, account: string): Promise<any> {
    return this.getUserSettings(domain, account);
  }
}
