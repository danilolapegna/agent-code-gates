import { test } from 'node:test';
import assert from 'node:assert/strict';
import gate from '../../src/gates/delivered-lock.js';
import { runGate } from '../fixtures/context.js';

const OBSERVATION = [
  '## Runtime observation',
  'data: real',
  'observed: the orders table shows 42 rows and the tax column reads 21.00 on the first',
  'url: https://app.example.com/orders',
].join('\n');

const HANDOFF = [
  '## Runtime handoff',
  'cannot-run: this environment has no staging credentials',
  'owner: @maria',
  'to-verify: open /orders and confirm the tax column shows a value, not a dash',
].join('\n');

test('skips when there is no commit message', async () => {
  const result = await runGate(gate, { files: { 'src/a.js': 'export const a = 1;\n' } });
  assert.equal(result.status, 'skip');
});

test('passes when the commit makes no release claim', async () => {
  const result = await runGate(gate, { message: 'feat: add tax column to the orders table' });
  assert.equal(result.status, 'pass');
});

test('passes on domain vocabulary that merely contains the word delivered', async () => {
  const result = await runGate(gate, { message: 'fix: correct the delivered-orders filter' });
  assert.equal(result.status, 'pass');
});

test('passes on a negated claim', async () => {
  const result = await runGate(gate, {
    message: 'feat: tax column\n\nThis is not production-ready yet; the rounding rules are still open.',
  });
  assert.equal(result.status, 'pass');
});

test('passes when a claim is backed by a real observation', async () => {
  const result = await runGate(gate, {
    message: `feat: tax column\n\nRUNTIME-VERIFIED, works end to end.\n\n${OBSERVATION}`,
  });
  assert.equal(result.status, 'pass');
});

test('passes on the honest downgrade with a complete handoff', async () => {
  const result = await runGate(gate, {
    message: `feat: tax column\n\nCODE-COMPLETE, RUNTIME-UNVERIFIED\n\n${HANDOFF}`,
  });
  assert.equal(result.status, 'pass');
});

test('accepts an observation stored outside the commit message', async () => {
  const result = await runGate(gate, {
    message: 'feat: tax column\n\nRUNTIME-VERIFIED, ready for users.',
    evidence: [{ text: OBSERVATION, source: '.gates-evidence/abc123.md' }],
  });
  assert.equal(result.status, 'pass');
});

test('fails on a release claim with no status token', async () => {
  const result = await runGate(gate, { message: 'feat: tax column\n\nThis is production-ready.' });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /declares no runtime status/);
});

test('fails when the claim and the honest status contradict each other', async () => {
  const result = await runGate(gate, {
    message: `feat: tax column\n\nproduction-ready\nCODE-COMPLETE, RUNTIME-UNVERIFIED\n\n${HANDOFF}`,
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /contradicts/);
});

test('fails when both status tokens are present', async () => {
  const result = await runGate(gate, {
    message: `feat: tax\n\nproduction-ready\nRUNTIME-VERIFIED\nRUNTIME-UNVERIFIED\n\n${OBSERVATION}`,
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /Pick one/);
});

test('fails when the observation is missing', async () => {
  const result = await runGate(gate, { message: 'feat: tax\n\nRUNTIME-VERIFIED, works end to end.' });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /no "## Runtime observation" block/);
});

test('fails when what was observed is only that it rendered', async () => {
  const result = await runGate(gate, {
    message: [
      'feat: tax',
      '',
      'RUNTIME-VERIFIED, ready for production.',
      '',
      '## Runtime observation',
      'data: real',
      'observed: renders',
      'url: https://app.example.com/orders',
    ].join('\n'),
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /observed:/);
});

test('fails when the observation was made on a development server', async () => {
  const result = await runGate(gate, {
    message: [
      'feat: tax',
      '',
      'RUNTIME-VERIFIED, live in production.',
      '',
      '## Runtime observation',
      'data: real',
      'observed: the tax column shows 21.00 on the first order',
      'url: http://localhost:5173/orders',
    ].join('\n'),
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /deployed address/);
});

test('fails when the data behind the claim was stubbed', async () => {
  const result = await runGate(gate, {
    message: [
      'feat: tax',
      '',
      'RUNTIME-VERIFIED, ready for users.',
      '',
      '## Runtime observation',
      'data: stubbed',
      'observed: the tax column shows 21.00 on the first order',
      'url: https://app.example.com/orders',
    ].join('\n'),
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /data: must say "real"/);
});

test('fails when the honest downgrade names nobody', async () => {
  const result = await runGate(gate, {
    message: 'feat: tax\n\nCODE-COMPLETE, RUNTIME-UNVERIFIED\n\n## Runtime handoff\ncannot-run: no credentials',
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /owner/);
});
