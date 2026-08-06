/**
 * Language facts the gates need in order to avoid false positives.
 *
 * The single most common way a lint-shaped check earns a reputation for noise
 * is treating a commented-out line as live code. `# TODO` is a comment in
 * Python and a fragment of a CSS colour in a stylesheet; `--` starts a comment
 * in SQL and a decrement in C. Knowing the comment syntax of the file being
 * scanned is therefore not a nicety, it is what keeps the gates quiet enough
 * that people leave them switched on.
 *
 * @module languages
 */

import path from 'node:path';

/**
 * Line-comment markers per extension. Block comments are handled separately
 * because a gate only ever needs to know "could this line be a comment", not
 * to parse nesting.
 *
 * @type {Record<string, string[]>}
 */
const LINE_COMMENTS = {
  '.js': ['//'],
  '.jsx': ['//'],
  '.mjs': ['//'],
  '.cjs': ['//'],
  '.ts': ['//'],
  '.tsx': ['//'],
  '.mts': ['//'],
  '.cts': ['//'],
  '.java': ['//'],
  '.kt': ['//'],
  '.kts': ['//'],
  '.swift': ['//'],
  '.go': ['//'],
  '.rs': ['//'],
  '.c': ['//'],
  '.h': ['//'],
  '.cc': ['//'],
  '.cpp': ['//'],
  '.hpp': ['//'],
  '.cs': ['//'],
  '.php': ['//', '#'],
  '.scala': ['//'],
  '.dart': ['//'],
  '.groovy': ['//'],
  '.css': [],
  '.scss': ['//'],
  '.less': ['//'],
  '.py': ['#'],
  '.rb': ['#'],
  '.sh': ['#'],
  '.bash': ['#'],
  '.zsh': ['#'],
  '.yml': ['#'],
  '.yaml': ['#'],
  '.toml': ['#'],
  '.tf': ['#'],
  '.pl': ['#'],
  '.r': ['#'],
  '.ex': ['#'],
  '.exs': ['#'],
  '.sql': ['--'],
  '.lua': ['--'],
  '.hs': ['--'],
  '.elm': ['--'],
  '.vue': ['//'],
  '.svelte': ['//'],
  '.html': [],
  '.md': [],
};

/**
 * Extensions treated as program source when a gate says "source file".
 *
 * SQL is included: a migration is code that runs in production, and a deferral
 * marker left in one is exactly as unfinished as a deferral marker in a
 * service. Markup and documentation are excluded, since the words the gates
 * look for are ordinary vocabulary there.
 */
const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.scala',
  '.dart', '.ex', '.exs', '.vue', '.svelte', '.sh', '.bash', '.sql',
]);

/**
 * Path fragments that mark a file as test code, checked against the whole
 * repo-relative path rather than only the basename so that `tests/api/user.js`
 * is recognised even though its basename carries no marker.
 */
const TEST_PATH_HINTS = [
  '/__tests__/', '/__test__/', '/test/', '/tests/', '/spec/', '/specs/',
  '/e2e/', '/cypress/', '/testdata/', '/fixtures/', '/__mocks__/',
];

/** Basename shapes that mark a file as test code across common ecosystems. */
const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /^test_[^/]+\.py$/i,
  /_test\.py$/i,
  /_test\.go$/i,
  /_spec\.rb$/i,
  /Test\.java$/,
  /Tests?\.cs$/,
];

/**
 * Resolve the lowercase extension of a path, including the leading dot.
 *
 * @param {string} filePath Any path.
 * @returns {string} Extension such as `.ts`, or an empty string.
 */
export function extensionOf(filePath) {
  return path.extname(filePath).toLowerCase();
}

/**
 * Line-comment markers valid for a given file.
 *
 * Unknown extensions fall back to the union of the three most common markers.
 * That errs toward classifying a line as a comment, which errs toward silence:
 * the deliberate bias for a tool whose credibility depends on not crying wolf.
 *
 * @param {string} filePath Repo-relative path.
 * @returns {string[]} Comment prefixes to test at the start of a trimmed line.
 */
export function commentPrefixesFor(filePath) {
  const known = LINE_COMMENTS[extensionOf(filePath)];
  return known ?? ['//', '#', '--'];
}

/**
 * Whether a source line is entirely a comment.
 *
 * Block-comment continuation lines (`*`, `/*`, `<!--`) count as comments for
 * every language, because a gate that flags a `console.log` inside a JSDoc
 * example is a gate people disable.
 *
 * @param {string} line Raw source line, indentation included.
 * @param {string} filePath Path the line came from, used to pick comment syntax.
 * @returns {boolean} True when nothing on the line is live code.
 */
export function isCommentLine(line, filePath) {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('<!--')) return true;
  return commentPrefixesFor(filePath).some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Whether a path holds program source, as opposed to docs, data or config.
 *
 * @param {string} filePath Repo-relative path.
 * @returns {boolean} True for recognised programming-language extensions.
 */
export function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(extensionOf(filePath));
}

/**
 * Whether a path looks like test code.
 *
 * Used to keep test-only conventions (a deliberate `console.log` in a test
 * helper, a fixture that contains a fake token) from being reported as
 * production defects.
 *
 * @param {string} filePath Repo-relative path with `/` separators.
 * @returns {boolean} True when the path is recognised as a test.
 */
export function isTestFile(filePath) {
  const normalised = `/${filePath.replace(/\\/g, '/')}`;
  if (TEST_PATH_HINTS.some((hint) => normalised.includes(hint))) return true;
  const base = path.basename(filePath);
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(base));
}
