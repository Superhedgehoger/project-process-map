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
  health() { return this.request('/health', {}, false, value => this.decodeHealth(value)); }
  listNodes() { return this.request('/api/nodes', {}, false, value => this.decodeNodes(value)); }
  getNode(nodeId) { return this.request('/api/nodes/' + encodeURIComponent(nodeId), {}, false, value => this.decodeNodeDetail(value)); }
  createTask(nodeId, input, idempotencyKey) {
    return this.request('/api/nodes/' + encodeURIComponent(nodeId) + '/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': this.requiredKey(idempotencyKey) }, body: JSON.stringify(input)
    }, true, value => this.decodeCommand(value, item => this.decodeTask(item, false)));
  }
  actOnTask(taskId, action, input, idempotencyKey) {
    if (!['start','submit','accept','reject','withdraw','complete','assign-assignee','assign-reviewer'].includes(action)) throw new Error('task action is invalid');
    return this.request('/api/tasks/' + encodeURIComponent(taskId) + '/actions/' + action, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': this.requiredKey(idempotencyKey) }, body: JSON.stringify(input)
    }, true, value => this.decodeCommand(value, item => this.decodeTask(item, false)));
  }
  attachAsset(taskId, input, idempotencyKey) {
    return this.request('/api/tasks/' + encodeURIComponent(taskId) + '/files', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': this.requiredKey(idempotencyKey) }, body: JSON.stringify(input)
    }, true, value => this.decodeCommand(value, item => this.decodeAsset(item)));
  }
  async request(path, init = {}, safeToRetry = false, decode = value => value) {
    const attempts = safeToRetry ? 2 : 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const headers = new Headers(init.headers);
      const authorization = this.authorization && this.authorization();
      if (authorization) headers.set('authorization', authorization);
      try {
        const response = await this.fetch(this.baseUrl + path, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMilliseconds) });
        const body = await response.json().catch(() => ({ code: 'INVALID_RESPONSE', message: '服务返回了无效响应' }));
        if (response.ok) return decode(body);
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
  decodeHealth(value) {
    const item = this.record(value, 'health response');
    this.oneOf(item.status, ['ok','degraded'], 'health status');
    this.oneOf(item.collaborationMode, ['disabled','huly'], 'collaboration mode');
    this.text(item.checkedAt, 'checkedAt');
    if (!Array.isArray(item.components)) throw new Error('components must be an array');
    item.components.forEach((component, index) => {
      const entry = this.record(component, 'health component ' + index);
      this.text(entry.component, 'component'); this.oneOf(entry.status, ['ok','degraded'], 'component status'); this.text(entry.version, 'component version');
    });
    return value;
  }
  decodeNodes(value) {
    if (!Array.isArray(value)) throw new Error('node list must be an array');
    return value.map(item => this.decodeNode(item));
  }
  decodeNodeDetail(value) {
    const item = this.record(value, 'node detail');
    if (!Array.isArray(item.tasks)) throw new Error('tasks must be an array');
    return { node: this.decodeNode(item.node), tasks: item.tasks.map(task => this.decodeTask(task, true)) };
  }
  decodeNode(value) {
    const item = this.record(value, 'node');
    this.text(item.id, 'node.id'); this.text(item.projectId, 'node.projectId');
    if (item.parentId !== null) this.text(item.parentId, 'node.parentId');
    this.text(item.title, 'node.title'); this.oneOf(item.kind, ['stage','work_package','milestone'], 'node.kind'); this.positive(item.version, 'node.version');
    return item;
  }
  decodeTask(value, withFiles) {
    const item = this.record(value, 'task');
    this.text(item.id, 'task.id'); this.text(item.nodeId, 'task.nodeId'); this.text(item.title, 'task.title');
    this.oneOf(item.status, ['todo','in_progress','pending_review','completed','canceled','promoted'], 'task.status');
    this.nullableText(item.assigneePrincipalId, 'task.assigneePrincipalId');
    if (typeof item.requiresAcceptance !== 'boolean') throw new Error('task.requiresAcceptance must be boolean');
    this.nullableText(item.reviewerPrincipalId, 'task.reviewerPrincipalId'); this.positive(item.version, 'task.version');
    if (!Array.isArray(item.reviewHistory)) throw new Error('task.reviewHistory must be an array');
    const result = { ...item, reviewHistory: item.reviewHistory.map(entry => this.decodeReview(entry)) };
    if (withFiles) {
      if (!Array.isArray(item.files)) throw new Error('task.files must be an array');
      result.files = item.files.map(asset => this.decodeAsset(asset));
    }
    return result;
  }
  decodeReview(value) {
    const item = this.record(value, 'task review action');
    this.positive(item.cycleNumber, 'review.cycleNumber'); this.oneOf(item.action, ['submitted','accepted','rejected','withdrawn'], 'review.action');
    this.text(item.actorPrincipalId, 'review.actorPrincipalId'); this.nullableText(item.reviewerPrincipalId, 'review.reviewerPrincipalId');
    this.text(item.occurredAtUtc, 'review.occurredAtUtc'); this.nullableText(item.note, 'review.note');
    return item;
  }
  decodeAsset(value) {
    const item = this.record(value, 'asset');
    this.text(item.id, 'asset.id'); this.text(item.taskId, 'asset.taskId'); this.text(item.nodeId, 'asset.nodeId'); this.text(item.name, 'asset.name'); this.text(item.contentType, 'asset.contentType');
    this.nonNegative(item.size, 'asset.size'); this.text(item.sha256, 'asset.sha256');
    this.oneOf(item.lifecycleState, ['initiated','uploading','scanning','available','quarantined','failed','deleted'], 'asset.lifecycleState');
    this.oneOf(item.scanState, ['scanning','available','quarantined','failed'], 'asset.scanState'); this.positive(item.version, 'asset.version');
    return item;
  }
  decodeCommand(value, decodeValue) {
    const item = this.record(value, 'command result');
    if (typeof item.replayed !== 'boolean') throw new Error('command replayed must be boolean');
    return { value: decodeValue(item.value), replayed: item.replayed };
  }
  record(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + ' must be an object');
    return value;
  }
  text(value, name) { if (typeof value !== 'string' || value.length === 0) throw new Error(name + ' must be a non-empty string'); return value; }
  nullableText(value, name) { if (value !== null) this.text(value, name); return value; }
  positive(value, name) { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(name + ' must be a positive integer'); return value; }
  nonNegative(value, name) { if (!Number.isSafeInteger(value) || value < 0) throw new Error(name + ' must be a non-negative integer'); return value; }
  oneOf(value, options, name) { if (typeof value !== 'string' || !options.includes(value)) throw new Error(name + ' is invalid'); return value; }
}
globalThis.ProjectProcessMapBrowserClient = ProjectProcessMapBrowserClient;
`;

export const MAX_BROWSER_ASSET_BYTES = 2 * 1024 * 1024;
