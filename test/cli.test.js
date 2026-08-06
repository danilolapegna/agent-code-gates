import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TempRepo } from './fixtures/repo.js';
import { installHook, hooksDirectory } from '../src/hooks.js';

const CLI = fileURLToPath(new URL('../bin/agent-code-gates.js', import.meta.url));

/**
 * Invoke the command line and capture everything about the result.
 *
 * @param {string[]} args Command arguments.
 * @param {string} [cwd] Working directory.
 * @returns {{code: number, stdout: string, stderr: string}} Result.
 */
function cli(args, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('--help and --version exit clean', () => {
  assert.equal(cli(['--help']).code, 0);
  const version = cli(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('--list prints every gate', () => {
  const result = cli(['--list']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /TODO_DENSITY/);
  assert.match(result.stdout, /DELIVERED_LOCK/);
});

test('an unknown flag is a usage error, not a silently weaker run', () => {
  const result = cli(['--stricct']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown option/);
});

test('an unknown gate name is a usage error', () => {
  const result = cli(['--gate', 'NOT_A_GATE']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown gate/);
});

test('a clean commit exits 0 and a dirty one exits 1', () => {
  const repo = TempRepo.create();
  try {
    repo.write('src/clean.js', 'export const a = 1;\n');
    repo.commit('chore: base');

    const clean = cli(['--commit', 'HEAD', '--cwd', repo.root]);
    assert.equal(clean.code, 0, clean.stdout);

    repo.write('src/dirty.js', 'export function run() {\n  console.log("here");\n}\n');
    repo.commit('feat: add run');

    const dirty = cli(['--commit', 'HEAD', '--cwd', repo.root]);
    assert.equal(dirty.code, 1);
    assert.match(dirty.stdout, /DEBUG_RESIDUE/);
    assert.match(dirty.stdout, /src\/dirty\.js:2/);
  } finally {
    repo.destroy();
  }
});

test('--json emits a parseable result with the same verdict', () => {
  const repo = TempRepo.create();
  try {
    repo.write('src/dirty.js', 'export function run() {\n  console.log("here");\n}\n');
    repo.commit('feat: add run');

    const result = cli(['--commit', 'HEAD', '--cwd', repo.root, '--json']);
    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.gates.some((gate) => gate.id === 'DEBUG_RESIDUE' && gate.blocking));
  } finally {
    repo.destroy();
  }
});

test('--gate runs exactly one gate', () => {
  const repo = TempRepo.create();
  try {
    repo.write('src/dirty.js', 'export function run() {\n  console.log("here");\n}\n');
    repo.commit('feat: add run');

    const result = cli(['--commit', 'HEAD', '--cwd', repo.root, '--json', '--gate', 'TODO_DENSITY']);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.gates.length, 1);
    assert.equal(payload.gates[0].id, 'TODO_DENSITY');
    assert.equal(result.code, 0);
  } finally {
    repo.destroy();
  }
});

test('an invalid configuration file stops the run instead of quietly using defaults', () => {
  const repo = TempRepo.create();
  try {
    fs.writeFileSync(path.join(repo.root, '.agentgatesrc.json'), JSON.stringify({ gates: { NOPE: {} } }));
    repo.commit('chore: config');
    const result = cli(['--commit', 'HEAD', '--cwd', repo.root]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown gate "NOPE"/);
  } finally {
    repo.destroy();
  }
});

test('running outside a repository is a usage error', () => {
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'acg-outside-'));
  try {
    const result = cli(['--cwd', outside]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not inside a git repository/);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('--install-hooks writes a runnable commit-msg hook', () => {
  const repo = TempRepo.create();
  try {
    const result = cli(['--install-hooks', '--cwd', repo.root]);
    assert.equal(result.code, 0);
    const hook = path.join(hooksDirectory(repo.root), 'commit-msg');
    assert.ok(fs.existsSync(hook));
    const contents = fs.readFileSync(hook, 'utf8');
    assert.match(contents, /agent-code-gates/);
    assert.match(contents, /--message-file "\$1"/);
    assert.ok((fs.statSync(hook).mode & 0o111) !== 0, 'hook should be executable');
  } finally {
    repo.destroy();
  }
});

test('installing twice is idempotent', () => {
  const repo = TempRepo.create();
  try {
    assert.equal(installHook(repo.root).action, 'created');
    assert.equal(installHook(repo.root).action, 'unchanged');
  } finally {
    repo.destroy();
  }
});

test("an existing hook this tool did not write is never clobbered", () => {
  const repo = TempRepo.create();
  try {
    const directory = hooksDirectory(repo.root);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'commit-msg'), '#!/bin/sh\necho mine\n');
    assert.throws(() => installHook(repo.root), /already exists/);
    assert.equal(installHook(repo.root, { force: true }).action, 'updated');
  } finally {
    repo.destroy();
  }
});

test('the installed hook actually blocks a bad commit', () => {
  const repo = TempRepo.create();
  try {
    installHook(repo.root);
    repo.write('src/dirty.js', 'export function run() {\n  console.log("here");\n}\n');
    repo.git(['add', '-A']);
    const blocked = spawnSync('git', ['commit', '-m', 'feat: add run'], {
      cwd: repo.root,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.notEqual(blocked.status, 0);
    assert.match(`${blocked.stdout}${blocked.stderr}`, /DEBUG_RESIDUE/);

    const bypassed = spawnSync('git', ['commit', '-m', 'feat: add run'], {
      cwd: repo.root,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', AGENT_CODE_GATES_SKIP: '1' },
    });
    assert.equal(bypassed.status, 0);
  } finally {
    repo.destroy();
  }
});
