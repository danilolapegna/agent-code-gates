import { test } from 'node:test';
import assert from 'node:assert/strict';
import gate from '../../src/gates/debug-residue.js';
import { runGate } from '../fixtures/context.js';

test('passes when changed source has no debug statements', async () => {
  const result = await runGate(gate, {
    files: { 'src/api.js': 'export function ping() {\n  return "pong";\n}\n' },
  });
  assert.equal(result.status, 'pass');
});

test('passes when the statement is inside a comment', async () => {
  const result = await runGate(gate, {
    files: { 'src/api.js': 'export function ping() {\n  // console.log("was here")\n  return 1;\n}\n' },
  });
  assert.equal(result.status, 'pass');
});

test('passes for a deliberate statement carrying the annotation', async () => {
  const result = await runGate(gate, {
    files: {
      'src/api.js': '// SAFE-LOG: the CLI prints its result here by design\nconsole.log(result);\nexport const x = 1;\n',
    },
  });
  assert.equal(result.status, 'pass');
});

test('ignores debug statements inside tests', async () => {
  const result = await runGate(gate, {
    files: { 'src/api.test.js': 'console.log("debugging the fixture");\n' },
  });
  assert.equal(result.status, 'skip');
});

test('ignores print() on a command line entry point', async () => {
  const result = await runGate(gate, {
    files: { 'bin/report.py': 'def main():\n    print("done")\n' },
  });
  assert.equal(result.status, 'pass');
});

test('leaves a disabled language rule alone', async () => {
  const result = await runGate(gate, {
    files: { 'src/server.go': 'func handle() {\n\tfmt.Println("here")\n}\n' },
  });
  assert.equal(result.status, 'pass');
});

test('fails on console.log added to production source', async () => {
  const result = await runGate(gate, {
    files: { 'src/api.js': 'export function ping() {\n  console.log("here", token);\n  return 1;\n}\n' },
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].line, 2);
  assert.equal(result.findings[0].detail, 'console debug call');
});

test('fails on a debugger statement and on python breakpoints', async () => {
  const result = await runGate(gate, {
    files: {
      'src/api.ts': 'export function ping() {\n  debugger;\n  return 1;\n}\n',
      'src/worker.py': 'def run():\n    import pdb\n    return 1\n',
    },
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings.length, 2);
});

test('fails on print() in ordinary python source', async () => {
  const result = await runGate(gate, {
    files: { 'src/pricing.py': 'def total(items):\n    print(items)\n    return len(items)\n' },
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings[0].detail, 'print() call');
});

test('can be turned on for a language that ships disabled', async () => {
  const result = await runGate(gate, {
    files: { 'src/server.go': 'func handle() {\n\tfmt.Println("here")\n}\n' },
    gates: { DEBUG_RESIDUE: { rules: { goPrint: true } } },
  });
  assert.equal(result.status, 'fail');
});
