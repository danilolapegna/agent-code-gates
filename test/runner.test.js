import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGates } from '../src/runner.js';
import { makeContext } from './fixtures/context.js';

/**
 * Build a stub gate with a fixed outcome.
 *
 * @param {string} id Gate identifier.
 * @param {object} [overrides] Fields to override on the gate.
 * @returns {object} Gate definition.
 */
function stubGate(id, overrides = {}) {
  return {
    id,
    title: id,
    description: `stub ${id}`,
    severity: 'error',
    defaults: {},
    appliesTo: () => true,
    run: () => ({ status: 'pass', message: 'fine', findings: [] }),
    ...overrides,
  };
}

const FAILING = stubGate('FAIL_ONE', {
  run: () => ({ status: 'fail', message: 'broken', findings: [{ file: 'a.js', line: 2, excerpt: 'x' }] }),
});

test('a passing run is ok and reports no findings', async () => {
  const run = await runGates(makeContext({}), { gates: [stubGate('OK')] });
  assert.equal(run.ok, true);
  assert.equal(run.summary.passed, 1);
  assert.equal(run.summary.findings, 0);
});

test('a failing error-severity gate blocks the run', async () => {
  const run = await runGates(makeContext({}), { gates: [FAILING] });
  assert.equal(run.ok, false);
  assert.equal(run.summary.failed, 1);
  assert.equal(run.gates[0].blocking, true);
});

test('a failing warning-severity gate does not block', async () => {
  const warn = stubGate('WARN_ONE', { severity: 'warning', run: FAILING.run });
  const run = await runGates(makeContext({}), { gates: [warn] });
  assert.equal(run.ok, true);
  assert.equal(run.summary.warned, 1);
});

test('strict mode promotes warnings to blocking', async () => {
  const warn = stubGate('WARN_ONE', { severity: 'warning', run: FAILING.run });
  const run = await runGates(makeContext({}), { gates: [warn], strict: true });
  assert.equal(run.ok, false);
});

test('a gate that is not applicable is skipped, not passed', async () => {
  const gate = stubGate('NOT_APPLICABLE', { appliesTo: () => false });
  const run = await runGates(makeContext({}), { gates: [gate] });
  assert.equal(run.gates[0].status, 'skip');
  assert.equal(run.gates[0].skip.kind, 'not-applicable');
});

test('a gate that throws is an error and blocks, never a silent pass', async () => {
  const gate = stubGate('EXPLODES', { run: () => { throw new Error('regex blew up'); } });
  const run = await runGates(makeContext({}), { gates: [gate] });
  assert.equal(run.gates[0].status, 'error');
  assert.equal(run.ok, false);
  assert.match(run.gates[0].message, /regex blew up/);
});

test('a gate needing a commit message is skipped when there is none', async () => {
  const gate = stubGate('NEEDS_MESSAGE', { needsCommitMessage: true, run: FAILING.run });
  const run = await runGates(makeContext({}), { gates: [gate] });
  assert.equal(run.gates[0].status, 'skip');
  assert.equal(run.gates[0].skip.kind, 'no-commit-message');
});

test('one skip directive bypasses one gate and is reported', async () => {
  const ctx = makeContext({ message: 'fix: hotfix\n\nagent-code-gates-skip: FAIL_ONE the pager is going off, following up in an hour' });
  const run = await runGates(ctx, { gates: [FAILING] });
  assert.equal(run.ok, true);
  assert.equal(run.gates[0].skip.kind, 'directive');
  assert.equal(run.directives.length, 1);
});

test('two skip directives are a bypass and fail the run', async () => {
  const ctx = makeContext({
    message: [
      'fix: hotfix',
      '',
      'agent-code-gates-skip: FAIL_ONE the pager is going off',
      'agent-code-gates-skip: FAIL_TWO also this one, honestly',
    ].join('\n'),
  });
  const run = await runGates(ctx, { gates: [FAILING, stubGate('FAIL_TWO', { run: FAILING.run })] });
  assert.equal(run.ok, false);
  assert.match(run.problems[0], /2 gates skipped in one commit/);
});

test('a skip directive with no reason is rejected', async () => {
  const ctx = makeContext({ message: 'fix: hotfix\n\nagent-code-gates-skip: FAIL_ONE' });
  const run = await runGates(ctx, { gates: [FAILING] });
  assert.equal(run.ok, false);
  assert.match(run.problems[0], /needs a reason/);
});

test('a skip directive naming an unknown gate is rejected', async () => {
  const ctx = makeContext({ message: 'fix: hotfix\n\nagent-code-gates-skip: FAIL_ONNE typo in the gate name' });
  const run = await runGates(ctx, { gates: [FAILING] });
  assert.equal(run.ok, false);
  assert.match(run.problems[0], /not a known gate/);
});

test('a gate that opts out of the directive sees it itself', async () => {
  const gate = stubGate('SELF_JUDGING', {
    honorsSkipDirective: false,
    run: (ctx) => ({
      status: ctx.skipDirectiveFor('SELF_JUDGING') ? 'fail' : 'pass',
      message: 'saw the directive',
      findings: [],
    }),
  });
  const ctx = makeContext({ message: 'x\n\nagent-code-gates-skip: SELF_JUDGING a reason that is long enough' });
  const run = await runGates(ctx, { gates: [gate] });
  assert.equal(run.gates[0].status, 'fail');
});

test('--gate selection overrides the enabled flag', async () => {
  const ctx = makeContext({});
  ctx.config.gates.FAIL_ONE = { enabled: false, severity: 'error' };
  const run = await runGates(ctx, { gates: [FAILING], only: ['FAIL_ONE'] });
  assert.equal(run.gates.length, 1);
  assert.equal(run.gates[0].status, 'fail');
});

test('a disabled gate does not run at all', async () => {
  const ctx = makeContext({});
  ctx.config.gates.FAIL_ONE = { enabled: false, severity: 'error' };
  const run = await runGates(ctx, { gates: [FAILING] });
  assert.equal(run.gates.length, 0);
  assert.equal(run.ok, true);
});

test('a custom gate receives its own declared defaults', async () => {
  const gate = stubGate('CUSTOM', {
    defaults: { threshold: 7 },
    run: (ctx) => ({
      status: ctx.config.gates.CUSTOM.threshold === 7 ? 'pass' : 'fail',
      message: 'read its options',
      findings: [],
    }),
  });
  const run = await runGates(makeContext({}), { gates: [gate] });
  assert.equal(run.gates[0].status, 'pass');
});
