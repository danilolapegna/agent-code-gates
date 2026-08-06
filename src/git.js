/**
 * Thin, typed wrapper over the git plumbing the gates depend on.
 *
 * Two decisions here are load-bearing:
 *
 * 1. Commands are invoked with an argument array and no shell. A repository
 *    path containing a space or a quote is not exotic, and shelling out with
 *    string interpolation turns such a path into either a crash or, worse, a
 *    silently empty result that a gate reads as "nothing to report".
 * 2. `core.quotePath=false` is forced. Otherwise git escapes non-ASCII paths
 *    into octal, and a gate comparing that string to a real filename finds no
 *    match and passes a file it never actually inspected.
 *
 * @module git
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Arguments prepended to every invocation to make output machine-stable. */
const STABLE_ARGS = ['-c', 'core.quotePath=false', '--no-pager'];

/** Output cap for a single git invocation. Large diffs are real; unbounded buffers are not. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Error thrown when git itself fails in a way the caller should surface.
 */
export class GitError extends Error {
  /**
   * @param {string} message Human-readable summary.
   * @param {{args: string[], stderr: string}} detail Invocation detail for diagnostics.
   */
  constructor(message, detail) {
    super(message);
    this.name = 'GitError';
    this.args = detail.args;
    this.stderr = detail.stderr;
  }
}

/**
 * Run git and return stdout, throwing on a non-zero exit.
 *
 * @param {string} cwd Directory to run in.
 * @param {string[]} args Git arguments, already split.
 * @returns {string} Raw stdout with the trailing newline removed.
 * @throws {GitError} When git exits non-zero or is not installed.
 */
export function git(cwd, args) {
  try {
    const stdout = execFileSync('git', [...STABLE_ARGS, ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return stdout.replace(/\n$/, '');
  } catch (error) {
    const stderr = String(error?.stderr ?? error?.message ?? '').trim();
    throw new GitError(`git ${args.join(' ')} failed: ${stderr}`, { args, stderr });
  }
}

/**
 * Run git and return an empty string instead of throwing.
 *
 * Reserved for probes where absence is a legitimate answer, such as asking for
 * a file that does not exist in the parent commit. Never use it to hide a real
 * failure: a gate that cannot read its input must say so, not report "clean".
 *
 * @param {string} cwd Directory to run in.
 * @param {string[]} args Git arguments.
 * @returns {string} Stdout, or an empty string when git failed.
 */
export function gitSafe(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return '';
  }
}

/**
 * Resolve the top level of the working tree containing `cwd`.
 *
 * @param {string} cwd Any directory inside a repository.
 * @returns {string} Absolute repository root.
 * @throws {GitError} When `cwd` is not inside a git repository.
 */
export function repoRoot(cwd) {
  return path.resolve(git(cwd, ['rev-parse', '--show-toplevel']));
}

/**
 * Whether a revision exists and is readable.
 *
 * @param {string} cwd Repository directory.
 * @param {string} rev Revision expression.
 * @returns {boolean} True when the revision resolves.
 */
export function revExists(cwd, rev) {
  try {
    git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Split NUL-delimited git output into records, dropping the trailing empty one.
 *
 * @param {string} output Raw stdout from a `-z` invocation.
 * @returns {string[]} Records in order.
 */
function splitNul(output) {
  return output.split('\0').filter((token) => token !== '');
}

/**
 * Parse `--name-status -z` output into change records.
 *
 * Rename and copy statuses arrive as three records (`R096`, old path, new path)
 * while every other status arrives as two. Getting this wrong shifts the whole
 * stream by one and produces a file list that is confidently wrong.
 *
 * @param {string} output Raw `-z` stdout.
 * @returns {Array<{path: string, status: string, oldPath: string|null}>} Changes.
 */
export function parseNameStatus(output) {
  const tokens = splitNul(output);
  const changes = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    const status = code[0];
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (newPath === undefined) break;
      changes.push({ path: newPath, status, oldPath });
      i += 2;
    } else {
      const filePath = tokens[i + 1];
      if (filePath === undefined) break;
      changes.push({ path: filePath, status, oldPath: null });
      i += 1;
    }
  }
  return changes;
}

/**
 * Parse `--numstat -z` output into per-file churn.
 *
 * Binary files report `-` for both counts; they are recorded with zero churn
 * and a `binary` flag rather than being dropped, so a commit that adds a 40 MB
 * asset still shows up in the file count.
 *
 * @param {string} output Raw `-z` stdout.
 * @returns {Map<string, {insertions: number, deletions: number, binary: boolean}>} Churn by path.
 */
export function parseNumstat(output) {
  const tokens = splitNul(output);
  const stats = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const record = tokens[i];
    const match = record.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!match) continue;
    const [, rawInsertions, rawDeletions, inlinePath] = match;
    let filePath = inlinePath;
    if (filePath === '') {
      // Rename form: the counts record ends after the second tab and the old
      // and new paths follow as two separate NUL-delimited records.
      filePath = tokens[i + 2] ?? tokens[i + 1] ?? '';
      i += 2;
    }
    if (filePath === '') continue;
    const binary = rawInsertions === '-' || rawDeletions === '-';
    stats.set(filePath, {
      insertions: binary ? 0 : Number(rawInsertions),
      deletions: binary ? 0 : Number(rawDeletions),
      binary,
    });
  }
  return stats;
}

/**
 * Parse a unified diff into the lines it adds, with real file line numbers.
 *
 * Works on `-U0` output, where the only line kinds are headers, hunk markers
 * and single-character-prefixed changes. Added lines are what almost every
 * gate cares about: a gate that scans whole files reports debt the author did
 * not create, and gets ignored for it.
 *
 * @param {string} diff Unified diff text.
 * @returns {Array<{file: string, line: number, text: string}>} Added lines in order.
 */
export function parseAddedLines(diff) {
  const added = [];
  let file = null;
  let lineNumber = 0;

  for (const raw of (diff ?? '').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('@@')) {
      const match = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      lineNumber = match ? Number(match[1]) - 1 : 0;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('---') || raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) {
      lineNumber += 1;
      added.push({ file, line: lineNumber, text: raw.slice(1) });
    }
  }

  return added;
}
