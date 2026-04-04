import axios, { AxiosInstance } from 'axios';

// BiCom PBXware MT API uses /index.php?apikey=KEY&action=pbxware.ACTION&server=TENANT_ID
// NOT a REST /api/ path

export class BiComClient {
  private base: string;
  private apiKey: string;
  private http: AxiosInstance;

  constructor(serverUrl: string, apiKey: string) {
    this.base = serverUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.http = axios.create({ baseURL: this.base, timeout: 30000 });
  }

  private async request<T>(action: string, params: Record<string, any> = {}): Promise<T> {
    const r = await this.http.get<T>('/index.php', {
      params: { apikey: this.apiKey, action, ...params },
    });
    return r.data;
  }

  // Tenants — returns object keyed by server ID
  async listTenants(): Promise<any[]> {
    const data = await this.request<Record<string, any>>('pbxware.tenant.list');
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.entries(data).map(([serverId, t]: [string, any]) => ({
        id: serverId,
        server_id: serverId,
        name: t.name?.trim(),
        tenantcode: t.tenantcode,
        package: t.package,
        ext_length: t.ext_length,
        country_code: t.country_code,
      }));
    }
    return [];
  }

  async getTenant(serverId: string): Promise<any> {
    const data = await this.request<any>('pbxware.tenant.configuration', { server: serverId });
    return data;
  }

  // Extensions
  async listExtensions(serverId: string): Promise<any[]> {
    const data = await this.request<any>('pbxware.ext.list', { server: serverId });
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.entries(data).map(([id, e]: [string, any]) => ({ id, ...e }));
    }
    return Array.isArray(data) ? data : [];
  }

  async getExtension(serverId: string, extId: string): Promise<any> {
    return this.request('pbxware.ext.configuration', { server: serverId, id: extId });
  }

  // Ring groups
  async listRingGroups(serverId: string): Promise<any[]> {
    const data = await this.request<any>('pbxware.ring_group.list', { server: serverId });
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.entries(data).map(([id, r]: [string, any]) => ({ id, ...r }));
    }
    return Array.isArray(data) ? data : [];
  }

  async getRingGroup(serverId: string, groupId: string): Promise<any> {
    return this.request('pbxware.ring_group.configuration', { server: serverId, id: groupId });
  }

  // Enhanced ring groups (queues/ERGs)
  async listQueues(serverId: string): Promise<any[]> {
    const data = await this.request<any>('pbxware.erg.list', { server: serverId });
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.entries(data).map(([id, q]: [string, any]) => ({ id, ...q }));
    }
    return Array.isArray(data) ? data : [];
  }

  async getQueue(serverId: string, queueId: string): Promise<any> {
    return this.request('pbxware.erg.members', { server: serverId, id: queueId });
  }

  // IVRs
  async listIVRs(serverId: string): Promise<any[]> {
    const data = await this.request<any>('pbxware.ivr.list', { server: serverId });
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.entries(data).map(([id, i]: [string, any]) => ({ id, ...i }));
    }
    return Array.isArray(data) ? data : [];
  }

  async getIVR(serverId: string, ivrId: string): Promise<any> {
    return this.request('pbxware.ivr.edit', { server: serverId, id: ivrId });
  }

  // DIDs
  async listDIDs(serverId: string): Promise<any[]> {
    const data = await this.request<any>('pbxware.did.list', { server: serverId });
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.entries(data).map(([id, d]: [string, any]) => ({ id, ...d }));
    }
    return Array.isArray(data) ? data : [];
  }

  async getDID(serverId: string, didId: string): Promise<any> {
    return this.request('pbxware.did.edit', { server: serverId, id: didId });
  }

  // Operation times (business hours)
  async getOperationTimes(serverId: string): Promise<any> {
    return this.request('pbxware.otimes.servers.list', { server: serverId }).catch(() => null);
  }

  async ping(): Promise<boolean> {
    await this.listTenants();
    return true;
  }
}
