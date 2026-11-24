import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$RSYNC_ARGS_LOG"\nif [ -f "$RSYNC_WAIT_FLAG" ]; then exec sleep 30; fi\nif [ -f "$RSYNC_ERROR_FLAG" ]; then\n  printf \'rsync: [sender] open "locked.txt" failed: Permission denied (13)\\n\' >&2\n  i=0\n  while [ "$i" -lt 20000 ]; do\n    printf "verbose directory listing line %s\\n" "$i"\n    i=$((i + 1))\n  done\n  exit 23\nfi\nfor arg in "$@"; do\n  if [ "$arg" = "--dry-run" ]; then printf "*deleting old-file.txt\\n"; fi\ndone\nprintf " 50%%\\r" >&2\nprintf "Number of files: 1\\nTotal file size: 0 bytes\\n"\n',
    { mode: 0o755 },
  );
  await writeFile(
    path.join(mockBinDir, 'tar'),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-czf" ]; then shift; : > "$1"; exit 0; fi\n  shift\ndone\nexit 0\n',
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
      RSYNC_WAIT_FLAG: path.join(dataDir, 'rsync-wait'),
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
  const editResponse = await apiRequest(`${baseUrl}/api/jobs/${job.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Documents updated', sourcePath: path.resolve(dataDir, 'new-documents') }),
  });
  assert.equal(editResponse.status, 200);
  const editedJob = await editResponse.json();
  assert.equal(editedJob.name, 'Documents updated');
  assert.equal(editedJob.sourcePath, path.resolve(dataDir, 'new-documents'));

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
  assert.equal(state.jobs[0].name, 'Documents updated');
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

test('local directory picker lists directories and resolves symlink paths', async () => {
  const pickerRoot = path.join(dataDir, 'picker-root');
  await mkdir(path.join(pickerRoot, 'Documents'), { recursive: true });
  await writeFile(path.join(pickerRoot, 'file.txt'), 'not a directory');
  const symlinkPath = path.join(dataDir, 'picker-link');
  await symlink(path.join(pickerRoot, 'Documents'), symlinkPath);

  const listingResponse = await apiRequest(`${baseUrl}/api/directories?path=${encodeURIComponent(pickerRoot)}`);
  assert.equal(listingResponse.status, 200);
  const listing = await listingResponse.json();
  assert.equal(listing.path, pickerRoot);
  assert.deepEqual(listing.directories.map(directory => directory.name), ['Documents']);
  assert.equal((await apiRequest(`${baseUrl}/api/directories?path=relative`)).status, 400);
  const symlinkResponse = await apiRequest(`${baseUrl}/api/directories?path=${encodeURIComponent(symlinkPath)}`);
  assert.equal(symlinkResponse.status, 200);
  assert.equal((await symlinkResponse.json()).path, path.join(pickerRoot, 'Documents'));
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
  assert.ok(!rsyncArgs.includes('--inplace'));
  assert.ok(rsyncArgs.includes('--one-file-system'));
  assert.ok(rsyncArgs.includes('--exclude=.*'));
  assert.ok(rsyncArgs.includes('--exclude=/thinclient_drives/***'));
  assert.ok(rsyncArgs.includes('--exclude=.~lock.*'));
  assert.ok(rsyncArgs.includes('--exclude=~$*'));
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

test('dry-run reports deletions and passes delete-delay to rsync', async () => {
  const sourcePath = path.join(dataDir, 'dry-run-source');
  const mountPoint = path.join(dataDir, 'dry-run-mount');
  await mkdir(sourcePath);
  await apiRequest(`${baseUrl}/api/smb`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      server: 'files.example.local', share: 'backups', username: 'backup-user',
      password: '', domain: 'WORKGROUP', mountPoint,
    }),
  });
  const settingsResponse = await apiRequest(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      compression: false, deleteExtra: true, deleteDelay: true, verbose: false, inPlace: false,
      createArchive: false, archiveRetention: 1, excludePatterns: [], bandwidthLimit: 0, retries: 1,
      notifyEmail: '', notifyOnError: true, notifyOnSuccess: false, logRetention: 30, parallelJobs: 1,
    }),
  });
  assert.equal(settingsResponse.status, 200);

  const jobResponse = await apiRequest(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Dry run', sourcePath, enabled: false, schedule: { type: 'manual' } }),
  });
  const job = await jobResponse.json();
  assert.equal((await apiRequest(`${baseUrl}/api/jobs/${job.id}/dry-run`, { method: 'POST' })).status, 202);

  let state;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    state = await (await apiRequest(`${baseUrl}/api/state`)).json();
    if (state.logs.some(log => log.jobName === job.name && log.message.includes('Будут удалены'))) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(state.jobs.find(item => item.id === job.id)?.lastStatus, 'never');
  assert.match(state.logs.find(log => log.jobName === job.name && log.message.includes('Будут удалены')).message, /old-file\.txt/);
  const args = (await readFile(path.join(dataDir, 'rsync-args.txt'), 'utf8')).trim().split('\n');
  assert.ok(args.includes('--dry-run'));
  assert.ok(args.includes('--itemize-changes'));
  assert.ok(args.includes('--delete-delay'));
});

test('stop terminates an active rsync job', async () => {
  const sourcePath = path.join(dataDir, 'stop-source');
  const mountPoint = path.join(dataDir, 'stop-mount');
  await mkdir(sourcePath);
  await apiRequest(`${baseUrl}/api/smb`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      server: 'files.example.local', share: 'backups', username: 'backup-user',
      password: '', domain: 'WORKGROUP', mountPoint,
    }),
  });
  await writeFile(path.join(dataDir, 'rsync-wait'), '');
  const jobResponse = await apiRequest(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Stop test', sourcePath, enabled: false, schedule: { type: 'manual' } }),
  });
  const job = await jobResponse.json();
  try {
    assert.equal((await apiRequest(`${baseUrl}/api/jobs/${job.id}/run`, { method: 'POST' })).status, 202);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = await (await apiRequest(`${baseUrl}/api/state`)).json();
      if (state.jobs.find(item => item.id === job.id)?.lastStatus === 'running') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await apiRequest(`${baseUrl}/api/jobs/${job.id}/stop`, { method: 'POST' })).status, 202);
    let status;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = await (await apiRequest(`${baseUrl}/api/state`)).json();
      status = state.jobs.find(item => item.id === job.id)?.lastStatus;
      if (status === 'cancelled') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(status, 'cancelled');
  } finally {
    await rm(path.join(dataDir, 'rsync-wait'), { force: true });
  }
});

test('recovery lists and downloads files and rejects paths outside the machine root', async () => {
  const mountPoint = path.join(dataDir, 'recovery-mount');
  const smbResponse = await apiRequest(`${baseUrl}/api/smb`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      server: 'files.example.local', share: 'backups', username: 'backup-user',
      password: '', domain: 'WORKGROUP', mountPoint,
    }),
  });
  assert.equal(smbResponse.status, 200);
  const machineRoot = path.join(mountPoint, os.hostname());
  const emptyListing = await (await apiRequest(`${baseUrl}/api/recovery`)).json();
  assert.deepEqual(emptyListing.entries, []);
  await mkdir(path.join(machineRoot, 'Documents'), { recursive: true });
  await writeFile(path.join(machineRoot, 'Documents', 'readme.txt'), 'restorable');
  const listingResponse = await apiRequest(`${baseUrl}/api/recovery`);
  assert.equal(listingResponse.status, 200);
  const listing = await listingResponse.json();
  assert.ok(listing.entries.some(entry => entry.name === 'Documents' && entry.type === 'directory'));
  const fileResponse = await apiRequest(`${baseUrl}/api/recovery/download?path=Documents%2Freadme.txt`);
  assert.equal(await fileResponse.text(), 'restorable');
  const restorePath = path.join(dataDir, 'restored-file');
  const restoreResponse = await apiRequest(`${baseUrl}/api/recovery/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'Documents/readme.txt', targetPath: restorePath }),
  });
  assert.equal(restoreResponse.status, 200);
  const nonEmptyTarget = path.join(dataDir, 'non-empty-restore');
  await mkdir(nonEmptyTarget);
  await writeFile(path.join(nonEmptyTarget, 'existing.txt'), 'keep');
  const conflictResponse = await apiRequest(`${baseUrl}/api/recovery/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'Documents/readme.txt', targetPath: nonEmptyTarget }),
  });
  assert.equal(conflictResponse.status, 409);
  assert.equal((await apiRequest(`${baseUrl}/api/recovery?path=..%2F..%2Fetc`)).status, 400);
});

test('archives are created after synchronization and retention keeps the newest copy', async () => {
  const sourcePath = path.join(dataDir, 'archive-source');
  const mountPoint = path.join(dataDir, 'archive-mount');
  await mkdir(sourcePath);
  await apiRequest(`${baseUrl}/api/smb`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      server: 'files.example.local', share: 'backups', username: 'backup-user',
      password: '', domain: 'WORKGROUP', mountPoint,
    }),
  });
  const settingsResponse = await apiRequest(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      compression: false, deleteExtra: false, deleteDelay: false, verbose: false, inPlace: false,
      createArchive: true, archiveRetention: 1, excludePatterns: [], bandwidthLimit: 0, retries: 1,
      notifyEmail: '', notifyOnError: true, notifyOnSuccess: false, logRetention: 30, parallelJobs: 1,
    }),
  });
  assert.equal(settingsResponse.status, 200);
  const jobResponse = await apiRequest(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Archive test', sourcePath, enabled: false, schedule: { type: 'manual' } }),
  });
  const job = await jobResponse.json();

  for (let run = 1; run <= 2; run += 1) {
    if (run === 2) await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal((await apiRequest(`${baseUrl}/api/jobs/${job.id}/run`, { method: 'POST' })).status, 202);
    let completed = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = await (await apiRequest(`${baseUrl}/api/state`)).json();
      const archiveSuccesses = state.logs.filter(log => log.jobName === job.name && log.message.includes('Архив создан.'));
      if (archiveSuccesses.length >= run) {
        completed = state.jobs.find(item => item.id === job.id)?.lastStatus === 'success';
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(completed, `Archive run ${run} did not complete successfully.`);
  }
  const archiveDirectory = path.join(mountPoint, os.hostname(), 'archives');
  const archives = (await readdir(archiveDirectory)).filter(name => name.endsWith('.tar.gz'));
  assert.equal(archives.length, 1);
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
      inPlace: true,
      excludePatterns: ['custom-backup-ignore-*'],
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
  const rsyncArgs = (await readFile(path.join(dataDir, 'rsync-args.txt'), 'utf8')).trim().split('\n');
  assert.ok(rsyncArgs.includes('--inplace'));
  assert.ok(rsyncArgs.includes('--exclude=custom-backup-ignore-*'));
  assert.ok(!rsyncArgs.includes('--exclude=.*'));
  const errorLog = state.logs.find(log => log.level === 'error' && log.jobName === job.name);
  assert.match(errorLog.message, /завершился с кодом 23/);
  assert.match(errorLog.message, /Permission denied/);
});
