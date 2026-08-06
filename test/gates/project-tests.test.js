import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import gate from '../../src/gates/project-tests.js';
import { runGate } from '../fixtures/context.js';

/** A directory with no package.json, so only an explicit command applies. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-code-gates-tests-'));

test('skips when no test command can be determined', async () => {
  const result = await runGate(gate, { root: SANDBOX });
  assert.equal(result.status, 'skip');
});

test('passes when the configured command succeeds', async () => {
  const result = await runGate(gate, {
    root: SANDBOX,
    gates: { PROJECT_TESTS: { command: 'node -e "process.exit(0)"' } },
  });
  assert.equal(result.status, 'pass');
});

test('fails when the configured command fails', async () => {
  const result = await runGate(gate, {
    root: SANDBOX,
    gates: { PROJECT_TESTS: { command: 'node -e "console.error(\'1 test failed\'); process.exit(1)"' } },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /failed/);
});

test('accepts a skip whose reason is about scope', async () => {
  const result = await runGate(gate, {
    root: SANDBOX,
    message: 'docs: fix a typo\n\nagent-code-gates-skip: PROJECT_TESTS documentation only, no executable code changed',
    gates: { PROJECT_TESTS: { command: 'node -e "process.exit(1)"' } },
  });
  assert.equal(result.status, 'skip');
  assert.match(result.message, /documentation only/);
});

test('rejects a skip whose reason is a broken environment', async () => {
  const result = await runGate(gate, {
    root: SANDBOX,
    message: 'feat: pricing\n\nagent-code-gates-skip: PROJECT_TESTS the runner cannot boot in this container',
    gates: { PROJECT_TESTS: { command: 'node -e "process.exit(0)"' } },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /broken environment/);
});

test('rejects a module-not-found excuse as well', async () => {
  const result = await runGate(gate, {
    root: SANDBOX,
    message: 'feat: pricing\n\nagent-code-gates-skip: PROJECT_TESTS module not found when starting vitest',
    gates: { PROJECT_TESTS: { command: 'node -e "process.exit(0)"' } },
  });
  assert.equal(result.status, 'fail');
});

test('names a runner that never started, rather than blaming the tests', async () => {
  const result = await runGate(gate, {
    root: SANDBOX,
    gates: { PROJECT_TESTS: { command: 'node -e "require(\'a-module-that-does-not-exist\')"' } },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /never reached the tests/);
});

test('reports a timeout distinctly from a failure', async () => {
  const result = await runGate(gate, {
    root: SANDBOX,
    gates: {
      PROJECT_TESTS: { command: 'node -e "setTimeout(() => {}, 5000)"', timeoutMs: 300 },
    },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /did not finish/);
});
