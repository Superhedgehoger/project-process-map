/**
 * Canonical dependency-free browser client. The same source is embedded in the
 * standalone SaaS HTML, so the self-contained delivery does not grow a second
 * route/error/retry implementation.
 */
export const projectProcessMapBrowserClientSource = String.raw`
class ProjectProcessMapBrowserClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/$/, '');
    this.authorization = options.authorization;
    this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
    this.timeoutMilliseconds = options.timeoutMilliseconds || 10000;
    if (!Number.isSafeInteger(this.timeoutMilliseconds) || this.timeoutMilliseconds <= 0) throw new Error('timeoutMilliseconds must be positive');
  }
  health() { return this.request('/health'); }
  listNodes() { return this.request('/api/nodes'); }
  getNode(nodeId) { return this.request('/api/nodes/' + encodeURIComponent(nodeId)); }
  createTask(nodeId, input, idempotencyKey) {
    return this.request('/api/nodes/' + encodeURIComponent(nodeId) + '/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': this.requiredKey(idempotencyKey) }, body: JSON.stringify(input)
    }, true);
  }
  attachAsset(taskId, input, idempotencyKey) {
    return this.request('/api/tasks/' + encodeURIComponent(taskId) + '/files', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': this.requiredKey(idempotencyKey) }, body: JSON.stringify(input)
    }, true);
  }
  async request(path, init = {}, safeToRetry = false) {
    const attempts = safeToRetry ? 2 : 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const headers = new Headers(init.headers);
      const authorization = this.authorization && this.authorization();
      if (authorization) headers.set('authorization', authorization);
      try {
        const response = await this.fetch(this.baseUrl + path, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMilliseconds) });
        const body = await response.json().catch(() => ({ code: 'INVALID_RESPONSE', message: '服务返回了无效响应' }));
        if (response.ok) return body;
        const error = new Error(body.message || ('请求失败 (' + response.status + ')'));
        error.code = body.code || 'UPSTREAM_FAILURE';
        error.status = response.status;
        if (attempt < attempts && (response.status === 408 || response.status === 429 || response.status >= 500)) { lastError = error; continue; }
        throw error;
      } catch (error) {
        lastError = error;
        if (error && typeof error.status === 'number') throw error;
        if (attempt >= attempts) throw error;
      }
    }
    throw lastError;
  }
  requiredKey(value) {
    if (typeof value !== 'string' || value.trim().length === 0) throw new Error('idempotencyKey is required');
    return value;
  }
}
globalThis.ProjectProcessMapBrowserClient = ProjectProcessMapBrowserClient;
`;

export const MAX_BROWSER_ASSET_BYTES = 2 * 1024 * 1024;
