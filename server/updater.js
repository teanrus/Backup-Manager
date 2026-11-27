import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repository = 'teanrus/Backup-Manager';
const releaseTag = 'dist';
const releaseApiUrl = `https://api.github.com/repos/${repository}/releases/tags/${releaseTag}`;
const releasePageUrl = `https://github.com/${repository}/releases/tag/${releaseTag}`;
const maxPackageBytes = 250 * 1024 * 1024;

function runQuery(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.error?.code === 'ENOENT') return null;
  if (result.error) throw new Error(`Не удалось выполнить ${command}: ${result.error.message}`);
  return result.status === 0 ? result.stdout.trim() : null;
}

function commandAvailable(command) {
  return spawnSync('/bin/sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command]).status === 0;
}

function parsePackageVersion(value) {
  const match = value.match(/^(?<application>\d+(?:\.\d+)+)-(?<release>\d+)(?:\.[A-Za-z0-9._-]+)?$/);
  if (!match) throw new Error(`Неизвестный формат версии пакета: ${value}`);
  return {
    application: match.groups.application.split('.').map(Number),
    release: Number(match.groups.release),
  };
}

export function comparePackageVersions(left, right) {
  const leftVersion = parsePackageVersion(left);
  const rightVersion = parsePackageVersion(right);
  const segmentCount = Math.max(leftVersion.application.length, rightVersion.application.length);
  for (let index = 0; index < segmentCount; index += 1) {
    const difference = (leftVersion.application[index] || 0) - (rightVersion.application[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return Math.sign(leftVersion.release - rightVersion.release);
}

function parseAssetVersion(name, format) {
  const pattern = format === 'deb'
    ? /^backup-manager_(\d+(?:\.\d+)+)-(\d+)_all\.deb$/
    : /^backup-manager-(\d+(?:\.\d+)+)-(\d+)(?:\.[A-Za-z0-9._-]+)?\.noarch\.rpm$/;
  const match = name.match(pattern);
  return match ? `${match[1]}-${match[2]}` : null;
}

export function parseDebMetadata(output) {
  const fields = Object.fromEntries(
    output.split(/\r?\n/)
      .map(line => line.match(/^([A-Za-z0-9-]+):\s*(.*)$/))
      .filter(Boolean)
      .map(([, name, value]) => [name.toLowerCase(), value]),
  );
  return {
    name: fields.package,
    version: fields.version,
    architecture: fields.architecture,
  };
}

export function selectReleaseAsset(release, format) {
  if (!release || release.tag_name !== releaseTag || release.draft || !Array.isArray(release.assets)) {
    throw new Error(`Не удалось получить опубликованный GitHub Release с тегом ${releaseTag}.`);
  }
  const candidates = release.assets
    .filter(asset => typeof asset.name === 'string')
    .map(asset => ({ name: asset.name, version: parseAssetVersion(asset.name, format) }))
    .filter(asset => asset.version)
    .sort((left, right) => comparePackageVersions(right.version, left.version));
  if (!candidates.length) {
    throw new Error(`В Release ${releaseTag} не найден пакет формата ${format.toUpperCase()}.`);
  }
  return candidates[0];
}

export function getInstalledPackage() {
  const debVersion = runQuery('dpkg-query', ['-W', '-f=${Version}', 'backup-manager']);
  if (debVersion) {
    const installer = commandAvailable('apt-get') ? 'apt-get' : null;
    return {
      format: 'deb',
      currentVersion: debVersion,
      installer,
      canInstall: process.getuid?.() === 0 && Boolean(installer) && commandAvailable('systemd-run'),
    };
  }

  const rpmMetadata = runQuery('rpm', ['-q', '--qf', '%{VERSION}-%{RELEASE}\n%{ARCH}', 'backup-manager']);
  if (rpmMetadata) {
    const [currentVersion, architecture] = rpmMetadata.split(/\r?\n/);
    if (architecture !== 'noarch') throw new Error(`Архитектура установленного RPM не поддерживается: ${architecture}`);
    const installer = ['dnf', 'yum'].find(commandAvailable) || null;
    return {
      format: 'rpm',
      currentVersion,
      installer,
      canInstall: process.getuid?.() === 0 && Boolean(installer) && commandAvailable('systemd-run'),
    };
  }

  const error = new Error('Не удалось определить установленный DEB- или RPM-пакет Backup Manager.');
  error.status = 501;
  throw error;
}

export async function checkForUpdate() {
  const installed = getInstalledPackage();
  const response = await fetch(releaseApiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Backup-Manager',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub вернул HTTP ${response.status} при проверке Release ${releaseTag}.`);
  }
  const release = await response.json();
  const asset = selectReleaseAsset(release, installed.format);
  const latestVersion = asset.version;
  const updateAvailable = comparePackageVersions(latestVersion, installed.currentVersion) > 0;
  const canInstall = installed.canInstall;
  const installUnavailableReason = canInstall
    ? ''
    : process.getuid?.() !== 0
      ? 'Для установки требуется системная служба с правами root.'
      : !installed.installer
        ? 'Не найден поддерживаемый пакетный менеджер для этого формата.'
        : 'Не найден systemd-run для безопасного выполнения обновления после перезапуска службы.';

  return {
    currentVersion: installed.currentVersion,
    latestVersion,
    updateAvailable,
    format: installed.format,
    canInstall,
    installUnavailableReason,
    releaseUrl: releasePageUrl,
    assetName: asset.name,
    installer: installed.installer,
  };
}

async function readLimitedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GitHub не вернул содержимое пакета.');
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxPackageBytes) {
      await reader.cancel();
      throw new Error('Размер пакета превышает допустимый предел 250 МБ.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes);
}

function verifyPackage(packagePath, format, expectedVersion) {
  const result = format === 'deb'
    ? spawnSync('dpkg-deb', ['--field', packagePath, 'Package', 'Version', 'Architecture'], { encoding: 'utf8', timeout: 20_000 })
    : spawnSync('rpm', ['-qp', '--qf', '%{NAME}\n%{VERSION}-%{RELEASE}\n%{ARCH}\n', packagePath], { encoding: 'utf8', timeout: 20_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Не удалось проверить метаданные загруженного пакета: ${result.error?.message || result.stderr.trim()}`);
  }
  let metadata;
  if (format === 'deb') {
    metadata = parseDebMetadata(result.stdout);
  } else {
    const [name, version, architecture] = result.stdout.trim().split(/\r?\n/);
    metadata = { name, version, architecture };
  }
  const expectedArchitecture = format === 'deb' ? 'all' : 'noarch';
  if (metadata.name !== 'backup-manager' || metadata.architecture !== expectedArchitecture ||
      !metadata.version || comparePackageVersions(metadata.version, expectedVersion) !== 0) {
    throw new Error('Метаданные загруженного пакета не совпадают с ожидаемыми.');
  }
}

export async function readUpdateStatus(dataDir) {
  try {
    return JSON.parse(await readFile(path.join(dataDir, 'update-status.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'idle' };
    throw new Error(`Не удалось прочитать состояние обновления: ${error.message}`);
  }
}

async function writeUpdateStatus(dataDir, status) {
  const statusPath = path.join(dataDir, 'update-status.json');
  const temporaryPath = `${statusPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  await rename(temporaryPath, statusPath);
}

export async function startPackageUpdate(update, dataDir, updaterScriptPath) {
  const packageDirectory = await mkdtemp(path.join(dataDir, 'package-update-'));
  const packagePath = path.join(packageDirectory, update.assetName);
  const downloadUrl = `https://github.com/${repository}/releases/download/${releaseTag}/${encodeURIComponent(update.assetName)}`;
  let handedOffToSystemd = false;
  try {
    const response = await fetch(downloadUrl, {
      headers: { 'User-Agent': 'Backup-Manager' },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Не удалось скачать пакет из GitHub (HTTP ${response.status}).`);
    const packageBytes = await readLimitedBody(response);
    await writeFile(packagePath, packageBytes, { mode: 0o600, flag: 'wx' });
    verifyPackage(packagePath, update.format, update.latestVersion);

    const unitName = `backup-manager-update-${randomUUID()}`;
    const status = {
      status: 'installing',
      targetVersion: update.latestVersion,
      unitName,
      startedAt: new Date().toISOString(),
    };
    await writeUpdateStatus(dataDir, status);
    const result = spawnSync('systemd-run', [
      `--unit=${unitName}`,
      '--collect',
      '--no-block',
      '--property=Type=oneshot',
      '--description=Backup Manager package update',
      '/bin/sh',
      updaterScriptPath,
      update.installer,
      packagePath,
      path.join(dataDir, 'update-status.json'),
      update.latestVersion,
      unitName,
      packageDirectory,
    ], { encoding: 'utf8', timeout: 15_000 });
    if (result.error || result.status !== 0) {
      const details = result.error?.message || result.stderr.trim() || `код ${result.status}`;
      const failedStatus = { ...status, status: 'failed', error: `Не удалось запустить службу обновления: ${details}` };
      await writeUpdateStatus(dataDir, failedStatus);
      throw new Error(failedStatus.error);
    }
    handedOffToSystemd = true;
    return status;
  } finally {
    if (!handedOffToSystemd) await rm(packageDirectory, { recursive: true, force: true });
  }
}
