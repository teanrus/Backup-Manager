import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkForUpdate, readUpdateStatus, startPackageUpdate } from './updater.js';

const dataDir = path.resolve(process.env.BACKUP_MANAGER_DATA_DIR || path.join(os.homedir(), '.backup-manager'));
const statePath = path.join(dataDir, 'state.json');
const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiTokenPath = process.env.BACKUP_MANAGER_API_TOKEN_FILE;
const maxRequestBytes = 1024 * 1024;
const stateSchemaVersion = 1;
const defaultExcludePatterns = [
  '.*',
  '/thinclient_drives/***',
  '*.desktop',
  '*.tmp',
  '*.tmp.*',
  '*.temp',
  '*.temp.*',
  '*.swp',
  '*.swo',
  '*.swx',
  '*.part',
  '*.partial',
  '*.crdownload',
  '*.download',
  '*~',
  '~$*',
  '.~lock.*',
  '#*#',
];
const runningJobs = new Set();
const activeProcesses = new Map();
const cancelledJobs = new Set();
const scheduledRuns = new Map();
const pendingJobs = [];
let processingQueue = false;
let updateInstallStarting = false;

const defaultState = () => ({
  schemaVersion: stateSchemaVersion,
  jobs: [],
  logs: [],
  smbConfig: {
    server: '',
    share: '',
    username: '',
    password: '',
    domain: 'WORKGROUP',
    mountPoint: '/mnt/backup',
    connected: false,
  },
  settings: {
    compression: true,
    deleteExtra: false,
    verbose: false,
    inPlace: false,
    deleteDelay: false,
    createArchive: false,
    archiveRetention: 1,
    excludeLargeFiles: false,
    maxFileSizeMB: 50,
    excludePatterns: [...defaultExcludePatterns],
    bandwidthLimit: 0,
    retries: 3,
    notifyEmail: '',
    notifyOnError: true,
    notifyOnSuccess: false,
    logRetention: 30,
    parallelJobs: 1,
  },
});

await mkdir(dataDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);

let stateNeedsMigration = false;

async function loadState() {
  try {
    const contents = await readFile(statePath, 'utf8');
    const saved = JSON.parse(contents);
    const defaults = defaultState();
    const loadedState = {
      ...defaults,
      ...saved,
      jobs: Array.isArray(saved.jobs) ? saved.jobs : [],
      logs: Array.isArray(saved.logs) ? saved.logs.slice(0, 1000) : [],
      smbConfig: { ...defaults.smbConfig, ...saved.smbConfig },
      settings: { ...defaults.settings, ...saved.settings },
    };
    if ((saved.schemaVersion || 0) < stateSchemaVersion) {
      const patterns = Array.isArray(loadedState.settings.excludePatterns)
        ? loadedState.settings.excludePatterns
        : defaults.settings.excludePatterns;
      loadedState.settings.excludePatterns = [...new Set([...patterns, '*.desktop'])];
      loadedState.schemaVersion = stateSchemaVersion;
      stateNeedsMigration = true;
    }
    return loadedState;
  } catch (error) {
    if (error.code === 'ENOENT') return defaultState();
    throw new Error(`Не удалось прочитать файл состояния ${statePath}: ${error.message}`);
  }
}

let state = await loadState();
const apiToken = apiTokenPath ? (await readFile(apiTokenPath, 'utf8')).trim() : '';
if (apiTokenPath && !apiToken) throw new Error(`API token file is empty: ${apiTokenPath}`);
const interruptedJobs = state.jobs.filter(job => job.lastStatus === 'running');
for (const job of interruptedJobs) {
  job.lastStatus = 'error';
}
try {
  await chmod(statePath, 0o600);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
let saveQueue = Promise.resolve();

function saveState() {
  const snapshot = `${JSON.stringify(state, null, 2)}\n`;
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  saveQueue = saveQueue.then(async () => {
    await writeFile(temporaryPath, snapshot, { mode: 0o600 });
    await rename(temporaryPath, statePath);
  });
  return saveQueue;
}

if (stateNeedsMigration) await saveState();

function publicState() {
  const publicData = { ...state };
  delete publicData.schemaVersion;
  return {
    ...publicData,
    smbConfig: {
      ...state.smbConfig,
      password: '',
      passwordConfigured: Boolean(state.smbConfig.password),
    },
    backend: {
      platform: process.platform,
      canRunBackups: process.platform === 'linux',
    },
  };
}

async function addLog(level, message, jobName) {
  state.logs.unshift({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    message,
    jobName,
  });
  const retentionStart = Date.now() - state.settings.logRetention * 24 * 60 * 60 * 1000;
  state.logs = state.logs.filter(log => {
    const timestamp = Date.parse(log.timestamp);
    return Number.isNaN(timestamp) || timestamp >= retentionStart;
  }).slice(0, 1000);
  await saveState();
}

for (const job of interruptedJobs) {
  await addLog('error', 'Backend перезапущен до завершения задания.', job.name);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function isAuthorized(request) {
  if (!apiTokenPath) return true;
  const expected = Buffer.from(`backup:${apiToken}`).toString('base64');
  const supplied = request.headers.authorization?.match(/^Basic ([A-Za-z0-9+/=]+)$/)?.[1];
  return supplied === expected;
}

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    const error = new Error('Для этого запроса требуется Content-Type: application/json.');
    error.status = 415;
    throw error;
  }
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxRequestBytes) {
      const error = new Error('Размер запроса превышает 1 МБ.');
      error.status = 413;
      throw error;
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(body || '{}');
  } catch {
    const error = new Error('Некорректный JSON в запросе.');
    error.status = 400;
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('Тело запроса должно быть JSON-объектом.');
    error.status = 400;
    throw error;
  }
  return parsed;
}

