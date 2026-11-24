import React, { useEffect, useState } from 'react';
import { api, formatTimestamp, RecoveryEntry } from './api';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
}

export const RecoveryPage: React.FC = () => {
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<RecoveryEntry[]>([]);
  const [targetPath, setTargetPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyPath, setBusyPath] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void api.getRecoveryEntries(currentPath).then(result => {
      if (active) setEntries(result.entries);
    }).catch(loadError => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Не удалось прочитать хранилище.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [currentPath]);

  const download = async (entry: RecoveryEntry) => {
    setBusyPath(entry.path);
    setError('');
    try {
      const blob = await api.downloadRecoveryFile(entry.path);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = entry.name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Не удалось скачать файл.');
    } finally {
      setBusyPath('');
    }
  };

  const restore = async (entry: RecoveryEntry) => {
    if (!targetPath.trim()) {
      setError('Укажите абсолютный путь к пустому каталогу восстановления.');
      return;
    }
    setBusyPath(entry.path);
    setError('');
    setMessage('');
    try {
      await api.restore(entry.path, targetPath.trim());
      setMessage(`Данные восстановлены в ${targetPath.trim()}.`);
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : 'Не удалось восстановить данные.');
    } finally {
      setBusyPath('');
    }
  };

  const parentPath = currentPath.split('/').slice(0, -1).join('/');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-800">Восстановление</h2>
        <p className="text-slate-500 text-sm mt-1">Файлы, каталоги и архивы на SMB-сервере для этой машины</p>
      </div>

      <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <label htmlFor="restore-target" className="block text-sm font-medium text-slate-700 mb-1.5">
          Каталог на этом компьютере для восстановления
        </label>
        <input
          id="restore-target"
          value={targetPath}
          onChange={event => setTargetPath(event.target.value)}
          placeholder="/home/user/restored"
          className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 outline-none"
        />
        <p className="text-xs text-slate-500 mt-1.5">Каталог должен быть пустым. Это предотвращает случайную перезапись существующих файлов.</p>
      </section>

      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {message && <div role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">{message}</div>}

      <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 border-b border-slate-100 p-4 text-sm">
          <button onClick={() => setCurrentPath('')} className="text-blue-700 hover:underline">Хранилище машины</button>
          {currentPath && (
            <>
              <span className="text-slate-400">/</span>
              <button onClick={() => setCurrentPath(parentPath)} className="text-blue-700 hover:underline">
                {currentPath.split('/').pop()}
              </button>
            </>
          )}
          {currentPath && <span className="ml-auto font-mono text-xs text-slate-400">/{currentPath}</span>}
        </div>

        {loading ? (
          <p className="p-8 text-center text-sm text-slate-500">Загрузка содержимого SMB-хранилища…</p>
        ) : entries.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">В этом каталоге пока нет файлов.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {entries.map(entry => (
              <div key={entry.path} className="flex flex-wrap items-center gap-3 p-4">
                <i className={`fa-solid ${entry.type === 'directory' ? 'fa-folder text-amber-500' : 'fa-file text-slate-400'} w-5`}></i>
                {entry.type === 'directory' ? (
                  <button onClick={() => setCurrentPath(entry.path)} className="min-w-0 flex-1 truncate text-left text-sm font-medium text-blue-700 hover:underline">
                    {entry.name}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{entry.name}</span>
                )}
                <span className="text-xs text-slate-400">{entry.type === 'file' ? formatSize(entry.size) : 'Каталог'}</span>
                <span className="hidden text-xs text-slate-400 lg:inline">{formatTimestamp(entry.modifiedAt)}</span>
                {entry.type === 'file' && (
                  <button
                    onClick={() => void download(entry)}
                    disabled={busyPath === entry.path}
                    className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                  >
                    <i className="fa-solid fa-download mr-1"></i>Скачать
                  </button>
                )}
                <button
                  onClick={() => void restore(entry)}
                  disabled={Boolean(busyPath)}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {busyPath === entry.path ? 'Восстановление…' : 'Восстановить'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
