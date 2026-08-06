import { test } from 'node:test';
import assert from 'node:assert/strict';
import gate from '../../src/gates/todo-density.js';
import { runGate } from '../fixtures/context.js';

const MARKER = ['TO', 'DO'].join('');

test('passes when new code carries no deferral markers', async () => {
  const result = await runGate(gate, {
    files: { 'src/order.js': 'export function total(items) {\n  return items.length;\n}\n' },
  });
  assert.equal(result.status, 'pass');
});

test('passes when the marker is annotated on the same line', async () => {
  const result = await runGate(gate, {
    files: {
      'src/order.js': `export function total() {\n  // ${MARKER}: bulk pricing. SAFE-${MARKER}: tracked in ISSUE-412, ships next sprint\n  return 0;\n}\n`,
    },
  });
  assert.equal(result.status, 'pass');
});

test('passes when the annotation sits on the line above', async () => {
  const result = await runGate(gate, {
    files: {
      'src/order.js': `// SAFE-${MARKER}: deliberate, see ISSUE-412\n// ${MARKER}: bulk pricing\nexport const rate = 1;\n`,
    },
  });
  assert.equal(result.status, 'pass');
});

test('ignores an identifier that merely starts with the marker word', async () => {
  const result = await runGate(gate, {
    files: { 'src/list.js': `const ${MARKER.toLowerCase()}List = [];\nexport default ${MARKER.toLowerCase()}List;\n` },
  });
  assert.equal(result.status, 'pass');
});

test('ignores markers in documentation, which is where planning lives', async () => {
  const result = await runGate(gate, {
    files: { 'docs/plan.md': `- [ ] ${MARKER}: decide on pagination\n` },
  });
  assert.equal(result.status, 'pass');
});

test('fails on an unannotated marker in new code', async () => {
  const result = await runGate(gate, {
    files: { 'src/order.js': `export function total() {\n  // ${MARKER}: handle refunds\n  return 0;\n}\n` },
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].file, 'src/order.js');
  assert.equal(result.findings[0].line, 2);
  assert.match(result.message, /SAFE-/);
});

test('fails on every configured marker word, in several languages', async () => {
  const result = await runGate(gate, {
    files: {
      'src/a.py': '# FIXME: race condition on retry\n',
      'src/b.ts': '// HACK: works because ids happen to sort\n',
      'src/c.sql': '-- XXX: index missing\n',
    },
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings.length, 3);
});

test('honours a narrowed token list', async () => {
  const result = await runGate(gate, {
    files: { 'src/a.ts': '// HACK: leave it\n' },
    gates: { TODO_DENSITY: { tokens: ['FIXME'] } },
  });
  assert.equal(result.status, 'pass');
});
