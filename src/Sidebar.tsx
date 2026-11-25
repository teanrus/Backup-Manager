import React from 'react';
import appIcon from '../assets/backup-manager.svg';
import { Page } from './types';
import { appVersion } from './version';

interface SidebarProps {
  currentPage: Page;
  onPageChange: (page: Page) => void;
}

const menuItems: { page: Page; icon: string; label: string }[] = [
  { page: 'dashboard', icon: 'fa-gauge-high', label: 'Обзор' },
  { page: 'jobs', icon: 'fa-list-check', label: 'Задания' },
  { page: 'recovery', icon: 'fa-box-open', label: 'Восстановление' },
  { page: 'schedule', icon: 'fa-clock', label: 'Расписание' },
  { page: 'smb', icon: 'fa-server', label: 'SMB сервер' },
  { page: 'logs', icon: 'fa-file-lines', label: 'Журнал' },
  { page: 'settings', icon: 'fa-gear', label: 'Настройки' },
  { page: 'about', icon: 'fa-circle-info', label: 'О программе' },
];

export const Sidebar: React.FC<SidebarProps> = ({ currentPage, onPageChange }) => {
  return (
    <aside className="w-64 bg-slate-900 text-white flex flex-col min-h-screen">
      <div className="p-5 border-b border-slate-700">
        <div className="flex items-center gap-3">
          <img src={appIcon} alt="" className="w-10 h-10 rounded-lg" />
          <div>
            <h1 className="font-bold text-sm">Backup Manager</h1>
            <p className="text-xs text-slate-400">Синхронизация каталогов</p>
          </div>
        </div>
      </div>
      <nav className="flex-1 p-3">
        <ul className="space-y-1">
          {menuItems.map((item) => (
            <li key={item.page}>
              <button
                onClick={() => onPageChange(item.page)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-all ${
                  currentPage === item.page
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <i className={`fa-solid ${item.icon} w-5 text-center`}></i>
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="p-4 border-t border-slate-700 text-xs text-slate-400">
        Версия: {appVersion}
      </div>
    </aside>
  );
};
