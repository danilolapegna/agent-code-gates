import { test } from 'node:test';
import assert from 'node:assert/strict';
import gate from '../../src/gates/secret-shaped-literal.js';
import { runGate } from '../fixtures/context.js';

test('passes when credentials come from the environment', async () => {
  const result = await runGate(gate, {
    files: { 'src/client.js': 'const apiKey = process.env.SERVICE_API_KEY;\nexport default apiKey;\n' },
  });
  assert.equal(result.status, 'pass');
});

test('passes on documentation placeholders', async () => {
  const result = await runGate(gate, {
    files: { 'docs/setup.md': 'Set `api_key = "<your-api-key>"` in the config file.\n' },
  });
  assert.equal(result.status, 'pass');
});

test('passes on obvious sample values', async () => {
  const result = await runGate(gate, {
    files: { 'src/config.js': 'const password = "changeme";\nconst token = "your-token-here";\n' },
  });
  assert.equal(result.status, 'pass');
});

test('passes on example files', async () => {
  const result = await runGate(gate, {
    files: { '.env.example': 'API_KEY="Zt7Qx9La2Mv4Nb8Kc1Rd"\n' },
  });
  assert.equal(result.status, 'pass');
});

test('passes when a reviewed literal is annotated', async () => {
  const result = await runGate(gate, {
    files: {
      'src/fixtures.js': '// allowlist-secret: expired sandbox key kept for the replay fixture\nconst apiKey = "Zt7Qx9La2Mv4Nb8Kc1Rd";\n',
    },
  });
  assert.equal(result.status, 'pass');
});

test('fails on an issuer-prefixed token', async () => {
  const result = await runGate(gate, {
    files: { 'src/aws.js': 'const id = "AKIA2QVXZL7NMP4RTKWE";\n' },
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings[0].detail, 'AWS access key id');
});

test('fails on a credential-shaped assignment', async () => {
  const result = await runGate(gate, {
    files: { 'src/client.js': 'const apiKey = "Zt7Qx9La2Mv4Nb8Kc1Rd5Se";\n' },
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings[0].detail, 'credential-shaped assignment');
});

test('fails on a private key block', async () => {
  const result = await runGate(gate, {
    files: { 'src/signing.js': 'const key = `-----BEGIN RSA PRIVATE KEY-----`;\n' },
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.findings[0].detail, 'private key block');
});

test('masks the literal in the reported excerpt', async () => {
  const result = await runGate(gate, {
    files: { 'src/aws.js': 'const id = "AKIA2QVXZL7NMP4RTKWE";\n' },
  });
  assert.equal(result.status, 'fail');
  assert.ok(!result.findings[0].excerpt.includes('AKIA2QVXZL7NMP4RTKWE'));
  assert.match(result.findings[0].excerpt, /\*{6}/);
});

test('honours an extra allow pattern', async () => {
  const result = await runGate(gate, {
    files: { 'src/aws.js': 'const id = "AKIA2QVXZL7NMP4RTKWE"; // rotated 2026-01-01\n' },
    gates: { SECRET_SHAPED_LITERAL: { allow: ['rotated \\d{4}'] } },
  });
  assert.equal(result.status, 'pass');
});
