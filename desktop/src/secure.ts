import {invoke} from '@tauri-apps/api/core';

// 浏览器开发版沿用 localStorage；Tauri 版本写入 Windows Credential Manager。
export function isTauriApp() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

let memoryToken = '';

export async function initializeToken() {
  if (isTauriApp()) {
    memoryToken = (await invoke<string | null>('get_api_token')) || '';
  } else {
    memoryToken = localStorage.getItem('desk.apiToken') || '';
  }
  return memoryToken;
}

export function currentToken() {
  return memoryToken;
}

export async function persistToken(token: string) {
  if (isTauriApp()) {
    await invoke('save_api_token', {token});
  } else {
    localStorage.setItem('desk.apiToken', token);
  }
  memoryToken = token;
}

export async function removeToken() {
  if (isTauriApp()) {
    await invoke('delete_api_token');
  } else {
    localStorage.removeItem('desk.apiToken');
  }
  memoryToken = '';
}
