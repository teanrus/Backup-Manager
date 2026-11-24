import { BackupJob, LogEntry, SMBConfig } from './types';

export interface BackupSettings {
  compression: boolean;
  deleteExtra: boolean;
  verbose: boolean;
  inPlace: boolean;
  deleteDelay: boolean;
  createArchive: boolean;
  archiveRetention: number;
  excludePatterns: string[];
  bandwidthLimit: number;
  retries: number;
  notifyEmail: string;
  notifyOnError: boolean;
  notifyOnSuccess: boolean;
  logRetention: number;
  parallelJobs: number;
}

export interface AppState {
  jobs: BackupJob[];
  logs: LogEntry[];
  smbConfig: SMBConfig;
  settings: BackupSettings;
  backend: {
    platform: string;
    canRunBackups: boolean;
  };
}

export interface RecoveryEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number;
  modifiedAt: string;
}

export interface LocalDirectory {
  name: string;
  path: string;
}

export function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString('ru-RU');
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });

  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error(
      `API вернул не JSON (HTTP ${response.status}). Проверьте первоначальную настройку и состояние служб backup-manager-api и nginx.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`API вернул некорректный JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `Ошибка запроса (${response.status}).`;
    throw new Error(error);
  }
  return body as T;
}

export const api = {
  getState: () => request<AppState>('/api/state'),
  getLocalDirectories: (directoryPath: string) =>
    request<{ path: string; directories: LocalDirectory[] }>(
      `/api/directories?path=${encodeURIComponent(directoryPath)}`,
    ),
  addJob: (job: Omit<BackupJob, 'id' | 'lastRun' | 'lastStatus' | 'size' | 'filesCount'>) =>
    request<BackupJob>('/api/jobs', { method: 'POST', body: JSON.stringify(job) }),
  updateJob: (id: string, changes: Partial<Pick<BackupJob, 'enabled' | 'schedule' | 'name' | 'sourcePath'>>) =>
    request<BackupJob>(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
  deleteJob: (id: string) =>
    request<{ ok: boolean }>(`/api/jobs/${id}`, { method: 'DELETE' }),
  runJob: (id: string) =>
    request<{ accepted: boolean }>(`/api/jobs/${id}/run`, { method: 'POST' }),
  dryRunJob: (id: string) =>
    request<{ accepted: boolean }>(`/api/jobs/${id}/dry-run`, { method: 'POST' }),
  stopJob: (id: string) =>
    request<{ accepted: boolean }>(`/api/jobs/${id}/stop`, { method: 'POST' }),
  getRecoveryEntries: (relativePath = '') =>
    request<{ path: string; entries: RecoveryEntry[] }>(`/api/recovery?path=${encodeURIComponent(relativePath)}`),
  restore: (relativePath: string, targetPath: string) =>
    request<{ ok: boolean }>('/api/recovery/restore', {
      method: 'POST',
      body: JSON.stringify({ path: relativePath, targetPath }),
    }),
  downloadRecoveryFile: async (relativePath: string): Promise<Blob> => {
    const response = await fetch(`/api/recovery/download?path=${encodeURIComponent(relativePath)}`);
    if (!response.ok) {
      let error = `Ошибка загрузки (${response.status}).`;
      try {
        const body = await response.json();
        if (typeof body.error === 'string') error = body.error;
      } catch {
        // Keep the HTTP error when the response is not JSON.
      }
      throw new Error(error);
    }
    return response.blob();
  },
  saveSmb: (config: SMBConfig) =>
    request<SMBConfig>('/api/smb', { method: 'PUT', body: JSON.stringify(config) }),
  testSmb: () => request<{ connected: boolean }>('/api/smb/test', { method: 'POST' }),
  saveSettings: (settings: BackupSettings) =>
    request<BackupSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }),
};
