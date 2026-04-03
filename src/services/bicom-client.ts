import axios, { AxiosInstance } from 'axios';

export class BiComClient {
  private base: string;
  private apiKey: string;
  private http: AxiosInstance;

  constructor(serverUrl: string, apiKey: string) {
    this.base = serverUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.http = axios.create({
      baseURL: this.base,
      timeout: 30000,
    });
  }

  private async request<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const r = await this.http.get<T>(path, {
      params: { ...params, api_key: this.apiKey },
    });
    return r.data;
  }

  async listTenants(): Promise<any[]> {
    const data = await this.request<any>('/api/tenant');
    return Array.isArray(data) ? data : data?.data || data?.tenants || [];
  }

  async getTenant(tenantId: string): Promise<any> {
    return this.request(`/api/tenant/${tenantId}`);
  }

  async listExtensions(tenantId: string): Promise<any[]> {
    const data = await this.request<any>('/api/extension', { tenant: tenantId });
    return Array.isArray(data) ? data : data?.data || data?.extensions || [];
  }

  async getExtension(tenantId: string, extId: string): Promise<any> {
    return this.request(`/api/extension/${extId}`, { tenant: tenantId });
  }

  async listRingGroups(tenantId: string): Promise<any[]> {
    const data = await this.request<any>('/api/ringgroup', { tenant: tenantId });
    return Array.isArray(data) ? data : data?.data || data?.groups || [];
  }

  async getRingGroup(tenantId: string, groupId: string): Promise<any> {
    return this.request(`/api/ringgroup/${groupId}`, { tenant: tenantId });
  }

  async listQueues(tenantId: string): Promise<any[]> {
    const data = await this.request<any>('/api/queue', { tenant: tenantId });
    return Array.isArray(data) ? data : data?.data || data?.queues || [];
  }

  async getQueue(tenantId: string, queueId: string): Promise<any> {
    return this.request(`/api/queue/${queueId}`, { tenant: tenantId });
  }

  async listIVRs(tenantId: string): Promise<any[]> {
    const data = await this.request<any>('/api/ivr', { tenant: tenantId });
    return Array.isArray(data) ? data : data?.data || data?.ivrs || [];
  }

  async getIVR(tenantId: string, ivrId: string): Promise<any> {
    return this.request(`/api/ivr/${ivrId}`, { tenant: tenantId });
  }

  async listDIDs(tenantId: string): Promise<any[]> {
    const data = await this.request<any>('/api/did', { tenant: tenantId });
    return Array.isArray(data) ? data : data?.data || data?.dids || [];
  }

  async getDID(tenantId: string, didId: string): Promise<any> {
    return this.request(`/api/did/${didId}`, { tenant: tenantId });
  }

  async ping(): Promise<boolean> {
    await this.listTenants();
    return true;
  }
}
