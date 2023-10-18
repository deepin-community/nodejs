'use strict';

const tmpdir = require('../common/tmpdir');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

function buildSnapshot(entry, env) {
  const child = spawnSync(process.execPath, [
    '--snapshot-blob',
    path.join(tmpdir.path, 'snapshot.blob'),
    '--build-snapshot',
    entry,
  ], {
    cwd: tmpdir.path,
    env: {
      ...process.env,
      ...env,
    },
  });

  const stderr = child.stderr.toString();
  const stdout = child.stdout.toString();
  console.log('[stderr]');
  console.log(stderr);
  console.log('[stdout]');
  console.log(stdout);

  assert.strictEqual(child.status, 0);

  const stats = fs.statSync(path.join(tmpdir.path, 'snapshot.blob'));
  assert(stats.isFile());

  return { child, stderr, stdout };
}

function runWithSnapshot(entry, env) {
  const args = ['--snapshot-blob', path.join(tmpdir.path, 'snapshot.blob')];
  if (entry !== undefined) {
    args.push(entry);
  }
  const child = spawnSync(process.execPath, args, {
    cwd: tmpdir.path,
    env: {
      ...process.env,
      ...env,
    },
  });

  const stderr = child.stderr.toString();
  const stdout = child.stdout.toString();
  console.log('[stderr]');
  console.log(stderr);
  console.log('[stdout]');
  console.log(stdout);

  assert.strictEqual(child.status, 0);

  return { child, stderr, stdout };
}

module.exports = {
  buildSnapshot,
  runWithSnapshot,
};
