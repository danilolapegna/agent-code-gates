import { test } from 'node:test';
import assert from 'node:assert/strict';
import gate from '../../src/gates/ephemeral-lifecycle.js';
import { runGate } from '../fixtures/context.js';

const COMPLETE = [
  '-- Retention: rows are kept for 24 hours past expiry',
  'CREATE TABLE login_tokens (',
  '  id uuid PRIMARY KEY,',
  '  expires_at timestamptz NOT NULL',
  ');',
  'CREATE INDEX login_tokens_expires_at_idx ON login_tokens (expires_at);',
  "DELETE FROM login_tokens WHERE expires_at < now() - interval '24 hours';",
  '',
].join('\n');

test('skips when the change adds no migration', async () => {
  const result = await runGate(gate, {
    files: { 'src/a.js': 'export const a = 1;\n' },
    changed: [{ path: 'src/a.js', status: 'M' }],
  });
  assert.equal(result.status, 'skip');
});

test('passes for a table with no expiry column', async () => {
  const result = await runGate(gate, {
    files: { 'db/migrations/001_users.sql': 'CREATE TABLE users (id uuid PRIMARY KEY, email text);\n' },
    changed: [{ path: 'db/migrations/001_users.sql', status: 'A' }],
  });
  assert.equal(result.status, 'pass');
});

test('passes when index, cleanup and retention are all present', async () => {
  const result = await runGate(gate, {
    files: { 'db/migrations/002_tokens.sql': COMPLETE },
    changed: [{ path: 'db/migrations/002_tokens.sql', status: 'A' }],
  });
  assert.equal(result.status, 'pass');
});

test('accepts cleanup declared as running elsewhere', async () => {
  const result = await runGate(gate, {
    files: {
      'db/migrations/002_tokens.sql': [
        '-- Retention: 24 hours',
        '-- Cleanup: the nightly reaper job in ops/reaper.py removes expired rows',
        'CREATE TABLE login_tokens (id uuid PRIMARY KEY, expires_at timestamptz);',
        'CREATE INDEX ON login_tokens (expires_at);',
      ].join('\n'),
    },
    changed: [{ path: 'db/migrations/002_tokens.sql', status: 'A' }],
  });
  assert.equal(result.status, 'pass');
});

test('ignores a migration that only alters an existing table', async () => {
  const result = await runGate(gate, {
    files: { 'db/migrations/003_alter.sql': 'ALTER TABLE login_tokens ADD COLUMN expires_at timestamptz;\n' },
    changed: [{ path: 'db/migrations/003_alter.sql', status: 'A' }],
  });
  assert.equal(result.status, 'pass');
});

test('fails when nothing removes the expired rows', async () => {
  const result = await runGate(gate, {
    files: {
      'db/migrations/002_tokens.sql': [
        'CREATE TABLE login_tokens (',
        '  id uuid PRIMARY KEY,',
        '  expires_at timestamptz NOT NULL',
        ');',
      ].join('\n'),
    },
    changed: [{ path: 'db/migrations/002_tokens.sql', status: 'A' }],
  });
  assert.equal(result.status, 'fail');
  assert.match(result.findings[0].detail, /an index on expires_at/);
  assert.match(result.findings[0].detail, /deletes expired rows/);
  assert.match(result.findings[0].detail, /Retention/);
});

test('fails when only the index is missing', async () => {
  const result = await runGate(gate, {
    files: {
      'db/migrations/002_tokens.sql': [
        '-- Retention: 24 hours',
        'CREATE TABLE login_tokens (id uuid PRIMARY KEY, expires_at timestamptz);',
        'DELETE FROM login_tokens WHERE expires_at < now();',
      ].join('\n'),
    },
    changed: [{ path: 'db/migrations/002_tokens.sql', status: 'A' }],
  });
  assert.equal(result.status, 'fail');
  assert.match(result.findings[0].detail, /^missing an index on expires_at$/);
});

test('recognises other expiry column names', async () => {
  const result = await runGate(gate, {
    files: {
      'supabase/migrations/004_cache.sql': 'CREATE TABLE page_cache (key text PRIMARY KEY, valid_until timestamptz);\n',
    },
    changed: [{ path: 'supabase/migrations/004_cache.sql', status: 'A' }],
  });
  assert.equal(result.status, 'fail');
  assert.match(result.findings[0].excerpt, /valid_until/);
});
