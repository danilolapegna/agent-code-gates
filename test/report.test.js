import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHuman, renderJson, renderList, exitCodeFor, shouldUseColor } from '../src/report.js';
import { gateRegistry } from '../src/gates/index.js';

/**
 * A run result shaped like the runner's output.
 *
 * @param {object} [overrides] Fields to replace.
 * @returns {object} Run result.
 */
function runResult(overrides = {}) {
  return {
    repo: '/repo',
    mode: 'staged',
    ref: 'staged',
    strict: false,
    durationMs: 420,
    directives: [],
    problems: [],
    gates: [
      {
        id: 'TODO_DENSITY',
        title: 'Unannotated markers',
        status: 'pass',
        severity: 'error',
        blocking: false,
        message: 'no unannotated markers added',
        findings: [],
        durationMs: 3,
        skip: null,
      },
      {
        id: 'DEBUG_RESIDUE',
        title: 'Debug statements',
        status: 'fail',
        severity: 'error',
        blocking: true,
        message: 'one debug statement added to production source',
        findings: [{ file: 'src/api.js', line: 14, excerpt: 'console.log(user)', detail: 'console debug call' }],
        durationMs: 5,
        skip: null,
      },
    ],
    summary: { total: 2, passed: 1, failed: 1, warned: 0, skipped: 0, errored: 0, findings: 1, problems: 0 },
    ok: false,
    ...overrides,
  };
}

test('the human report names the file, the line and the fix', () => {
  const text = renderHuman(runResult());
  assert.match(text, /DEBUG_RESIDUE/);
  assert.match(text, /src\/api\.js:14/);
  assert.match(text, /console\.log\(user\)/);
  assert.match(text, /BLOCKED/);
  assert.match(text, /agent-code-gates-skip/);
});

test('a passing run says so plainly', () => {
  const run = runResult({ ok: true });
  run.gates = [run.gates[0]];
  run.summary = { total: 1, passed: 1, failed: 0, warned: 0, skipped: 0, errored: 0, findings: 0, problems: 0 };
  const text = renderHuman(run);
  assert.match(text, /PASSED/);
  assert.ok(!text.includes('BLOCKED'));
});

test('a non-blocking failure prints as a warning, matching its consequence', () => {
  const run = runResult({ ok: true });
  run.gates[1].blocking = false;
  run.gates[1].severity = 'warning';
  const text = renderHuman(run);
  assert.match(text, /WARN {2}DEBUG_RESIDUE/);
});

test('skip directives are surfaced loudly rather than swallowed', () => {
  const run = runResult({ directives: [{ gate: 'COMMIT_SIZE', reason: 'generated client' }] });
  assert.match(renderHuman(run), /SKIPPED BY DIRECTIVE {2}COMMIT_SIZE: generated client/);
});

test('run-level problems appear in the report', () => {
  const run = runResult({ problems: ['2 gates skipped in one commit'] });
  assert.match(renderHuman(run), /PROBLEM/);
});

test('no ANSI codes are emitted when colour is off', () => {
  const text = renderHuman(runResult(), { color: false });
  assert.ok(!text.includes('\u001b['));
});

test('the JSON report exposes a stable decision surface', () => {
  const payload = JSON.parse(renderJson(runResult()));
  assert.equal(payload.tool, 'agent-code-gates');
  assert.equal(payload.ok, false);
  assert.equal(payload.summary.failed, 1);
  const gate = payload.gates.find((entry) => entry.id === 'DEBUG_RESIDUE');
  assert.equal(gate.outcome, 'fail');
  assert.equal(gate.findings[0].line, 14);
});

test('the listing shows every gate with its effective severity', () => {
  const text = renderList(gateRegistry);
  for (const gate of gateRegistry) assert.match(text, new RegExp(gate.id));
  assert.match(text, /warning {2}COMMIT_SIZE/);
  assert.match(text, /error {4}TODO_DENSITY/);
});

test('exit codes follow the run outcome', () => {
  assert.equal(exitCodeFor(runResult()), 1);
  assert.equal(exitCodeFor(runResult({ ok: true })), 0);
});

test('NO_COLOR wins over a terminal that supports colour', () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    assert.equal(shouldUseColor({ isTTY: true }), false);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});
