import { test } from 'node:test';
import assert from 'node:assert/strict';
import gate from '../../src/gates/skipped-tests.js';
import { runGate } from '../fixtures/context.js';

test('passes when the change enables tests rather than disabling them', async () => {
  const result = await runGate(gate, {
    files: { 'src/order.test.js': 'test("totals", () => {\n  expect(total([1])).toBe(1);\n});\n' },
  });
  assert.equal(result.status, 'pass');
});

test('passes for a quarantine carrying the annotation', async () => {
  const result = await runGate(gate, {
    files: {
      'src/order.test.js': '// SAFE-SKIP: flaky against the sandbox gateway, tracked in ISSUE-88\ntest.skip("charges the card", () => {});\n',
    },
  });
  assert.equal(result.status, 'pass');
});

test('ignores an example inside documentation', async () => {
  const result = await runGate(gate, {
    files: { 'README.md': 'Disable a case with `it.skip("name", ...)` while you investigate.\n' },
  });
  assert.equal(result.status, 'pass');
});

test('fails when a test is skipped', async () => {
  const result = await runGate(gate, {
    files: { 'src/order.test.js': 'describe("orders", () => {\n  it.skip("applies tax", () => {});\n});\n' },
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].line, 2);
  assert.equal(result.findings[0].detail, 'skipped test');
});

test('fails across framework dialects', async () => {
  const result = await runGate(gate, {
    files: {
      'tests/a.js': 'xit("legacy case", () => {});\n',
      'tests/b.js': 'test.todo("write this");\n',
      'tests/test_pricing.py': '@pytest.mark.skip(reason="later")\ndef test_total():\n    pass\n',
      'tests/OrderTests.cs': '[Ignore("broken")]\npublic void Total() {}\n',
      'tests/order_test.go': 'func TestTotal(t *testing.T) {\n\tt.Skip("later")\n}\n',
    },
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings.length, 5);
});

test('fails on a focused test, which disables its neighbours', async () => {
  const result = await runGate(gate, {
    files: { 'src/order.test.js': 'it.only("the one I am debugging", () => {});\n' },
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings[0].detail, 'focused test');
});

test('can be configured to allow focused tests', async () => {
  const result = await runGate(gate, {
    files: { 'src/order.test.js': 'it.only("the one I am debugging", () => {});\n' },
    gates: { SKIPPED_TESTS: { includeFocused: false } },
  });
  assert.equal(result.status, 'pass');
});
