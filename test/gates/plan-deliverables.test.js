import { test } from 'node:test';
import assert from 'node:assert/strict';
import gate from '../../src/gates/plan-deliverables.js';
import { runGate } from '../fixtures/context.js';

const PLAN = [
  '# Checkout plan',
  '',
  '- [x] Add the cart summary component',
  '- [ ] Apply regional tax rules at checkout',
  '- [ ] Send the confirmation email',
  '- [ ] Record the order in the audit log',
  '',
].join('\n');

const FIXTURE = {
  files: { 'docs/checkout-plan.md': PLAN, 'src/checkout.js': 'export const ok = true;\n' },
  repoFiles: ['docs/checkout-plan.md', 'src/checkout.js'],
};

test('skips when no plan file is referenced', async () => {
  const result = await runGate(gate, { ...FIXTURE, message: 'feat: checkout tax rules' });
  assert.equal(result.status, 'skip');
});

test('skips when the referenced plan is not tracked', async () => {
  const result = await runGate(gate, {
    ...FIXTURE,
    message: 'feat: checkout\n\nPlan: docs/nowhere-plan.md',
  });
  assert.equal(result.status, 'skip');
});

test('passes when every open item carries a status', async () => {
  const result = await runGate(gate, {
    ...FIXTURE,
    message: [
      'feat: checkout tax rules',
      '',
      'Plan: docs/checkout-plan.md',
      '- Apply regional tax rules at checkout: DONE',
      '- Send the confirmation email: NOT-STARTED, waiting on template copy',
      '- Record the order in the audit log: PARTIAL, writes but does not redact',
    ].join('\n'),
  });
  assert.equal(result.status, 'pass');
});

test('accepts statuses declared by item number', async () => {
  const result = await runGate(gate, {
    ...FIXTURE,
    message: [
      'feat: checkout tax rules',
      '',
      'docs/checkout-plan.md',
      '2. DONE',
      '3. SKIPPED, the provider handles it',
      '4. NOT-STARTED',
    ].join('\n'),
  });
  assert.equal(result.status, 'pass');
});

test('treats items already checked off in the plan as reported', async () => {
  const result = await runGate(gate, {
    files: { 'docs/checkout-plan.md': '- [x] Add the cart summary component\n' },
    repoFiles: ['docs/checkout-plan.md'],
    message: 'chore: tidy up\n\nPlan: docs/checkout-plan.md',
  });
  assert.equal(result.status, 'pass');
});

test('fails on the items the commit never mentions', async () => {
  const result = await runGate(gate, {
    ...FIXTURE,
    message: [
      'feat: checkout tax rules',
      '',
      'Plan: docs/checkout-plan.md',
      '- Apply regional tax rules at checkout: DONE',
    ].join('\n'),
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings.length, 2);
  assert.match(result.findings[0].excerpt, /confirmation email/);
  assert.match(result.message, /NOT-STARTED costs nothing/);
});

test('fails when items are named without a status word', async () => {
  const result = await runGate(gate, {
    ...FIXTURE,
    message: [
      'feat: checkout',
      '',
      'Plan: docs/checkout-plan.md',
      'Worked on the regional tax rules at checkout and the confirmation email.',
      'Also touched the order audit log.',
    ].join('\n'),
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings.length, 3);
});

test('reads numbered plans when there are no checkboxes', async () => {
  const result = await runGate(gate, {
    files: { 'docs/release-plan.md': '# Release plan\n\n1. Cut the tag\n2. Publish the package\n' },
    repoFiles: ['docs/release-plan.md'],
    message: 'chore: release\n\nPlan: docs/release-plan.md\n1. Cut the tag: DONE',
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].excerpt, /Publish the package/);
});
