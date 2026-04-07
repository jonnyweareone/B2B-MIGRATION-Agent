import axios, { AxiosInstance } from 'axios';

// Vodia REST API — Basic auth
// Requires: admin account with "API access" set to Enabled in Vodia admin UI
// Base: https://{host}/rest/...
// Domains:    GET  /rest/system/domains
// Users:      GET  /rest/domain/{domain}/userlist/extensions
// User cfg:   GET  /rest/domain/{domain}/user_settings/{account}
// Trunks:     GET  /rest/domain/{domain}/domain_trunks/
// Dial plans: GET  /rest/domain/{domain}/dialplans/
// AAs:        GET  /rest/domain/{domain}/userlist/auto_attendants

export class VodiaClient {
  private base: string;
  private http: AxiosInstance;

  constructor(serverUrl: string, username: string, password: string) {
    this.base = serverUrl.replace(/\/$/, '');
    const basicAuth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    this.http = axios.create({
      baseURL: this.base,
      timeout: 30000,
      headers: { Authorization: basicAuth },
      // Allow self-signed certs on local/test instances
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false,
        secureOptions: require('constants').SSL_OP_LEGACY_SERVER_CONNECT,
      }),
    });
  }

  async login(): Promise<void> {
    // Verify connectivity — Basic auth, no session needed
    await this.get('/rest/system/session');
  }

  private async get<T>(path: string): Promise<T> {
    const r = await this.http.get<T>(path);
    return r.data;
  }

  async ping(): Promise<boolean> {
    await this.get('/rest/system/session');
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
    // Vodia returns { action: 'domain-list', accounts: [...] }
    if (data && data.accounts && Array.isArray(data.accounts)) return data.accounts;
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
