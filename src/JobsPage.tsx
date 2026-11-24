import React, { useEffect, useState } from 'react';
import { api, LocalDirectory } from './api';
import { BackupJob, ScheduleConfig } from './types';

interface JobsPageProps {
  jobs: BackupJob[];
  onToggleJob: (id: string) => void;
  onRunJob: (id: string) => void;
  onDryRunJob: (id: string) => void;
  onStopJob: (id: string) => void;
  onAddJob: (job: Omit<BackupJob, 'id' | 'lastRun' | 'lastStatus' | 'size' | 'filesCount'>) => void;
  onUpdateJob: (id: string, job: Pick<BackupJob, 'name' | 'sourcePath' | 'schedule'>) => void;
  onDeleteJob: (id: string) => void;
  canRunBackups: boolean;
}

const scheduleLabels: Record<string, string> = {
  manual: 'Вручную',
  hourly: 'Каждый час',
  daily: 'Ежедневно',
  weekly: 'Еженедельно',
  custom: 'По cron',
};

const dayNames = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

export const JobsPage: React.FC<JobsPageProps> = ({
  jobs, onToggleJob, onRunJob, onDryRunJob, onStopJob, onAddJob, onUpdateJob, onDeleteJob, canRunBackups,
}) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [pickerPath, setPickerPath] = useState('/home');
  const [pickerDirectories, setPickerDirectories] = useState<LocalDirectory[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState('');
  const [pickerRefresh, setPickerRefresh] = useState(0);
  const [newJob, setNewJob] = useState<Omit<BackupJob, 'id' | 'lastRun' | 'lastStatus' | 'size' | 'filesCount'>>({
    name: '',
    sourcePath: '',
    enabled: true,
    schedule: { type: 'daily', time: '03:00', dayOfWeek: 1 },
  });

  useEffect(() => {
    if (!directoryPickerOpen) return;
    let active = true;
    setPickerLoading(true);
    setPickerError('');
    void api.getLocalDirectories(pickerPath).then(result => {
      if (active) {
        setPickerPath(result.path);
        setPickerDirectories(result.directories);
      }
    }).catch(error => {
      if (active) setPickerError(error instanceof Error ? error.message : 'Не удалось прочитать каталог.');
    }).finally(() => {
      if (active) setPickerLoading(false);
    });
    return () => { active = false; };
  }, [directoryPickerOpen, pickerPath, pickerRefresh]);

  const handleSave = () => {
    if (newJob.name && newJob.sourcePath) {
      if (editingId) onUpdateJob(editingId, newJob);
      else onAddJob(newJob);
      setShowAddForm(false);
      setEditingId(null);
      setNewJob({ name: '', sourcePath: '', enabled: true, schedule: { type: 'daily', time: '03:00', dayOfWeek: 1 } });
    }
  };

  const editJob = (job: BackupJob) => {
    setEditingId(job.id);
    setNewJob({ name: job.name, sourcePath: job.sourcePath, enabled: job.enabled, schedule: { ...job.schedule } });
    setShowAddForm(true);
  };

  const closeForm = () => {
    setShowAddForm(false);
    setEditingId(null);
    setDirectoryPickerOpen(false);
  };

  const openDirectoryPicker = () => {
    setPickerPath(newJob.sourcePath || '/home');
    setPickerError('');
    setDirectoryPickerOpen(true);
  };

  const parentPickerPath = pickerPath === '/'
    ? '/'
    : pickerPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Задания синхронизации</h2>
          <p className="text-slate-500 text-sm mt-1">Управление локальными и удалёнными каталогами</p>
        </div>
        <button
          onClick={() => {
            if (showAddForm) closeForm();
            else {
              setEditingId(null);
              setNewJob({ name: '', sourcePath: '', enabled: true, schedule: { type: 'daily', time: '03:00', dayOfWeek: 1 } });
              setShowAddForm(true);
            }
          }}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
        >
          <i className="fa-solid fa-plus"></i>
          {showAddForm ? 'Закрыть форму' : 'Добавить задание'}
        </button>
      </div>

      {/* Add Form */}
      {showAddForm && (
        <div className="bg-white rounded-xl border border-blue-200 shadow-sm p-5">
          <h3 className="font-semibold text-slate-800 mb-4">{editingId ? 'Редактирование задания' : 'Новое задание'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Название</label>
              <input
                type="text"
                value={newJob.name}
                onChange={(e) => setNewJob({ ...newJob, name: e.target.value })}
                placeholder="Например: Проекты"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Исходный каталог</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newJob.sourcePath}
                  readOnly
                  placeholder="Выберите каталог"
                  className="min-w-0 flex-1 px-3 py-2 border border-slate-300 rounded-lg bg-slate-50 text-sm font-mono"
                />
                <button
                  type="button"
                  onClick={openDirectoryPicker}
                  className="shrink-0 px-3 py-2 bg-slate-100 text-slate-700 text-sm rounded-lg hover:bg-slate-200"
                >
                  <i className="fa-solid fa-folder-open mr-1"></i>Выбрать
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Расписание</label>
              <select
                value={newJob.schedule.type}
                onChange={(e) => setNewJob({ ...newJob, schedule: { ...newJob.schedule, type: e.target.value as ScheduleConfig['type'] } })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              >
                <option value="manual">Вручную</option>
                <option value="hourly">Каждый час</option>
                <option value="daily">Ежедневно</option>
                <option value="weekly">Еженедельно</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Время выполнения</label>
              <input
                type="time"
                value={newJob.schedule.time}
                onChange={(e) => setNewJob({ ...newJob, schedule: { ...newJob.schedule, time: e.target.value } })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
            {newJob.schedule.type === 'weekly' && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">День недели</label>
                <select
                  value={newJob.schedule.dayOfWeek}
                  onChange={event => setNewJob({ ...newJob, schedule: { ...newJob.schedule, dayOfWeek: Number(event.target.value) } })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  {dayNames.map((name, index) => <option key={index} value={index}>{name}</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={handleSave} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">
              Сохранить
            </button>
            <button onClick={closeForm} className="px-4 py-2 bg-slate-100 text-slate-700 text-sm rounded-lg hover:bg-slate-200">
              Отмена
            </button>
          </div>
        </div>
      )}

      {/* Jobs List */}
      <div className="space-y-3">
        {jobs.map((job) => (
          <div key={job.id} className={`bg-white rounded-xl border shadow-sm p-5 transition-all ${
            job.lastStatus === 'error' ? 'border-red-200' : 'border-slate-200'
          }`}>
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-4">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                  job.enabled ? 'bg-blue-50' : 'bg-slate-100'
                }`}>
                  <i className={`fa-solid fa-folder ${job.enabled ? 'text-blue-600' : 'text-slate-400'}`}></i>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold text-slate-800">{job.name}</h4>
                    <span className={`px-2 py-0.5 text-xs rounded-full ${
                      job.lastStatus === 'success' ? 'bg-green-100 text-green-700' :
                      job.lastStatus === 'error' ? 'bg-red-100 text-red-700' :
                      job.lastStatus === 'running' ? 'bg-blue-100 text-blue-700' :
                      job.lastStatus === 'cancelled' ? 'bg-slate-100 text-slate-600' :
                      'bg-slate-100 text-slate-600'
                    }`}>
                      {job.lastStatus === 'success' ? 'Успешно' :
                       job.lastStatus === 'error' ? 'Ошибка' :
                       job.lastStatus === 'running' ? 'Выполняется' :
                       job.lastStatus === 'cancelled' ? 'Остановлено' : 'Не запускалось'}
                    </span>
                  </div>
                  <p className="text-sm text-slate-500 font-mono mt-0.5">{job.sourcePath}</p>
                  <div className="flex items-center gap-4 mt-2">
                    <span className="text-xs text-slate-400">
                      <i className="fa-regular fa-clock mr-1"></i>
                      {scheduleLabels[job.schedule.type]} {job.schedule.time ? `в ${job.schedule.time}` : ''}
                    </span>
                    <span className="text-xs text-slate-400">
                      <i className="fa-solid fa-hard-drive mr-1"></i>
                      {job.size}
                    </span>
                    <span className="text-xs text-slate-400">
                      <i className="fa-solid fa-file mr-1"></i>
                      {job.filesCount.toLocaleString()} файлов
                    </span>
                    {job.lastRun && (
                      <span className="text-xs text-slate-400">
                        <i className="fa-solid fa-calendar mr-1"></i>
                        {job.lastRun}
                      </span>
                    )}
                  </div>
                  {job.lastStatus === 'running' && (
                    <div className="mt-3 w-full">
                      <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                        <span>{job.progressMessage || 'Задание выполняется…'}</span>
                        {job.progress != null && <span>{job.progress}%</span>}
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full bg-blue-500 transition-all ${job.progress == null ? 'w-1/4 animate-pulse' : ''}`}
                          style={job.progress == null ? undefined : { width: `${job.progress}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {job.lastStatus === 'running' ? (
                  <button
                    onClick={() => onStopJob(job.id)}
                    className="px-3 py-1.5 bg-red-50 text-red-700 text-xs rounded-lg hover:bg-red-100 transition-colors flex items-center gap-1"
                  >
                    <i className="fa-solid fa-stop"></i> Остановить
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => onRunJob(job.id)}
                      disabled={!canRunBackups}
                      title={!canRunBackups ? 'Синхронизация поддерживается в Linux' : undefined}
                      className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-1 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <i className="fa-solid fa-play"></i> Запустить
                    </button>
                    <button
                      onClick={() => onDryRunJob(job.id)}
                      disabled={!canRunBackups}
                      title="Проверить изменения без передачи и удаления файлов"
                      className="px-3 py-1.5 bg-indigo-50 text-indigo-700 text-xs rounded-lg hover:bg-indigo-100 transition-colors flex items-center gap-1 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <i className="fa-solid fa-magnifying-glass"></i> Проверить
                    </button>
                  </>
                )}
                <button
                  onClick={() => editJob(job)}
                  disabled={job.lastStatus === 'running'}
                  title="Редактировать задание"
                  className="px-3 py-1.5 bg-slate-100 text-slate-600 text-xs rounded-lg hover:bg-slate-200 transition-colors disabled:opacity-50"
                >
                  <i className="fa-solid fa-pen"></i>
                </button>
                <button
                  onClick={() => onToggleJob(job.id)}
                  disabled={job.lastStatus === 'running'}
                  className={`px-3 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1 ${
                    job.enabled
                      ? 'bg-green-50 text-green-700 hover:bg-green-100'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  <i className={`fa-solid ${job.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}`}></i>
                  {job.enabled ? 'Вкл' : 'Выкл'}
                </button>
                <button
                  onClick={() => onDeleteJob(job.id)}
                  disabled={job.lastStatus === 'running'}
                  className="px-3 py-1.5 bg-red-50 text-red-600 text-xs rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50"
                >
                  <i className="fa-solid fa-trash"></i>
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-slate-500">Каждое задание синхронизируется в отдельный каталог на SMB-ресурсе.</p>

      {directoryPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setDirectoryPickerOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="directory-picker-title"
            className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl"
          >
            <header className="border-b border-slate-200 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 id="directory-picker-title" className="font-semibold text-slate-800">Выбор исходного каталога</h3>
                  <p className="mt-1 break-all font-mono text-xs text-slate-500">{pickerPath}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setDirectoryPickerOpen(false)}
                  aria-label="Закрыть выбор каталога"
                  className="rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-100"
                >
                  <i className="fa-solid fa-xmark"></i>
                </button>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setPickerPath(parentPickerPath)}
                  disabled={pickerPath === '/'}
                  className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                >
                  <i className="fa-solid fa-arrow-up mr-1"></i>На уровень выше
                </button>
                <button
                  type="button"
                  onClick={() => setPickerPath('/home')}
                  disabled={pickerPath === '/home'}
                  className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                >
                  Домашние каталоги (/home)
                </button>
                <button
                  type="button"
                  onClick={() => setPickerPath('/')}
                  disabled={pickerPath === '/'}
                  className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                >
                  Корень файловой системы (/)
                </button>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {pickerError ? (
                <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  <p>{pickerError}</p>
                  <button type="button" onClick={() => setPickerRefresh(refresh => refresh + 1)} className="mt-2 font-medium underline">
                    Повторить
                  </button>
                </div>
              ) : pickerLoading ? (
                <p className="p-8 text-center text-sm text-slate-500">Загрузка каталогов…</p>
              ) : pickerDirectories.length === 0 ? (
                <p className="p-8 text-center text-sm text-slate-500">В этом каталоге нет вложенных папок.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {pickerDirectories.map(directory => (
                    <button
                      type="button"
                      key={directory.path}
                      onClick={() => setPickerPath(directory.path)}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-slate-700 hover:bg-blue-50"
                    >
                      <i className="fa-solid fa-folder text-amber-500"></i>
                      <span className="break-all">{directory.name}</span>
                      <i className="fa-solid fa-chevron-right ml-auto text-xs text-slate-400"></i>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 p-4">
              <button type="button" onClick={() => setDirectoryPickerOpen(false)} className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700 hover:bg-slate-200">
                Отмена
              </button>
              <button
                type="button"
                onClick={() => {
                  setNewJob(current => ({ ...current, sourcePath: pickerPath }));
                  setDirectoryPickerOpen(false);
                }}
                disabled={pickerLoading || Boolean(pickerError) || pickerPath === '/'}
                title={pickerPath === '/' ? 'Корень содержит точку монтирования и не может быть источником' : undefined}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Выбрать этот каталог
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
};
