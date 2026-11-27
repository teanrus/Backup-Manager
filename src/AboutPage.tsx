import React, { useEffect, useState } from 'react';
import appIcon from '../assets/backup-manager.svg';
import { api, UpdateInfo, UpdateInstallStatus } from './api';
import { appVersion } from './version';

export const AboutPage: React.FC = () => {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateInstallStatus>({ status: 'idle' });
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updateError, setUpdateError] = useState('');

  useEffect(() => {
    let active = true;
    void api.getUpdateStatus().then(status => {
      if (active) setUpdateStatus(status);
    }).catch(error => {
      if (active) {
        setUpdateStatus({ status: 'idle' });
        setUpdateError(error instanceof Error
          ? `Не удалось получить состояние установки обновления: ${error.message}`
          : 'Не удалось получить состояние установки обновления.');
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (updateStatus.status !== 'installing') return undefined;
    let active = true;
    let timer: number;
    const poll = async () => {
      try {
        const status = await api.getUpdateStatus();
        if (!active) return;
        setUpdateStatus(status);
        if (status.status === 'installing') timer = window.setTimeout(() => void poll(), 2000);
      } catch {
        if (active) timer = window.setTimeout(() => void poll(), 2500);
      }
    };
    timer = window.setTimeout(() => void poll(), 1500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [updateStatus.status]);

  const checkForUpdates = async () => {
    setChecking(true);
    setUpdateError('');
    setUpdateInfo(null);
    try {
      setUpdateInfo(await api.checkForUpdate());
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : 'Не удалось проверить обновления.');
    } finally {
      setChecking(false);
    }
  };

  const installUpdate = async () => {
    setInstalling(true);
    setUpdateError('');
    try {
      setUpdateStatus(await api.installUpdate());
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : 'Не удалось запустить установку обновления.');
    } finally {
      setInstalling(false);
    }
  };

  return (
  <div className="space-y-6">
    <div>
      <h2 className="text-2xl font-bold text-slate-800">О программе</h2>
      <p className="text-slate-500 text-sm mt-1">Локальное управление синхронизацией и восстановлением данных</p>
    </div>

    <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
      <div className="flex items-start gap-5">
        <img src={appIcon} alt="" className="w-16 h-16 rounded-2xl flex-shrink-0" />
        <div>
          <h3 className="text-xl font-bold text-slate-800">Backup Manager</h3>
          <p className="text-slate-500 mt-1">Управление синхронизацией локальных каталогов с SMB/CIFS и восстановлением данных.</p>
          <p className="text-sm text-slate-500 mt-2">Версия: {appVersion}</p>
          <a
            className="inline-flex items-center gap-2 mt-2 text-sm text-blue-600 hover:underline"
            href="https://github.com/teanrus/Backup-Manager"
            target="_blank"
            rel="noopener noreferrer"
          >
            <i className="fa-brands fa-github" aria-hidden="true"></i>
            Официальный репозиторий
          </a>
          <p className="text-sm text-slate-500 mt-2">
            Автор: Руслан Тян (
            <a className="text-blue-600 hover:underline" href="mailto:teanrus@yandex.ru">teanrus@yandex.ru</a>)
          </p>
          <a
            className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors"
            href="https://boosty.to/backup_manager/donate"
            target="_blank"
            rel="noopener noreferrer"
          >
            <i className="fa-solid fa-mug-hot" aria-hidden="true"></i>
            Автору на кофе с печенькой
          </a>
          <div className="flex flex-wrap gap-2 mt-3">
            <span className="px-2.5 py-1 bg-blue-50 text-blue-700 text-xs rounded-full font-medium">React + Node.js</span>
            <span className="px-2.5 py-1 bg-green-50 text-green-700 text-xs rounded-full font-medium">Локальный backend</span>
            <span className="px-2.5 py-1 bg-purple-50 text-purple-700 text-xs rounded-full font-medium">Linux backend</span>
          </div>
        </div>
      </div>
    </section>

    <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
      <h3 className="font-semibold text-slate-800 mb-3">Обновления</h3>
      <p className="text-sm text-slate-600 mb-4">
        Проверяется опубликованный пакет для этой системы в GitHub Release <code>dist</code>.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void checkForUpdates()}
          disabled={checking || installing || updateStatus.status === 'installing'}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {checking ? 'Проверка…' : 'Проверить обновления'}
        </button>
        {updateInfo?.updateAvailable && (
          <button
            type="button"
            onClick={() => void installUpdate()}
            disabled={!updateInfo.canInstall || installing || updateStatus.status === 'installing'}
            className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {installing ? 'Запуск установки…' : `Установить ${updateInfo.latestVersion}`}
          </button>
        )}
        <a
          className="text-sm text-blue-600 hover:underline"
          href="https://github.com/teanrus/Backup-Manager/releases/tag/dist"
          target="_blank"
          rel="noopener noreferrer"
        >
          Открыть список релизов
        </a>
      </div>
      {updateInfo && (
        <p className="text-sm text-slate-600 mt-3" role="status">
          {updateInfo.updateAvailable
            ? `Доступно обновление ${updateInfo.latestVersion} (установлена ${updateInfo.currentVersion}, формат ${updateInfo.format.toUpperCase()}).`
            : `Установлена последняя версия ${updateInfo.currentVersion}.`}
        </p>
      )}
      {updateInfo?.updateAvailable && !updateInfo.canInstall && (
        <p className="text-sm text-amber-700 mt-2">{updateInfo.installUnavailableReason}</p>
      )}
      {updateError && <p className="text-sm text-red-700 mt-3" role="alert">{updateError}</p>}
      {updateStatus.status === 'installing' && (
        <p className="text-sm text-amber-700 mt-3" role="status">
          Устанавливается версия {updateStatus.targetVersion}. Backend может временно перезапуститься; дождитесь завершения обновления.
        </p>
      )}
      {updateStatus.status === 'installed' && (
        <p className="text-sm text-green-700 mt-3" role="status">
          Версия {updateStatus.targetVersion} установлена. Перезагрузите страницу, чтобы загрузить обновлённый интерфейс.
        </p>
      )}
      {updateStatus.status === 'failed' && (
        <p className="text-sm text-red-700 mt-3" role="alert">
          Установка версии {updateStatus.targetVersion} завершилась ошибкой
          {typeof updateStatus.exitCode === 'number' ? ` (код ${updateStatus.exitCode})` : ''}.
          {updateStatus.unitName && <> Диагностика: <code>journalctl -u {updateStatus.unitName}</code>.</>}
        </p>
      )}
      <p className="text-xs text-slate-500 mt-3">
        Установка обновления заменит системный пакет и перезапустит API. Запускайте её, когда задания синхронизации не выполняются.
      </p>
    </section>

    <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
      <h3 className="font-semibold text-slate-800 mb-4">Что умеет приложение</h3>
      <ul className="space-y-3 text-sm text-slate-600">
        <li><i className="fa-solid fa-check text-green-600 mr-2"></i>Хранить задания, SMB-параметры и настройки локально.</li>
        <li><i className="fa-solid fa-check text-green-600 mr-2"></i>Проверять доступ к SMB-ресурсу и запускать синхронизацию.</li>
        <li><i className="fa-solid fa-check text-green-600 mr-2"></i>Создавать архивы, просматривать хранилище и скачивать или восстанавливать данные.</li>
        <li><i className="fa-solid fa-check text-green-600 mr-2"></i>Проверять планируемые изменения rsync в режиме dry-run.</li>
        <li><i className="fa-solid fa-check text-green-600 mr-2"></i>Выполнять ежедневное, еженедельное и почасовое расписание.</li>
        <li><i className="fa-solid fa-check text-green-600 mr-2"></i>Показывать состояние заданий и журнал событий.</li>
      </ul>
      <p className="mt-5 text-sm text-slate-500">
        Для работы с SMB на Linux необходимы Node.js 18+, rsync, smbclient, cifs-utils и права на монтирование сетевых ресурсов.
      </p>
    </section>

  </div>
  );
};
