import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesGlob, matchesAnyGlob } from '../src/glob.js';

test('a single star stops at a path separator', () => {
  assert.equal(matchesGlob('src/a.js', 'src/*.js'), true);
  assert.equal(matchesGlob('src/deep/a.js', 'src/*.js'), false);
});

test('a double star crosses separators', () => {
  assert.equal(matchesGlob('src/deep/nested/a.js', 'src/**'), true);
  assert.equal(matchesGlob('a.tsx', '**/*.tsx'), true);
  assert.equal(matchesGlob('src/ui/a.tsx', '**/*.tsx'), true);
});

test('a double star directory also matches zero directories', () => {
  assert.equal(matchesGlob('migrations/001.sql', '**/migrations/*.sql'), true);
  assert.equal(matchesGlob('db/migrations/001.sql', '**/migrations/*.sql'), true);
  assert.equal(matchesGlob('db/migrations/sub/001.sql', '**/migrations/*.sql'), false);
});

test('a question mark matches exactly one character', () => {
  assert.equal(matchesGlob('a1.js', 'a?.js'), true);
  assert.equal(matchesGlob('a12.js', 'a?.js'), false);
});

test('regex metacharacters in a pattern stay literal', () => {
  assert.equal(matchesGlob('src/a.js', 'src/a.js'), true);
  assert.equal(matchesGlob('src/axjs', 'src/a.js'), false);
  assert.equal(matchesGlob('a+b.js', 'a+b.js'), true);
});

test('the whole path must match, not a fragment', () => {
  assert.equal(matchesGlob('vendor/src/a.js', 'src/*.js'), false);
});

test('an empty pattern list matches nothing', () => {
  assert.equal(matchesAnyGlob('src/a.js', []), false);
  assert.equal(matchesAnyGlob('src/a.js', undefined), false);
});

test('any one pattern in a list is enough', () => {
  assert.equal(matchesAnyGlob('src/a.tsx', ['app/**', '**/*.tsx']), true);
});
