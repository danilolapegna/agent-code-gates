import { test } from 'node:test';
import assert from 'node:assert/strict';
import gate from '../../src/gates/commit-size.js';
import { runGate } from '../fixtures/context.js';

/**
 * Build a change of a given shape without writing file contents.
 *
 * @param {number} files How many files change.
 * @param {number} lines Total insertions plus deletions.
 * @returns {object} Fixture fields describing that change.
 */
function change(files, lines) {
  const perFile = Math.floor(lines / Math.max(files, 1));
  return {
    changed: Array.from({ length: files }, (unused, index) => ({
      path: `src/module-${index}.js`,
      status: 'M',
      insertions: perFile,
      deletions: 0,
    })),
    stats: { files, insertions: lines, deletions: 0 },
  };
}

test('passes for a change inside the review budget', async () => {
  const result = await runGate(gate, { ...change(3, 120), message: 'fix: correct tax rounding' });
  assert.equal(result.status, 'pass');
});

test('passes when an oversized change explains itself', async () => {
  const result = await runGate(gate, {
    ...change(14, 1800),
    message: 'refactor: move the generated client\n\nWhy monolith: the generated client and every call site have to move in one step or the build breaks between commits.',
  });
  assert.equal(result.status, 'pass');
});

test('accepts the justification written as a markdown heading', async () => {
  const result = await runGate(gate, {
    ...change(14, 1800),
    message: 'refactor: move the client\n\n## Why monolith\nThe generated file and its call sites are one unit.',
  });
  assert.equal(result.status, 'pass');
});

test('fails on too many files with no explanation', async () => {
  const result = await runGate(gate, { ...change(12, 200), message: 'feat: add reporting' });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /12 files \(budget 5\)/);
  assert.ok(result.findings.length > 0);
});

test('fails on too many lines with no explanation', async () => {
  const result = await runGate(gate, { ...change(2, 2400), message: 'feat: add reporting' });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /2400 lines \(budget 500\)/);
});

test('respects raised budgets', async () => {
  const result = await runGate(gate, {
    ...change(12, 2400),
    message: 'feat: add reporting',
    gates: { COMMIT_SIZE: { maxFiles: 20, maxLines: 5000 } },
  });
  assert.equal(result.status, 'pass');
});

test('lists the biggest files first, as split candidates', async () => {
  const result = await runGate(gate, {
    changed: [
      { path: 'src/small.js', status: 'M', insertions: 5, deletions: 0 },
      { path: 'src/huge.js', status: 'M', insertions: 900, deletions: 20 },
      { path: 'src/medium.js', status: 'M', insertions: 60, deletions: 0 },
    ],
    stats: { files: 3, insertions: 965, deletions: 20 },
    message: 'feat: reporting',
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings[0].file, 'src/huge.js');
});
