import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparePackageVersions, parseDebMetadata, selectReleaseAsset } from './updater.js';

test('package versions compare application version and package release numerically', () => {
  assert.equal(comparePackageVersions('3.2.2-10', '3.2.2-9'), 1);
  assert.equal(comparePackageVersions('3.10.0-1', '3.9.9-99'), 1);
  assert.equal(comparePackageVersions('3.2.2-7.el9', '3.2.2-7'), 0);
});

test('update selection chooses the newest matching package asset', () => {
  const release = {
    tag_name: 'dist',
    draft: false,
    assets: [
      { name: 'backup-manager_3.2.2-6_all.deb' },
      { name: 'backup-manager_3.2.2-8_all.deb' },
      { name: 'backup-manager-3.2.2-9.noarch.rpm' },
      { name: 'notes.txt' },
    ],
  };

  assert.deepEqual(selectReleaseAsset(release, 'deb'), {
    name: 'backup-manager_3.2.2-8_all.deb',
    version: '3.2.2-8',
  });
  assert.deepEqual(selectReleaseAsset(release, 'rpm'), {
    name: 'backup-manager-3.2.2-9.noarch.rpm',
    version: '3.2.2-9',
  });
});

test('update selection rejects wrong release tag and missing package assets', () => {
  assert.throws(() => selectReleaseAsset({ tag_name: 'v3.2.2', assets: [] }, 'deb'), /Release с тегом dist/);
  assert.throws(() => selectReleaseAsset({ tag_name: 'dist', assets: [] }, 'rpm'), /не найден пакет формата RPM/);
});

test('DEB metadata parsing handles the labeled output of dpkg-deb --field', () => {
  assert.deepEqual(parseDebMetadata(
    'Package: backup-manager\nVersion: 3.2.3-2\nArchitecture: all\n',
  ), {
    name: 'backup-manager',
    version: '3.2.3-2',
    architecture: 'all',
  });
});
