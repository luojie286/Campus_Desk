import type {Message, Operation, Plan, SourceRow, Suggestion, Task, Todo} from './types';

const DEFAULT_BASE = '/api';

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 0, code = 'request_failed') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function readCredentials() {
  return {
    base: localStorage.getItem('desk.apiBase') || DEFAULT_BASE,
    token: localStorage.getItem('desk.apiToken') || ''
  };
}

export function saveCredentials(base: string, token: string) {
  localStorage.setItem('desk.apiBase', base.trim() || DEFAULT_BASE);
  localStorage.setItem('desk.apiToken', token.trim());
}

export function clearToken() {
  localStorage.removeItem('desk.apiToken');
}

function baseUrl() {
  const base = readCredentials().base.replace(/\/+$/, '');
  return base || DEFAULT_BASE;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readCredentials().token;
  if (!token) throw new ApiError('还没有配置访问令牌', 401, 'token_missing');
  const response = await fetch(baseUrl() + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers || {})
    }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body?.error || 'request_failed';
    throw new ApiError(code, response.status, code);
  }
  return body as T;
}

export async function checkHealth() {
  const response = await fetch(baseUrl() + '/health');
  if (!response.ok) throw new ApiError('服务不可用', response.status);
  return response.json() as Promise<{running: boolean; sourceConfigured: boolean}>;
}

export async function loadSources() {
  return request<{items: SourceRow[]}>('/v1/sources');
}

export async function loadMessages(limit = 80) {
  return request<{items: Message[]}>(`/v1/messages?limit=${limit}`);
}

export async function loadMessage(id: number) {
  return request<Message>(`/v1/messages/${id}`);
}

export async function loadSuggestions(status = 'pending') {
  return request<{items: Suggestion[]}>(`/v1/suggestions?status=${encodeURIComponent(status)}`);
}

export async function acceptSuggestion(id: number) {
  return request<{suggestion: Suggestion; todo: Todo}>(`/v1/suggestions/${id}/accept`, {
    method: 'POST',
    body: '{}'
  });
}

export async function dismissSuggestion(id: number) {
  return request<{suggestion: Suggestion}>(`/v1/suggestions/${id}/dismiss`, {
    method: 'POST',
    body: '{}'
  });
}

export async function loadTodos() {
  return request<{items: Todo[]}>('/v1/todos');
}

export async function loadTasks() {
  return request<{items: Task[]}>('/v1/tasks');
}

export async function loadTask(id: number) {
  return request<Task>(`/v1/tasks/${id}`);
}

export async function answerTask(id: number, answers: Array<{key: string; value: string}>) {
  return request<{ok: boolean; state: string; task_version: number}>(`/v1/tasks/${id}/answers`, {
    method: 'POST',
    body: JSON.stringify({answers})
  });
}

function requestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function approveTask(task: Task, plan: Plan) {
  return request<{task: Task; operation: Operation}>(`/v1/tasks/${task.id}/approvals`, {
    method: 'POST',
    body: JSON.stringify({
      plan_id: plan.id,
      plan_version: plan.version,
      plan_digest: plan.digest,
      client_request_id: requestId()
    })
  });
}

export async function cancelTask(id: number) {
  return request<{task: Task}>(`/v1/tasks/${id}/cancel`, {method: 'POST', body: '{}'});
}
