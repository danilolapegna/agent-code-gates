import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, resolveConfig, loadConfig, ConfigError, CONFIG_FILENAME } from '../src/config.js';
import { gateIds } from '../src/gates/index.js';
import { TempRepo } from './fixtures/repo.js';

test('defaults cover every registered gate', () => {
  const config = defaultConfig();
  for (const id of gateIds()) {
    assert.ok(config.gates[id], `missing defaults for ${id}`);
    assert.equal(config.gates[id].enabled, true);
    assert.ok(['error', 'warning'].includes(config.gates[id].severity));
  }
});

test('a gate can be disabled and re-graded', () => {
  const config = resolveConfig({
    gates: { COMMIT_SIZE: { severity: 'error' }, SMOKE_EVIDENCE: { enabled: false } },
  });
  assert.equal(config.gates.COMMIT_SIZE.severity, 'error');
  assert.equal(config.gates.SMOKE_EVIDENCE.enabled, false);
});

test('object-valued options merge instead of replacing their siblings', () => {
  const config = resolveConfig({ gates: { DEBUG_RESIDUE: { rules: { goPrint: true } } } });
  assert.equal(config.gates.DEBUG_RESIDUE.rules.goPrint, true);
  assert.equal(config.gates.DEBUG_RESIDUE.rules.console, true);
});

test('an unknown gate id is an error, not a shrug', () => {
  assert.throws(
    () => resolveConfig({ gates: { TODO_DENSITTY: { enabled: false } } }),
    (error) => error instanceof ConfigError && /unknown gate "TODO_DENSITTY"/.test(error.message),
  );
});

test('an unknown option name is an error', () => {
  assert.throws(
    () => resolveConfig({ gates: { COMMIT_SIZE: { maxFilez: 10 } } }),
    (error) => error instanceof ConfigError && /unknown option "maxFilez"/.test(error.message),
  );
});

test('an option of the wrong type is an error', () => {
  assert.throws(
    () => resolveConfig({ gates: { COMMIT_SIZE: { maxFiles: 'five' } } }),
    (error) => error instanceof ConfigError && /must be a number/.test(error.message),
  );
});

test('an invalid severity is an error', () => {
  assert.throws(
    () => resolveConfig({ gates: { COMMIT_SIZE: { severity: 'critical' } } }),
    (error) => error instanceof ConfigError && /severity must be one of/.test(error.message),
  );
});

test('an unknown top-level key is an error', () => {
  assert.throws(
    () => resolveConfig({ gatez: {} }),
    (error) => error instanceof ConfigError && /unknown top-level key "gatez"/.test(error.message),
  );
});

test('every problem is reported at once, not one per run', () => {
  try {
    resolveConfig({ strict: 'yes', gates: { COMMIT_SIZE: { maxFiles: 'five' } } });
    assert.fail('expected a ConfigError');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.problems.length, 2);
  }
});

test('a missing file falls back to defaults without complaint', () => {
  const repo = TempRepo.create();
  try {
    const { config, file } = loadConfig(repo.root);
    assert.equal(file, null);
    assert.equal(config.gates.TODO_DENSITY.enabled, true);
  } finally {
    repo.destroy();
  }
});

test('a malformed file is fatal rather than silently ignored', () => {
  const repo = TempRepo.create();
  try {
    fs.writeFileSync(path.join(repo.root, CONFIG_FILENAME), '{ not json');
    assert.throws(() => loadConfig(repo.root), ConfigError);
  } finally {
    repo.destroy();
  }
});

test('a real file is loaded and merged', () => {
  const repo = TempRepo.create();
  try {
    fs.writeFileSync(
      path.join(repo.root, CONFIG_FILENAME),
      JSON.stringify({ ignore: ['legacy/**'], gates: { COMMIT_SIZE: { maxFiles: 20 } } }),
    );
    const { config, file } = loadConfig(repo.root);
    assert.ok(file.endsWith(CONFIG_FILENAME));
    assert.deepEqual(config.ignore, ['legacy/**']);
    assert.equal(config.gates.COMMIT_SIZE.maxFiles, 20);
    assert.equal(config.gates.COMMIT_SIZE.maxLines, 500);
  } finally {
    repo.destroy();
  }
});
