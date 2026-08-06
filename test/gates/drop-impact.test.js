import { test } from 'node:test';
import assert from 'node:assert/strict';
import gate from '../../src/gates/drop-impact.js';
import { runGate } from '../fixtures/context.js';

const DELETED = 'export function formatInvoice(order) {\n  return order.id;\n}\n';

test('skips when nothing is removed', async () => {
  const result = await runGate(gate, {
    files: { 'src/a.js': 'export const a = 1;\n' },
    changed: [{ path: 'src/a.js', status: 'M' }],
  });
  assert.equal(result.status, 'skip');
});

test('passes when the call sites went with it', async () => {
  const result = await runGate(gate, {
    files: { 'src/billing.js': 'export const total = 1;\n' },
    before: { 'src/lib/invoice.js': DELETED },
    changed: [{ path: 'src/lib/invoice.js', status: 'D' }],
    repoFiles: ['src/billing.js'],
  });
  assert.equal(result.status, 'pass');
});

test('passes when the only reference is a comment', async () => {
  const result = await runGate(gate, {
    files: { 'src/billing.js': '// formatInvoice used to live in lib/invoice.js\nexport const total = 1;\n' },
    before: { 'src/lib/invoice.js': DELETED },
    changed: [{ path: 'src/lib/invoice.js', status: 'D' }],
    repoFiles: ['src/billing.js'],
  });
  assert.equal(result.status, 'pass');
});

test('passes when the symbol moved rather than disappeared', async () => {
  const result = await runGate(gate, {
    files: {
      'src/lib/documents.js': 'export function formatInvoice(order) {\n  return order.id;\n}\n',
      'src/billing.js': 'import { formatInvoice } from "./lib/documents.js";\nexport const label = formatInvoice;\n',
    },
    before: { 'src/lib/invoice.js': DELETED },
    changed: [{ path: 'src/lib/invoice.js', status: 'D' }],
    repoFiles: ['src/lib/documents.js', 'src/billing.js'],
  });
  assert.equal(result.status, 'pass');
});

test('does not confuse a same-named module in another directory', async () => {
  const result = await runGate(gate, {
    files: { 'src/reports/index.js': 'import { helper } from "./utils.js";\nexport const r = helper;\n' },
    before: { 'src/admin/utils.js': 'export function adminHelper() {\n  return 1;\n}\n' },
    changed: [{ path: 'src/admin/utils.js', status: 'D' }],
    repoFiles: ['src/reports/index.js'],
  });
  assert.equal(result.status, 'pass');
});

test('fails when an import of the deleted module survives', async () => {
  const result = await runGate(gate, {
    files: { 'src/billing.js': 'import { formatInvoice } from "./lib/invoice.js";\nexport const label = formatInvoice;\n' },
    before: { 'src/lib/invoice.js': DELETED },
    changed: [{ path: 'src/lib/invoice.js', status: 'D' }],
    repoFiles: ['src/billing.js'],
  });
  assert.equal(result.status, 'fail');
  assert.ok(result.findings.some((finding) => finding.file === 'src/billing.js'));
});

test('reports one finding per line, not one per reason', async () => {
  const result = await runGate(gate, {
    files: { 'src/billing.js': 'import { formatInvoice } from "./lib/invoice.js";\nexport const label = formatInvoice;\n' },
    before: { 'src/lib/invoice.js': DELETED },
    changed: [{ path: 'src/lib/invoice.js', status: 'D' }],
    repoFiles: ['src/billing.js'],
  });
  const locations = result.findings.map((finding) => `${finding.file}:${finding.line}`);
  assert.equal(new Set(locations).size, locations.length);
});

test('fails when a deleted symbol is still called', async () => {
  const result = await runGate(gate, {
    files: { 'src/billing.js': 'export function label(order) {\n  return formatInvoice(order);\n}\n' },
    before: { 'src/lib/invoice.js': DELETED },
    changed: [{ path: 'src/lib/invoice.js', status: 'D' }],
    repoFiles: ['src/billing.js'],
  });
  assert.equal(result.status, 'fail');
  assert.match(result.findings[0].detail, /formatInvoice/);
});

test('fails when an alias import points at the removed path', async () => {
  const result = await runGate(gate, {
    files: { 'src/billing.js': 'import { formatInvoice } from "@/lib/invoice";\nexport const label = formatInvoice;\n' },
    before: { 'src/lib/invoice.js': DELETED },
    changed: [{ path: 'src/lib/invoice.js', status: 'D' }],
    repoFiles: ['src/billing.js'],
  });
  assert.equal(result.status, 'fail');
});

test('catches a rename that leaves the old import behind', async () => {
  const result = await runGate(gate, {
    files: {
      'src/lib/documents.js': DELETED,
      'src/billing.js': 'import { formatInvoice } from "./lib/invoice.js";\nexport const label = formatInvoice;\n',
    },
    before: { 'src/lib/invoice.js': DELETED },
    changed: [{ path: 'src/lib/documents.js', oldPath: 'src/lib/invoice.js', status: 'R' }],
    repoFiles: ['src/lib/documents.js', 'src/billing.js'],
  });
  assert.equal(result.status, 'fail');
});

test('ignores archived paths', async () => {
  const result = await runGate(gate, {
    files: { 'src/billing.js': 'export const label = formatInvoice;\n' },
    before: { 'src/_archive/invoice.js': DELETED },
    changed: [{ path: 'src/_archive/invoice.js', status: 'D' }],
    repoFiles: ['src/billing.js'],
  });
  assert.equal(result.status, 'pass');
});