function requireString(value, field, maxLength = 500) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    const error = new Error(`Поле «${field}» обязательно и должно содержать не более ${maxLength} символов.`);
    error.status = 400;
    throw error;
  }
  return value.trim();
}

function validateSchedule(schedule) {
  const validTypes = ['manual', 'hourly', 'daily', 'weekly'];
  if (!schedule || !validTypes.includes(schedule.type)) {
    const error = new Error('Указан неподдерживаемый тип расписания.');
    error.status = 400;
    throw error;
  }
  if (schedule.type !== 'manual' && schedule.type !== 'hourly' &&
      (typeof schedule.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time))) {
    const error = new Error('Время расписания должно быть в формате ЧЧ:ММ.');
    error.status = 400;
    throw error;
  }
  if (schedule.type === 'weekly' && (!Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6)) {
    const error = new Error('Для еженедельного расписания укажите день недели от 0 до 6.');
    error.status = 400;
    throw error;
  }
  return structuredClone(schedule);
}

function runCommand(command, args, options = {}) {
  const { onStdout, onStderr, jobId, ...spawnOptions } = options;
  if (jobId && cancelledJobs.has(jobId)) return Promise.reject(new Error('Задание остановлено.'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
      ...spawnOptions,
    });
    if (jobId) activeProcesses.set(jobId, child);
    let stdout = '';
    let stderr = '';
    const appendOutput = (current, chunk) => {
      return `${current}${chunk.toString()}`.slice(-100_000);
    };
    child.stdout.on('data', chunk => {
      stdout = appendOutput(stdout, chunk);
      onStdout?.(chunk.toString());
    });
    child.stderr.on('data', chunk => {
      stderr = appendOutput(stderr, chunk);
      onStderr?.(chunk.toString());
    });
    child.once('error', error => {
      if (jobId && activeProcesses.get(jobId) === child) activeProcesses.delete(jobId);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (jobId && activeProcesses.get(jobId) === child) activeProcesses.delete(jobId);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const status = code === null
        ? `${command} завершился по сигналу ${signal || 'неизвестно'}`
        : `${command} завершился с кодом ${code}`;
      const details = stderr.trim() || 'Команда не сообщила подробностей в stderr.';
      reject(new Error(`${status}:\n${details}`));
    });
  });
}

async function withCredentials(callback) {
  const credentialsDir = path.join(dataDir, `credentials-${randomUUID()}`);
  await mkdir(credentialsDir, { mode: 0o700 });
  const credentialsPath = path.join(credentialsDir, 'smb-credentials');
  const { username, password, domain } = state.smbConfig;
  await writeFile(credentialsPath, `username=${username}\npassword=${password}\ndomain=${domain}\n`, { mode: 0o600 });
  try {
    return await callback(credentialsPath);
  } finally {
    await rm(credentialsDir, { recursive: true, force: true });
  }
}

function validateSmbConfig(input) {
  const server = requireString(input.server, 'сервер', 253);
  const share = requireString(input.share, 'общий ресурс', 255);
  const username = requireString(input.username, 'пользователь', 256);
  const password = typeof input.password === 'string' ? input.password : '';
  const domain = typeof input.domain === 'string' ? input.domain.trim() : 'WORKGROUP';
  const mountPoint = requireString(input.mountPoint, 'точка монтирования', 1024);
  if (/[\\/\s]/.test(server) || /[\\/\s]/.test(share) || /[\r\n]/.test(username + password + domain)) {
    const error = new Error('Проверьте сервер, имя ресурса и учётные данные.');
    error.status = 400;
    throw error;
  }
  if (!path.isAbsolute(mountPoint) || path.resolve(mountPoint) === path.parse(mountPoint).root) {
    const error = new Error('Точка монтирования должна быть абсолютным путём, отличным от корня файловой системы.');
    error.status = 400;
    throw error;
  }
  return { server, share, username, password, domain, mountPoint, connected: false };
}

