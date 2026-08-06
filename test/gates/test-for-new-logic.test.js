import { test } from 'node:test';
import assert from 'node:assert/strict';
import gate from '../../src/gates/test-for-new-logic.js';
import { runGate } from '../fixtures/context.js';

const LOGIC = [
  'export function priceFor(item, region) {',
  '  if (!item) return 0;',
  '  if (region === "eu") return item.price * 1.21;',
  '  for (const rule of item.rules) {',
  '    if (rule.applies) return rule.price;',
  '  }',
  '  return item.price;',
  '}',
  '',
].join('\n');

test('passes when a sibling test file lands in the same change', async () => {
  const result = await runGate(gate, {
    files: {
      'src/lib/pricing.js': LOGIC,
      'src/lib/pricing.test.js': 'import { priceFor } from "./pricing.js";\n',
    },
    changed: [
      { path: 'src/lib/pricing.js', status: 'A' },
      { path: 'src/lib/pricing.test.js', status: 'A' },
    ],
  });
  assert.equal(result.status, 'pass');
});

test('passes when an existing test imports the new module', async () => {
  const result = await runGate(gate, {
    files: {
      'src/lib/pricing.js': LOGIC,
      'test/checkout.spec.js': 'import { priceFor } from "../src/lib/pricing.js";\n',
    },
    changed: [{ path: 'src/lib/pricing.js', status: 'A' }],
  });
  assert.equal(result.status, 'pass');
});

test('passes for a new module with no branching to get wrong', async () => {
  const result = await runGate(gate, {
    files: { 'src/lib/constants.js': 'export const TAX_EU = 0.21;\nexport const TAX_US = 0;\n' },
    changed: [{ path: 'src/lib/constants.js', status: 'A' }],
  });
  assert.equal(result.status, 'pass');
});

test('passes when the gap is acknowledged in the file', async () => {
  const result = await runGate(gate, {
    files: { 'src/lib/pricing.js': `// test-debt-ack: covered end to end by the checkout suite\n${LOGIC}` },
    changed: [{ path: 'src/lib/pricing.js', status: 'A' }],
  });
  assert.equal(result.status, 'pass');
});

test('ignores modified files, since the gate is about new logic', async () => {
  const result = await runGate(gate, {
    files: { 'src/lib/pricing.js': LOGIC },
    changed: [{ path: 'src/lib/pricing.js', status: 'M' }],
  });
  assert.equal(result.status, 'skip');
});

test('fails on a new branching module nothing tests', async () => {
  const result = await runGate(gate, {
    files: { 'src/lib/pricing.js': LOGIC, 'test/unrelated.test.js': 'import { other } from "../src/other.js";\n' },
    changed: [{ path: 'src/lib/pricing.js', status: 'A' }],
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].file, 'src/lib/pricing.js');
});

test('respects a raised branch threshold', async () => {
  const result = await runGate(gate, {
    files: { 'src/lib/pricing.js': LOGIC },
    changed: [{ path: 'src/lib/pricing.js', status: 'A' }],
    gates: { TEST_FOR_NEW_LOGIC: { minBranches: 20 } },
  });
  assert.equal(result.status, 'pass');
});

test('skips generated and migration paths', async () => {
  const result = await runGate(gate, {
    files: { 'src/generated/client.ts': LOGIC },
    changed: [{ path: 'src/generated/client.ts', status: 'A' }],
  });
  assert.equal(result.status, 'pass');
});
