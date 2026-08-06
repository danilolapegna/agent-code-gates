import { test } from 'node:test';
import assert from 'node:assert/strict';
import gate from '../../src/gates/smoke-evidence.js';
import { runGate } from '../fixtures/context.js';

const UI = { files: { 'src/components/OrderTable.tsx': 'export const OrderTable = () => null;\n' } };

const GOOD = [
  '## Smoke evidence',
  'data: real',
  'success criteria: the orders table shows 3 rows and the total reads 148.20',
  'url: https://app.example.com/orders',
].join('\n');

test('skips when no user-facing file changed', async () => {
  const result = await runGate(gate, {
    files: { 'src/lib/math.ts': 'export const add = (a, b) => a + b;\n' },
    message: 'chore: add helper',
  });
  assert.equal(result.status, 'skip');
});

test('passes with a complete evidence block', async () => {
  const result = await runGate(gate, { ...UI, message: `feat: order table\n\n${GOOD}` });
  assert.equal(result.status, 'pass');
});

test('passes with an owned, explicit deferral', async () => {
  const result = await runGate(gate, {
    ...UI,
    message: [
      'feat: order table',
      '',
      '## Smoke evidence',
      'PENDING-VERIFY: the totals row against production data, once the tax service is deployed',
      'owner: @maria',
    ].join('\n'),
  });
  assert.equal(result.status, 'pass');
});

test('accepts evidence stored in a file', async () => {
  const result = await runGate(gate, {
    ...UI,
    message: 'feat: order table',
    evidence: [{ text: GOOD, source: '.gates-evidence/abc123.md' }],
  });
  assert.equal(result.status, 'pass');
});

test('fails when there is no evidence at all', async () => {
  const result = await runGate(gate, { ...UI, message: 'feat: order table' });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /No "## Smoke evidence" block/);
  assert.equal(result.findings[0].file, 'src/components/OrderTable.tsx');
});

test('rejects a success criterion that only describes a mount', async () => {
  const result = await runGate(gate, {
    ...UI,
    message: [
      'feat: order table',
      '',
      '## Smoke evidence',
      'data: real',
      'success criteria: renders without errors',
      'url: https://app.example.com/orders',
    ].join('\n'),
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /describes a mount, not a result/);
});

test('rejects evidence gathered only on a development server', async () => {
  const result = await runGate(gate, {
    ...UI,
    message: [
      'feat: order table',
      '',
      '## Smoke evidence',
      'data: real',
      'success criteria: the table shows 3 rows and the total reads 148.20',
      'url: http://localhost:3000/orders',
    ].join('\n'),
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /deployed address/);
});

test('rejects a deferral with no owner', async () => {
  const result = await runGate(gate, {
    ...UI,
    message: 'feat: order table\n\n## Smoke evidence\nPENDING-VERIFY: the totals row against production data',
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /owner/);
});

test('requires the data field to say what the run proves', async () => {
  const result = await runGate(gate, {
    ...UI,
    message: [
      'feat: order table',
      '',
      '## Smoke evidence',
      'success criteria: the table shows 3 rows and the total reads 148.20',
      'url: https://app.example.com/orders',
    ].join('\n'),
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /data:/);
});

test('accepts local evidence when the project says so', async () => {
  const result = await runGate(gate, {
    ...UI,
    message: [
      'feat: order table',
      '',
      '## Smoke evidence',
      'data: real',
      'success criteria: the table shows 3 rows and the total reads 148.20',
      'url: http://localhost:3000/orders',
    ].join('\n'),
    gates: { SMOKE_EVIDENCE: { requireDeployedUrl: false } },
  });
  assert.equal(result.status, 'pass');
});
