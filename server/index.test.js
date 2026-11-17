import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

let baseUrl;
let dataDir;
let backend;
let staleMountPoint;
const currentDir = dirname(fileURLToPath(import.meta.url));
const testToken = 'test-api-token';

function apiRequest(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Basic ${Buffer.from(`backup:${testToken}`).toString('base64')}`,
    },
  });
}

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'backup-manager-api-'));
  staleMountPoint = path.join(dataDir, 'stale-mount');
  const mockBinDir = path.join(dataDir, 'bin');
  await mkdir(mockBinDir);
  await writeFile(
    path.join(mockBinDir, 'findmnt'),
    '#!/bin/sh\ncase " $* " in\n  *" --target "*) printf "/dev/mapper/astra29487-lv_root\\n"; exit 0 ;;\n  *" --mountpoint $MOCK_STALE_MOUNTPOINT "*) printf "//files.example.local/backups\\n"; exit 0 ;;\n  *" --mountpoint "*) exit 1 ;;\n  *) exit 2 ;;\nesac\n',
    { mode: 0o755 },
  );
  await writeFile(path.join(mockBinDir, 'mount.cifs'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(
    path.join(mockBinDir, 'rsync'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$RSYNC_ARGS_LOG"\nif [ -f "$RSYNC_ERROR_FLAG" ]; then\n  printf \'rsync: [sender] open "locked.txt" failed: Permission denied (13)\\n\' >&2\n  i=0\n  while [ "$i" -lt 20000 ]; do\n    printf "verbose directory listing line %s\\n" "$i"\n    i=$((i + 1))\n  done\n  exit 23\nfi\nprintf "Number of files: 1\\nTotal file size: 0 bytes\\n"\n',
    { mode: 0o755 },
  );
  await chmod(mockBinDir, 0o755);
  const tokenPath = path.join(dataDir, 'api-token');
  await writeFile(tokenPath, `${testToken}\n`, { mode: 0o600 });
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port.');
  await new Promise(resolve => probe.close(resolve));
  baseUrl = `http://127.0.0.1:${address.port}`;
  backend = spawn(process.execPath, [path.join(currentDir, 'index.js')], {
    env: {
      ...process.env,
      BACKUP_MANAGER_DATA_DIR: dataDir,
      BACKUP_MANAGER_PORT: String(address.port),
      BACKUP_MANAGER_API_TOKEN_FILE: tokenPath,
      RSYNC_ARGS_LOG: path.join(dataDir, 'rsync-args.txt'),
      RSYNC_ERROR_FLAG: path.join(dataDir, 'rsync-error'),
      MOCK_STALE_MOUNTPOINT: staleMountPoint,
      PATH: `${mockBinDir}:${process.env.PATH || ''}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let startupError = '';
  backend.stderr.setEncoding('utf8');
  backend.stderr.on('data', chunk => { startupError += chunk; });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (backend.exitCode !== null) throw new Error(`Backend exited during startup: ${startupError}`);
    try {
      const response = await apiRequest(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Backend did not start: ${startupError}`);
});

after(async () => {
  if (backend && backend.exitCode === null) {
    backend.kill();
    await new Promise(resolve => backend.once('exit', resolve));
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('API persists application data and protects SMB credentials', async () => {
  const configResponse = await apiRequest(`${baseUrl}/api/smb`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      server: 'files.example.local',
      share: 'backups',
      username: 'backup-user',
      password: 'test-secret',
      domain: 'WORKGROUP',
      mountPoint: path.join(dataDir, 'mount'),
    }),
  });
  assert.equal(configResponse.status, 200);
  const returnedConfig = await configResponse.json();
  assert.equal(returnedConfig.password, '');
  assert.equal(returnedConfig.passwordConfigured, true);

  const jobResponse = await apiRequest(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Documents',
      sourcePath: path.resolve(dataDir, 'documents'),
      enabled: true,
      schedule: { type: 'daily', time: '02:30' },
    }),
  });
  assert.equal(jobResponse.status, 201);
  const job = await jobResponse.json();

  const scheduleResponse = await apiRequest(`${baseUrl}/api/jobs/${job.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false, schedule: { type: 'weekly', time: '04:15', dayOfWeek: 2 } }),
  });
  assert.equal(scheduleResponse.status, 200);

  const invalidSchedule = await apiRequest(`${baseUrl}/api/jobs/${job.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedule: { type: 'weekly', time: '25:99', dayOfWeek: 9 } }),
  });
  assert.equal(invalidSchedule.status, 400);

  const stateResponse = await apiRequest(`${baseUrl}/api/state`);
  const state = await stateResponse.json();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].enabled, false);
  assert.equal(state.smbConfig.password, '');
  assert.equal(state.smbConfig.passwordConfigured, true);
  const persisted = await readFile(path.join(dataDir, 'state.json'), 'utf8');
  assert.equal(JSON.parse(persisted).smbConfig.password, 'test-secret');

  const crossOrigin = await apiRequest(`${baseUrl}/api/state`, { headers: { Origin: 'http://attacker.example' } });
  assert.equal(crossOrigin.status, 403);
});