function assertSeparatePaths(source, mountPoint) {
  const isWithin = (candidate, parent) => {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  if (isWithin(source, mountPoint) || isWithin(mountPoint, source)) {
    const error = new Error('Источник и точка монтирования не должны находиться друг внутри друга.');
    error.status = 400;
    throw error;
  }
}

function safeDirectoryName(name) {
  const safeName = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return safeName && safeName !== '.' && safeName !== '..' ? safeName : '_';
}

async function testSmbConnection() {
  if (process.platform !== 'linux') {
    const error = new Error('Проверка SMB и монтирование пока поддерживаются только в Linux.');
    error.status = 501;
    throw error;
  }
  return withCredentials(credentialsPath =>
    runCommand('smbclient', [`//${state.smbConfig.server}/${state.smbConfig.share}`, '-A', credentialsPath, '-c', 'ls'], { timeout: 15000 }),
  );
}

async function mountShare(sourcePath) {
  const { server, share, mountPoint } = state.smbConfig;
  try {
    const existingMount = spawnSync('findmnt', ['-n', '-o', 'SOURCE', '--mountpoint', mountPoint], { encoding: 'utf8' });
    if (existingMount.error) throw new Error(`Не удалось проверить точку монтирования: ${existingMount.error.message}`);
    if (existingMount.status === 0 && existingMount.stdout.trim() !== `//${server}/${share}`) {
      throw new Error(`Точка ${mountPoint} уже занята другим подключением (${existingMount.stdout.trim()}).`);
    }

    if (existingMount.status !== 0) await mkdir(mountPoint, { recursive: true });
    const resolvedMountPoint = await realpath(mountPoint);
    if (sourcePath) assertSeparatePaths(sourcePath, resolvedMountPoint);

    if (existingMount.status === 0) {
      return resolvedMountPoint;
    }

    await withCredentials(credentialsPath =>
      runCommand('mount.cifs', [`//${server}/${share}`, mountPoint, '-o', `credentials=${credentialsPath},iocharset=utf8,file_mode=0700,dir_mode=0700,_netdev`]),
    );
    return resolvedMountPoint;
  } catch (error) {
    if (['EHOSTDOWN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTCONN', 'EIO'].includes(error.code)) {
      throw new Error(`SMB-ресурс //${server}/${share} в точке ${mountPoint} недоступен (${error.code}). Проверьте сеть и состояние CIFS-монтирования.`);
    }
    throw error;
  }
}

async function runBackup(jobId, dryRun = false) {
  const job = state.jobs.find(item => item.id === jobId);
  if (!job) {
    const error = new Error('Задание не найдено.');
    error.status = 404;
    throw error;
  }
  const updateStatus = await readUpdateStatus(dataDir);
  if (updateInstallStarting || updateStatus.status === 'installing') {
    const error = new Error('Нельзя запускать синхронизацию во время установки обновления.');
    error.status = 409;
    throw error;
  }
  if (runningJobs.has(jobId)) {
    const error = new Error('Это задание уже выполняется.');
    error.status = 409;
    throw error;
  }
  if (process.platform !== 'linux') {
    const error = new Error('Запуск резервного копирования сейчас поддерживается только в Linux.');
    error.status = 501;
    throw error;
  }
  if (!state.smbConfig.server || !state.smbConfig.share || !state.smbConfig.username) {
    const error = new Error('Сначала настройте SMB-подключение.');
    error.status = 400;
    throw error;
  }

  const previousStatus = job.lastStatus;
  runningJobs.add(jobId);
  cancelledJobs.delete(jobId);
  try {
    const sourcePath = path.resolve(job.sourcePath);
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) throw new Error(`Источник не является каталогом: ${sourcePath}`);
    assertSeparatePaths(sourcePath, path.resolve(state.smbConfig.mountPoint));
    job.lastStatus = 'running';
    await saveState();
    await addLog('info', dryRun ? 'Проверка синхронизации запущена.' : 'Синхронизация запущена.', job.name);
    pendingJobs.push({ jobId, dryRun, previousStatus });
  } catch (error) {
    runningJobs.delete(jobId);
    job.lastStatus = previousStatus;
    if (!error.status) error.status = 400;
    throw error;
  }
  void drainQueue();
}

function getTarChangedFiles(error) {
  if (!(error instanceof Error)) return null;
  const diagnostic = error.message.match(/^tar завершился с кодом 1:\n([\s\S]+)$/)?.[1];
  if (!diagnostic) return null;
  const lines = diagnostic.split(/\r?\n/);
  const changedFiles = lines.map(line => line.match(/^tar: (.+): file changed as we read it$/)?.[1]);
  return changedFiles.length > 0 && changedFiles.every(Boolean) ? changedFiles : null;
}

