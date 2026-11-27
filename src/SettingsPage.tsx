import React, { useEffect, useState } from 'react';
import { BackupSettings } from './api';

interface SettingsPageProps {
  settings: BackupSettings;
  backupMountPoint: string;
  onSave: (settings: BackupSettings) => Promise<boolean>;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ settings: savedSettings, backupMountPoint, onSave }) => {
  const [settings, setSettings] = useState(savedSettings);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!dirty) setSettings(savedSettings);
  }, [savedSettings, dirty]);

  const update = (changes: Partial<BackupSettings>) => {
    setSettings(current => ({ ...current, ...changes }));
    setDirty(true);
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    const success = await onSave(settings);
    setSaving(false);
    if (success) {
      setDirty(false);
      setSaved(true);
    }
  };

  const toggle = (label: string, enabled: boolean, onClick: () => void, description?: string, disabled = false) => (
    <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
      <div>
        <p className="text-sm font-medium text-slate-700">{label}</p>
        {description && <p className="text-xs text-slate-500 mt-1">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className={`w-12 h-6 rounded-full transition-colors ${enabled ? 'bg-blue-600' : 'bg-slate-300'} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <span className={`block w-5 h-5 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-800">Настройки</h2>
        <p className="text-slate-500 text-sm mt-1">Параметры синхронизации, архивирования и журналирования</p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <h3 className="font-semibold text-slate-800 mb-5 flex items-center gap-2">
          <i className="fa-solid fa-sliders text-blue-600"></i>
          Параметры rsync
        </h3>
        <div className="space-y-4">
          {toggle('Сжатие при передаче (-z)', settings.compression, () => update({ compression: !settings.compression }))}
          {toggle(
            'Удалять лишние файлы в копии (--delete)',
            settings.deleteExtra,
            () => update({ deleteExtra: !settings.deleteExtra, ...(settings.deleteExtra ? { deleteDelay: false } : {}) }),
            'Файлы в копии, отсутствующие в источнике, будут удалены.',
          )}
          {toggle(
            'Отложить удаление (--delete-delay)',
            settings.deleteDelay,
            () => update({ deleteDelay: !settings.deleteDelay }),
            'Удаление включённых выше лишних файлов выполняется после передачи, а не в процессе синхронизации.',
            !settings.deleteExtra,
          )}
          {toggle('Подробный вывод (-v)', settings.verbose, () => update({ verbose: !settings.verbose }))}
          {toggle(
            'Записывать прямо в файл назначения (--inplace)',
            settings.inPlace,
            () => update({ inPlace: !settings.inPlace }),
            'rsync не создаёт временный файл с точкой в начале имени и не переименовывает его после передачи. Если копирование прервётся, файл в копии может остаться неполным или повреждённым.',
          )}
          {toggle(
            'Создавать архив после синхронизации',
            settings.createArchive,
            () => update({ createArchive: !settings.createArchive }),
            'Архив .tar.gz сохраняется на SMB-сервере в отдельном каталоге для этой машины.',
          )}
          {settings.createArchive && (
            <div className="max-w-sm">
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Хранить последних архивов</label>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={settings.archiveRetention}
                onChange={event => update({ archiveRetention: Number(event.target.value) })}
                className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          )}
          <div>
            <label htmlFor="rsync-exclude-patterns" className="block text-sm font-medium text-slate-700 mb-1.5">
              Маски исключения (по одной на строку)
            </label>
            <textarea
              id="rsync-exclude-patterns"
              rows={8}
              value={settings.excludePatterns.join('\n')}
              onChange={event => update({ excludePatterns: event.target.value.split(/\r?\n/).map(pattern => pattern.trim()) })}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 outline-none"
              aria-describedby="rsync-exclude-help"
            />
            <p id="rsync-exclude-help" className="text-xs text-slate-500 mt-1.5">
              Используются шаблоны rsync. Удалите стандартную строку, чтобы отключить соответствующее исключение, или добавьте свою маску. Файлы блокировки Р-7 Офис `.~lock.*` и `~$*` исключаются по умолчанию.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Ограничение скорости (Мбит/с, 0 — без ограничений)</label>
              <input
                type="number"
                min={0}
                max={1000000}
                step={1}
                value={settings.bandwidthLimit}
                onChange={event => update({ bandwidthLimit: Number(event.target.value) })}
                className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Попытки при ошибке (1–10)</label>
              <input
                type="number"
                min={1}
                max={10}
                step={1}
                value={settings.retries}
                onChange={event => update({ retries: Number(event.target.value) })}
                className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          </div>
        </div>
      </div>

      <section className="bg-amber-50 rounded-xl border border-amber-200 shadow-sm p-6">
        <h3 className="font-semibold text-amber-900 mb-3 flex items-center gap-2">
          <i className="fa-solid fa-shield-virus text-amber-700" aria-hidden="true"></i>
          Исключение в политике Kaspersky Security Center
        </h3>
        <p className="text-sm text-amber-900">
          Чтобы проверить, влияет ли антивирус на создание архивов, добавьте точку монтирования резервной копии в исключения
          политики Kaspersky Endpoint Security for Linux, применяемой к этой машине:
        </p>
        <code className="block mt-3 px-3 py-2 rounded-lg bg-white border border-amber-200 text-sm font-mono text-slate-800 break-all">
          {backupMountPoint || 'Точка монтирования не настроена'}
        </code>
        <p className="text-xs text-amber-800 mt-3">
          Это только подсказка: Backup Manager не изменяет настройки Kaspersky или политику KSC. Исключение снижает антивирусную
          проверку указанного каталога; ограничьте его этой точкой монтирования и соблюдайте правила безопасности организации.
        </p>
      </section>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
          <i className="fa-solid fa-database text-green-600"></i>
          Хранение журнала
        </h3>
        <label className="block text-sm font-medium text-slate-700 mb-1.5">Хранить записи (дней)</label>
        <input
          type="number"
          min={1}
          max={3650}
          value={settings.logRetention}
          onChange={event => update({ logRetention: Number(event.target.value) })}
          className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className="px-5 py-2.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <i className="fa-solid fa-floppy-disk"></i>
          {saving ? 'Сохранение…' : 'Сохранить настройки'}
        </button>
        {saved && <span className="text-sm text-green-600 flex items-center gap-1"><i className="fa-solid fa-circle-check"></i> Сохранено</span>}
      </div>
    </div>
  );
};
