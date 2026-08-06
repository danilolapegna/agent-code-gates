import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAnnotated,
  isPlaceholderValue,
  isLocalUrl,
  readField,
  readSection,
  wordOverlap,
  firstUrl,
} from '../src/text.js';
import { isCommentLine, isTestFile, isSourceFile } from '../src/languages.js';

test('an annotation counts on its own line and the line above', () => {
  const lines = ['// SAFE-LOG: deliberate', 'console.log(1);', 'console.log(2); // SAFE-LOG: also deliberate', 'console.log(3);'];
  assert.equal(isAnnotated(lines, 1, 'SAFE-LOG'), true);
  assert.equal(isAnnotated(lines, 2, 'SAFE-LOG'), true);
  assert.equal(isAnnotated(lines, 3, 'SAFE-LOG'), false);
});

test('placeholder values are recognised, real ones are not', () => {
  for (const value of ['n/a', 'TBD', '...', '<your key>', 'changeme', '']) {
    assert.equal(isPlaceholderValue(value), true, `${value} should be a placeholder`);
  }
  assert.equal(isPlaceholderValue('the totals row shows 148.20'), false);
});

test('development servers are recognised as local', () => {
  for (const url of ['http://localhost:3000/x', 'http://127.0.0.1/x', 'https://app.local/x', 'https://x.example.com:5173/a']) {
    assert.equal(isLocalUrl(url), true, `${url} should be local`);
  }
  assert.equal(isLocalUrl('https://app.example.com/orders'), false);
});

test('fields are read with loose separators and optional bullets', () => {
  const block = '- success_criteria: three rows\n  URL : https://example.com\n';
  assert.equal(readField(block, 'success criteria'), 'three rows');
  assert.equal(readField(block, 'url'), 'https://example.com');
  assert.equal(readField(block, 'missing'), null);
});

test('a section stops at the next heading', () => {
  const document = '## First\nalpha\n\n## Second\nbeta\n';
  assert.match(readSection(document, 'First'), /alpha/);
  assert.ok(!readSection(document, 'First').includes('beta'));
  assert.equal(readSection(document, 'Third'), null);
});

test('word overlap is directional and ignores filler', () => {
  assert.ok(wordOverlap('send the confirmation email', 'Confirmation email: NOT-STARTED') >= 0.6);
  assert.ok(wordOverlap('send the confirmation email', 'unrelated work on invoices') < 0.5);
  assert.equal(wordOverlap('', 'anything'), 0);
});

test('the first URL is extracted from surrounding prose', () => {
  assert.equal(firstUrl('seen at https://app.example.com/orders today'), 'https://app.example.com/orders');
  assert.equal(firstUrl('no address here'), null);
});

test('comment detection follows the language of the file', () => {
  assert.equal(isCommentLine('# a note', 'a.py'), true);
  assert.equal(isCommentLine('# a note', 'a.js'), false);
  assert.equal(isCommentLine('-- a note', 'a.sql'), true);
  assert.equal(isCommentLine(' * continued', 'a.ts'), true);
});

test('test paths are recognised across ecosystems', () => {
  for (const file of ['src/a.test.js', 'src/a.spec.ts', 'tests/api/user.js', 'app/test_pricing.py', 'pkg/thing_test.go']) {
    assert.equal(isTestFile(file), true, `${file} should be a test`);
  }
  assert.equal(isTestFile('src/latest.js'), false);
});

test('source files are distinguished from documents', () => {
  assert.equal(isSourceFile('src/a.ts'), true);
  assert.equal(isSourceFile('README.md'), false);
  assert.equal(isSourceFile('db/schema.sql'), true);
});