async function createArchive(destination, archiveDirectory, archivePrefix, retention, jobId) {
  await mkdir(archiveDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = path.join(archiveDirectory, `${archivePrefix}-${timestamp}.tar.gz`);
  const temporaryArchivePath = `${archivePath}.tmp`;
  try {
    await runCommand('tar', ['-czf', temporaryArchivePath, '-C', destination, '.'], { jobId });
    await rename(temporaryArchivePath, archivePath);
  } catch (error) {
    try {
      await unlink(temporaryArchivePath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    }
    const changedFiles = getTarChangedFiles(error);
    if (changedFiles) return { skipped: true, changedFiles };
    throw error;
  }
  const archives = (await readdir(archiveDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.startsWith(`${archivePrefix}-`) && entry.name.endsWith('.tar.gz'))
    .sort((left, right) => right.name.localeCompare(left.name));
  await Promise.all(archives.slice(retention).map(entry => unlink(path.join(archiveDirectory, entry.name))));
  return { skipped: false };
}

async function executeBackup({ jobId, dryRun, previousStatus }) {
  const job = state.jobs.find(item => item.id === jobId);
  if (!job) return;
  let cancelled = false;
  try {
    const sourcePath = await realpath(path.resolve(job.sourcePath));
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) throw new Error(`Источник не является каталогом: ${sourcePath}`);
    assertSeparatePaths(sourcePath, path.resolve(state.smbConfig.mountPoint));
    const mountPoint = await mountShare(sourcePath);
    const destination = path.join(mountPoint, safeDirectoryName(os.hostname()), safeDirectoryName(job.name));
    if (!dryRun) await mkdir(destination, { recursive: true });
    const settings = state.settings;
    const args = [
      '-a',
      '--no-links',
      '--no-devices',
      '--no-specials',
      '--one-file-system',
      '--stats',
    ];
    args.push(...settings.excludePatterns.map(pattern => `--exclude=${pattern}`));
    if (settings.excludeLargeFiles) args.push(`--max-size=${settings.maxFileSizeMB}MB`);
    if (settings.compression) args.push('-z');
    if (settings.verbose) args.push('-v');
    if (settings.deleteExtra) args.push(settings.deleteDelay ? '--delete-delay' : '--delete');
    if (settings.inPlace) args.push('--inplace');
    if (dryRun) args.push('--dry-run', '--itemize-changes');
    else args.push('--info=progress2');
    if (settings.bandwidthLimit > 0) args.push(`--bwlimit=${settings.bandwidthLimit * 1000}`);
    args.push(`${sourcePath}${path.sep}`, `${destination}${path.sep}`);

    let result;
    let progressOutput = '';
    for (let attempt = 1; attempt <= settings.retries; attempt += 1) {
      try {
        result = await runCommand('rsync', args, {
          jobId,
          onStderr: chunk => {
            progressOutput = `${progressOutput}${chunk}`.slice(-2000);
            const percentages = [...progressOutput.matchAll(/(\d{1,3})%/g)];
            if (percentages.length) {
              job.progress = Math.min(100, Number(percentages.at(-1)[1]));
              job.progressMessage = `Передача данных: ${job.progress}%`;
            }
          },
        });
        break;
      } catch (error) {
        if (cancelledJobs.has(jobId)) throw error;
        if (attempt === settings.retries) throw error;
        await addLog('warning', `Попытка ${attempt} завершилась ошибкой: ${error.message}`, job.name);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    if (cancelledJobs.has(jobId)) throw new Error('Задание остановлено.');
    if (dryRun) {
      const deletions = result.split(/\r?\n/).filter(line => line.includes('*deleting'));
      const report = deletions.length
        ? `Будут удалены:\n${deletions.join('\n')}`
        : 'Проверка завершена. Файлов для удаления не обнаружено.';
      await addLog(deletions.length ? 'warning' : 'success', report, job.name);
      job.lastStatus = previousStatus;
      return;
    }

    const fileCount = result?.match(/Number of files:\s*([\d,]+)/)?.[1]?.replaceAll(',', '');
    const totalBytes = result?.match(/Total file size:\s*([\d,]+) bytes/)?.[1]?.replaceAll(',', '');
    if (fileCount) job.filesCount = Number(fileCount);
    if (totalBytes) {
      const bytes = Number(totalBytes);
      job.size = bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} ГБ` : `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
    }
    let archiveSkipped = false;
    let archiveChangedFiles = [];
    if (settings.createArchive) {
      job.progressMessage = 'Создание архива…';
      const archiveRoot = path.join(mountPoint, safeDirectoryName(os.hostname()), 'archives');
      const archivePrefix = safeDirectoryName(job.name);
      const archiveResult = await createArchive(path.join(mountPoint, safeDirectoryName(os.hostname()), safeDirectoryName(job.name)),
        archiveRoot, archivePrefix, settings.archiveRetention, jobId);
      archiveSkipped = archiveResult.skipped;
      archiveChangedFiles = archiveResult.changedFiles || [];
    }
    job.lastStatus = 'success';
    job.lastRun = new Date().toLocaleString('ru-RU', { hour12: false });
    await saveState();
    const stats = result?.match(/Number of files:.*|Total file size:.*|sent .* bytes.*received .*/g)?.join(' · ');
    if (archiveSkipped) {
      const filesMessage = archiveChangedFiles.length
        ? ` Изменявшиеся файлы: ${archiveChangedFiles.slice(0, 5).join(', ')}${archiveChangedFiles.length > 5 ? ` и ещё ${archiveChangedFiles.length - 5}` : ''}.`
        : '';
      await addLog('warning', `Синхронизация завершена, но архив не создан: файлы изменялись во время архивирования. Предыдущие архивы сохранены.${filesMessage}${stats ? ` ${stats}` : ''}`, job.name);
    } else {
      await addLog('success', `Синхронизация завершена.${settings.createArchive ? ' Архив создан.' : ''}${stats ? ` ${stats}` : ''}`, job.name);
    }
  } catch (error) {
    cancelled = cancelledJobs.has(jobId);
    if (cancelled) {
      job.lastStatus = 'cancelled';
      await addLog('warning', 'Задание остановлено пользователем.', job.name);
    } else {
      job.lastStatus = dryRun ? previousStatus : 'error';
      if (!dryRun) job.lastRun = new Date().toLocaleString('ru-RU', { hour12: false });
      await addLog('error', `Ошибка синхронизации: ${error.message}`, job.name);
    }
  } finally {
    job.progress = null;
    job.progressMessage = undefined;
    runningJobs.delete(jobId);
    cancelledJobs.delete(jobId);
    await saveState();
  }
}

async function drainQueue() {
  if (processingQueue) return;
  processingQueue = true;
  try {
    while (pendingJobs.length > 0) {
      try {
        await executeBackup(pendingJobs.shift());
      } catch (error) {
        console.error('Backup queue error:', error);
      }
    }
  } finally {
    processingQueue = false;
    if (pendingJobs.length > 0) void drainQueue();
  }
}

function scheduleIsDue(job, now) {
  if (!job.enabled || !job.schedule || job.schedule.type === 'manual') return false;
  if (job.schedule.type === 'hourly') return now.getMinutes() === 0;
  if (job.schedule.time !== `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`) return false;
  return job.schedule.type === 'daily' || (job.schedule.type === 'weekly' && job.schedule.dayOfWeek === now.getDay());
}

async function recoveryRoot() {
  if (!state.smbConfig.server || !state.smbConfig.share || !state.smbConfig.username) {
    const error = new Error('Сначала настройте SMB-подключение.');
    error.status = 400;
    throw error;
  }
  const mountPoint = await mountShare();
  const root = path.join(mountPoint, safeDirectoryName(os.hostname()));
  await mkdir(root, { recursive: true });
  return root;
}

async function resolveRecoveryPath(relativePath) {
  const root = await recoveryRoot();
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    const error = new Error('Каталог хранилища этой машины недоступен.');
    error.status = 400;
    throw error;
  }
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    const error = new Error('Некорректный путь к данным восстановления.');
    error.status = 400;
    throw error;
  }
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const error = new Error('Путь должен находиться в каталоге этой машины.');
    error.status = 400;
    throw error;
  }
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const entryStats = await lstat(current);
    if (entryStats.isSymbolicLink()) {
      const error = new Error('Символические ссылки в хранилище восстановления не поддерживаются.');
      error.status = 400;
      throw error;
    }
  }
  return target;
}