test('API rejects mutations without a JSON content type', async () => {
  const response = await apiRequest(`${baseUrl}/api/jobs`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(response.status, 415);
});

test('API requires authentication when a token file is configured', async () => {
  const response = await fetch(`${baseUrl}/api/state`);
  assert.equal(response.status, 401);
});

test('backup treats a directory on the root filesystem as an unmounted mountpoint', async () => {
  const sourcePath = path.join(dataDir, 'documents');
  await mkdir(sourcePath);
  const jobResponse = await apiRequest(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Mountpoint check',
      sourcePath,
      enabled: false,
      schedule: { type: 'manual' },
    }),
  });
  assert.equal(jobResponse.status, 201);
  const job = await jobResponse.json();

  const runResponse = await apiRequest(`${baseUrl}/api/jobs/${job.id}/run`, { method: 'POST' });
  assert.equal(runResponse.status, 202);

  let finalStatus;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const stateResponse = await apiRequest(`${baseUrl}/api/state`);
    const state = await stateResponse.json();
    finalStatus = state.jobs.find(item => item.id === job.id)?.lastStatus;
    if (finalStatus === 'success' || finalStatus === 'error') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(finalStatus, 'success');

  const rsyncArgs = (await readFile(path.join(dataDir, 'rsync-args.txt'), 'utf8')).trim().split('\n');
  assert.ok(rsyncArgs.includes('--no-links'));
  assert.ok(rsyncArgs.includes('--no-devices'));
  assert.ok(rsyncArgs.includes('--no-specials'));
  assert.ok(rsyncArgs.includes('--one-file-system'));
  assert.ok(rsyncArgs.includes('--exclude=.*'));
  assert.ok(rsyncArgs.includes('--exclude=/thinclient_drives/***'));
  for (const pattern of [
    '--exclude=*.tmp',
    '--exclude=*.tmp.*',
    '--exclude=*.temp',
    '--exclude=*.temp.*',
    '--exclude=*.swp',
    '--exclude=*.swo',
    '--exclude=*.swx',
    '--exclude=*.part',
    '--exclude=*.partial',
    '--exclude=*.crdownload',
    '--exclude=*.download',
    '--exclude=*~',
    '--exclude=~$*',
    '--exclude=#*#',
  ]) {
    assert.ok(rsyncArgs.includes(pattern), `Missing temporary-file exclusion: ${pattern}`);
  }
  assert.equal(rsyncArgs.at(-1), `${path.join(dataDir, 'mount', os.hostname(), 'Mountpoint check')}${path.sep}`);
});

test('backup does not create a directory over an existing SMB mountpoint', async () => {
  const sourcePath = path.join(dataDir, 'stale-mount-source');
  await mkdir(sourcePath);
  const smbResponse = await apiRequest(`${baseUrl}/api/smb`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      server: 'files.example.local',
      share: 'backups',
      username: 'backup-user',
      password: '',
      domain: 'WORKGROUP',
      mountPoint: staleMountPoint,
    }),
  });
  assert.equal(smbResponse.status, 200);

  const jobResponse = await apiRequest(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Stale mountpoint check',
      sourcePath,
      enabled: false,
      schedule: { type: 'manual' },
    }),
  });
  assert.equal(jobResponse.status, 201);
  const job = await jobResponse.json();

  const runResponse = await apiRequest(`${baseUrl}/api/jobs/${job.id}/run`, { method: 'POST' });
  assert.equal(runResponse.status, 202);

  let finalStatus;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const stateResponse = await apiRequest(`${baseUrl}/api/state`);
    const state = await stateResponse.json();
    finalStatus = state.jobs.find(item => item.id === job.id)?.lastStatus;
    if (finalStatus === 'success' || finalStatus === 'error') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(finalStatus, 'error');
  await assert.rejects(stat(staleMountPoint), { code: 'ENOENT' });
});

test('backup preserves rsync stderr diagnostics when verbose stdout is large', async () => {
  const sourcePath = path.join(dataDir, 'diagnostic-source');
  const mountPoint = path.join(dataDir, 'diagnostic-mount');
  await mkdir(sourcePath);
  await writeFile(path.join(dataDir, 'rsync-error'), '');

  const smbResponse = await apiRequest(`${baseUrl}/api/smb`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      server: 'files.example.local',
      share: 'backups',
      username: 'backup-user',
      password: '',
      domain: 'WORKGROUP',
      mountPoint,
    }),
  });
  assert.equal(smbResponse.status, 200);

  const settingsResponse = await apiRequest(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      compression: false,
      deleteExtra: false,
      verbose: true,
      bandwidthLimit: 0,
      retries: 1,
      notifyEmail: '',
      notifyOnError: true,
      notifyOnSuccess: false,
      logRetention: 30,
      parallelJobs: 1,
    }),
  });
  assert.equal(settingsResponse.status, 200);

  const jobResponse = await apiRequest(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Rsync diagnostic check',
      sourcePath,
      enabled: false,
      schedule: { type: 'manual' },
    }),
  });
  assert.equal(jobResponse.status, 201);
  const job = await jobResponse.json();

  const runResponse = await apiRequest(`${baseUrl}/api/jobs/${job.id}/run`, { method: 'POST' });
  assert.equal(runResponse.status, 202);

  let state;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const stateResponse = await apiRequest(`${baseUrl}/api/state`);
    state = await stateResponse.json();
    const lastStatus = state.jobs.find(item => item.id === job.id)?.lastStatus;
    if (lastStatus === 'success' || lastStatus === 'error') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  assert.equal(state.jobs.find(item => item.id === job.id)?.lastStatus, 'error');
  const errorLog = state.logs.find(log => log.level === 'error' && log.jobName === job.name);
  assert.match(errorLog.message, /завершился с кодом 23/);
  assert.match(errorLog.message, /Permission denied/);
});