async function listRecoveryEntries(relativePath) {
  const directory = await resolveRecoveryPath(relativePath);
  const directoryStats = await stat(directory);
  if (!directoryStats.isDirectory()) {
    const error = new Error('Выбранный путь не является каталогом.');
    error.status = 400;
    throw error;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const listed = await Promise.all(entries.map(async entry => {
    if (!entry.isDirectory() && !entry.isFile()) return null;
    const entryPath = path.join(directory, entry.name);
    const entryStats = await lstat(entryPath);
    if (entryStats.isSymbolicLink()) return null;
    return {
      name: entry.name,
      path: path.posix.join(relativePath.split(path.sep).join(path.posix.sep), entry.name),
      type: entry.isDirectory() ? 'directory' : 'file',
      size: entryStats.size,
      modifiedAt: entryStats.mtime.toISOString(),
    };
  }));
  return listed.filter(Boolean).sort((left, right) =>
    left.type !== right.type ? (left.type === 'directory' ? -1 : 1) : left.name.localeCompare(right.name, 'ru'),
  );
}

async function listLocalDirectories(requestedPath) {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath) ||
      requestedPath.length > 4096 || requestedPath.includes('\0')) {
    const error = new Error('Путь должен быть допустимым абсолютным путём.');
    error.status = 400;
    throw error;
  }
  const directoryPath = await realpath(path.resolve(requestedPath));
  if (!(await stat(directoryPath)).isDirectory()) {
    const error = new Error('Выбранный путь не является каталогом.');
    error.status = 400;
    throw error;
  }
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const directories = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const entryPath = path.join(directoryPath, entry.name);
    let resolvedEntryPath = entryPath;
    if (entry.isSymbolicLink()) {
      try {
        resolvedEntryPath = await realpath(entryPath);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!(await stat(resolvedEntryPath)).isDirectory()) continue;
    }
    directories.push({ name: entry.name, path: resolvedEntryPath });
  }
  directories.sort((left, right) => left.name.localeCompare(right.name, 'ru'));
  return { path: directoryPath, directories };
}

setInterval(() => {
  const now = new Date();
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  for (const job of state.jobs) {
    if (scheduleIsDue(job, now) && scheduledRuns.get(job.id) !== minuteKey) {
      scheduledRuns.set(job.id, minuteKey);
      void runBackup(job.id).catch(error => addLog('error', error.message, job.name));
    }
  }
}, 15000).unref();

async function handleRequest(request, response) {
  const host = request.headers.host?.replace(/:\d+$/, '');
  const remoteAddress = request.socket.remoteAddress;
  const origin = request.headers.origin;
  const allowedOrigins = new Set([
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);
  if (!['localhost', '127.0.0.1'].includes(host) ||
      (origin && !allowedOrigins.has(origin)) ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
    return sendJson(response, 403, { error: 'Доступ разрешён только с этого компьютера.' });
  }
  if (!isAuthorized(request)) {
    response.setHeader('WWW-Authenticate', 'Basic realm="Backup Manager"');
    return sendJson(response, 401, { error: 'Требуется авторизация.' });
  }

  const url = new URL(request.url, 'http://localhost');
  try {
    if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { ready: true });
    if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, 200, publicState());
    if (request.method === 'GET' && url.pathname === '/api/updates') {
      return sendJson(response, 200, await checkForUpdate());
    }
    if (request.method === 'GET' && url.pathname === '/api/updates/status') {
      return sendJson(response, 200, await readUpdateStatus(dataDir));
    }
    if (request.method === 'POST' && url.pathname === '/api/updates/install') {
      if (process.getuid?.() !== 0) {
        const error = new Error('Для установки обновлений backend должен работать с правами root.');
        error.status = 403;
        throw error;
      }
      if (runningJobs.size > 0) {
        const error = new Error('Нельзя обновлять приложение, пока выполняются задания синхронизации.');
        error.status = 409;
        throw error;
      }
      if (updateInstallStarting) {
        const error = new Error('Установка обновления уже запускается.');
        error.status = 409;
        throw error;
      }
      updateInstallStarting = true;
      try {
        const currentUpdateStatus = await readUpdateStatus(dataDir);
        if (currentUpdateStatus.status === 'installing') {
          const error = new Error('Обновление уже устанавливается.');
          error.status = 409;
          throw error;
        }
        const update = await checkForUpdate();
        if (!update.updateAvailable) {
          const error = new Error('Установлена последняя доступная версия.');
          error.status = 409;
          throw error;
        }
        if (!update.canInstall) {
          const error = new Error(update.installUnavailableReason);
          error.status = 501;
          throw error;
        }
        const status = await startPackageUpdate(
          update,
          dataDir,
          path.join(serverDirectory, 'install-package-update.sh'),
        );
        return sendJson(response, 202, status);
      } finally {
        updateInstallStarting = false;
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/directories') {
      return sendJson(response, 200, await listLocalDirectories(url.searchParams.get('path')));
    }

    if (request.method === 'POST' && url.pathname === '/api/jobs') {
      const body = await readJson(request);
      const job = {
        id: randomUUID(),
        name: requireString(body.name, 'название', 100),
        sourcePath: requireString(body.sourcePath, 'путь к каталогу', 1024),
        enabled: Boolean(body.enabled),
        schedule: validateSchedule(body.schedule),
        size: '—',
        filesCount: 0,
        lastRun: null,
        lastStatus: 'never',
      };
      if (!path.isAbsolute(job.sourcePath)) {
        const error = new Error('Путь к исходному каталогу должен быть абсолютным.');
        error.status = 400;
        throw error;
      }
      state.jobs.push(job);
      await saveState();
      await addLog('info', `Добавлено задание «${job.name}».`);
      return sendJson(response, 201, job);
    }

    const jobRoute = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/i);
    if (jobRoute) {
      const job = state.jobs.find(item => item.id === jobRoute[1]);
      if (!job) return sendJson(response, 404, { error: 'Задание не найдено.' });
      if (request.method === 'PATCH') {
        if (runningJobs.has(job.id)) return sendJson(response, 409, { error: 'Нельзя редактировать задание во время выполнения.' });
        const body = await readJson(request);
        if ('enabled' in body) job.enabled = Boolean(body.enabled);
        if ('schedule' in body) job.schedule = validateSchedule(body.schedule);
        if ('name' in body) job.name = requireString(body.name, 'название', 100);
        if ('sourcePath' in body) {
          const sourcePath = requireString(body.sourcePath, 'путь к каталогу', 1024);
          if (!path.isAbsolute(sourcePath)) {
            const error = new Error('Путь к исходному каталогу должен быть абсолютным.');
            error.status = 400;
            throw error;
          }
          job.sourcePath = sourcePath;
        }
        await saveState();
        await addLog('info', `Обновлено задание «${job.name}».`);
        return sendJson(response, 200, job);
      }
      if (request.method === 'DELETE') {
        if (runningJobs.has(job.id)) return sendJson(response, 409, { error: 'Нельзя удалить задание во время выполнения.' });
        state.jobs = state.jobs.filter(item => item.id !== job.id);
        await saveState();
        await addLog('info', `Удалено задание «${job.name}».`);
        return sendJson(response, 200, { ok: true });
      }
    }

    const runRoute = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/run$/i);
    if (request.method === 'POST' && runRoute) {
      await runBackup(runRoute[1]);
      return sendJson(response, 202, { accepted: true });
    }

    const dryRunRoute = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/dry-run$/i);
    if (request.method === 'POST' && dryRunRoute) {
      await runBackup(dryRunRoute[1], true);
      return sendJson(response, 202, { accepted: true });
    }

    const stopRoute = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/stop$/i);
    if (request.method === 'POST' && stopRoute) {
      const job = state.jobs.find(item => item.id === stopRoute[1]);
      if (!job) return sendJson(response, 404, { error: 'Задание не найдено.' });
      if (!runningJobs.has(job.id)) return sendJson(response, 409, { error: 'Задание не выполняется.' });
      cancelledJobs.add(job.id);
      const queuedIndex = pendingJobs.findIndex(item => item.jobId === job.id);
      if (queuedIndex !== -1) {
        pendingJobs.splice(queuedIndex, 1);
        cancelledJobs.delete(job.id);
        runningJobs.delete(job.id);
        job.lastStatus = 'cancelled';
        job.progress = null;
        job.progressMessage = undefined;
        await addLog('warning', 'Задание остановлено до начала передачи.', job.name);
      } else {
        activeProcesses.get(job.id)?.kill('SIGTERM');
      }
      await saveState();
      return sendJson(response, 202, { accepted: true });
    }

    if (request.method === 'GET' && url.pathname === '/api/recovery') {
      const relativePath = url.searchParams.get('path') || '';
      return sendJson(response, 200, { path: relativePath, entries: await listRecoveryEntries(relativePath) });
    }

    if (request.method === 'GET' && url.pathname === '/api/recovery/download') {
      const relativePath = url.searchParams.get('path') || '';
      const filePath = await resolveRecoveryPath(relativePath);
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) {
        const error = new Error('Скачать можно только файл.');
        error.status = 400;
        throw error;
      }
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileStats.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      createReadStream(filePath).pipe(response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/recovery/restore') {
      const body = await readJson(request);
      const source = await resolveRecoveryPath(body.path);
      const target = requireString(body.targetPath, 'каталог восстановления', 1024);
      if (!path.isAbsolute(target) || path.resolve(target) === path.parse(target).root) {
        const error = new Error('Каталог восстановления должен быть абсолютным путём, отличным от корня.');
        error.status = 400;
        throw error;
      }
      assertSeparatePaths(path.resolve(target), path.resolve(state.smbConfig.mountPoint));
      const sourceStats = await stat(source);
      if (!sourceStats.isFile() && !sourceStats.isDirectory()) {
        const error = new Error('Выбранный объект нельзя восстановить.');
        error.status = 400;
        throw error;
      }
      await mkdir(target, { recursive: true });
      if (await realpath(target) !== path.resolve(target)) {
        const error = new Error('Каталог восстановления не должен проходить через символическую ссылку.');
        error.status = 400;
        throw error;
      }
      if ((await readdir(target)).length > 0) {
        const error = new Error('Каталог восстановления должен быть пустым, чтобы избежать перезаписи файлов.');
        error.status = 409;
        throw error;
      }
      if (sourceStats.isFile() && source.endsWith('.tar.gz')) {
        await runCommand('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', source, '-C', target]);
      } else {
        const args = ['-a', '--no-links', '--no-devices', '--no-specials', '--one-file-system'];
        args.push(sourceStats.isDirectory() ? `${source}${path.sep}` : source, `${target}${path.sep}`);
        await runCommand('rsync', args);
      }
      await addLog('success', `Данные восстановлены в ${target}.`);
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'PUT' && url.pathname === '/api/smb') {
      const body = await readJson(request);
      const config = validateSmbConfig(body);
      if (!config.password) config.password = state.smbConfig.password;
      state.smbConfig = config;
      await saveState();
      await addLog('info', 'Сохранены настройки SMB-подключения.');
      return sendJson(response, 200, publicState().smbConfig);
    }

    if (request.method === 'POST' && url.pathname === '/api/smb/test') {
      await testSmbConnection();
      state.smbConfig.connected = true;
      await saveState();
      await addLog('success', 'SMB-подключение проверено.');
      return sendJson(response, 200, { connected: true });
    }

    if (request.method === 'PUT' && url.pathname === '/api/settings') {
      const body = await readJson(request);
      const requestedExcludePatterns = body.excludePatterns === undefined
        ? defaultExcludePatterns
        : body.excludePatterns;
      if (!Array.isArray(requestedExcludePatterns) || requestedExcludePatterns.length > 100 ||
          requestedExcludePatterns.some(pattern =>
            typeof pattern !== 'string' || pattern.length > 500 || /[\r\n\0]/.test(pattern))) {
        const error = new Error('Маски исключения должны быть строками до 500 символов; допускается не более 100 масок.');
        error.status = 400;
        throw error;
      }
      const settings = {
        compression: Boolean(body.compression),
        deleteExtra: Boolean(body.deleteExtra),
        verbose: Boolean(body.verbose),
        inPlace: Boolean(body.inPlace),
        deleteDelay: Boolean(body.deleteDelay),
        createArchive: Boolean(body.createArchive),
        archiveRetention: body.archiveRetention === undefined ? 1 : Number(body.archiveRetention),
        excludeLargeFiles: Boolean(body.excludeLargeFiles),
        maxFileSizeMB: body.maxFileSizeMB === undefined ? 50 : Number(body.maxFileSizeMB),
        excludePatterns: requestedExcludePatterns.map(pattern => pattern.trim()).filter(Boolean),
        bandwidthLimit: Number(body.bandwidthLimit),
        retries: Number(body.retries),
        notifyEmail: typeof body.notifyEmail === 'string' ? body.notifyEmail.trim() : '',
        notifyOnError: Boolean(body.notifyOnError),
        notifyOnSuccess: Boolean(body.notifyOnSuccess),
        logRetention: Number(body.logRetention),
        parallelJobs: Number(body.parallelJobs),
      };
      if (      !Number.isSafeInteger(settings.bandwidthLimit) || settings.bandwidthLimit < 0 || settings.bandwidthLimit > 1000000 ||
          !Number.isInteger(settings.retries) || settings.retries < 1 || settings.retries > 10 ||
      !Number.isInteger(settings.archiveRetention) || settings.archiveRetention < 1 || settings.archiveRetention > 100 ||
      !Number.isInteger(settings.maxFileSizeMB) || settings.maxFileSizeMB < 1 || settings.maxFileSizeMB > 1000000 ||
      !Number.isInteger(settings.logRetention) || settings.logRetention < 1 || settings.logRetention > 3650 ||
          !Number.isInteger(settings.parallelJobs) || settings.parallelJobs !== 1) {
        const error = new Error('Проверьте ограничения скорости, количество попыток и срок хранения журналов.');
        error.status = 400;
        throw error;
      }
      state.settings = settings;
      await saveState();
      await addLog('info', 'Сохранены общие настройки.');
      return sendJson(response, 200, state.settings);
    }

    return sendJson(response, 404, { error: 'API-метод не найден.' });
  } catch (error) {
    const status = error.status || (error.code === 'ENOENT' ? 503 : 500);
    if (status >= 500) console.error(error);
    return sendJson(response, status, { error: error.message || 'Внутренняя ошибка backend.' });
  }
}

const port = Number(process.env.BACKUP_MANAGER_PORT || 3001);
const host = process.env.BACKUP_MANAGER_HOST || '127.0.0.1';
const server = createServer((request, response) => void handleRequest(request, response));
server.listen(port, host, () => console.log(`Backup Manager API listens on http://${host}:${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
