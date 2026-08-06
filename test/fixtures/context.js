/**
 * In-memory `GateContext` builder for gate unit tests.
 *
 * Gates are pure functions of a context, so testing them against a real
 * repository would add process spawns and temp directories without testing
 * anything a gate is responsible for. Context construction itself is covered
 * separately, against real git, in `test/context.test.js`.
 *
 * @module test/fixtures/context
 */

import { defaultConfig } from '../../src/config.js';
import { isSourceFile, isTestFile } from '../../src/languages.js';
import { parseSkipDirectives } from '../../src/context.js';

/**
 * Turn a file map into added-line records, as if every line were new.
 *
 * @param {Record<string, string>} files Path to content.
 * @param {string[]} paths Which files count as added.
 * @returns {Array<{file: string, line: number, text: string}>} Added lines.
 */
function addedLinesFrom(files, paths) {
  const added = [];
  for (const filePath of paths) {
    const content = files[filePath] ?? '';
    content.split('\n').forEach((text, index) => {
      added.push({ file: filePath, line: index + 1, text });
    });
  }
  return added;
}

/**
 * Build a context for a gate test.
 *
 * @param {object} [spec] Test fixture description.
 * @param {Record<string, string>} [spec.files] Content of files after the change.
 * @param {Record<string, string>} [spec.before] Content of files before the change.
 * @param {Array<object>} [spec.changed] Change records; defaults to every file as modified.
 * @param {string[]} [spec.addedFrom] Files whose whole content counts as added lines.
 * @param {Array<object>} [spec.addedLines] Explicit added lines, overriding `addedFrom`.
 * @param {string[]} [spec.repoFiles] Tracked files; defaults to the keys of `files`.
 * @param {string} [spec.message] Commit message.
 * @param {Array<{text: string, source: string}>} [spec.evidence] Extra evidence documents.
 * @param {Record<string, object>} [spec.gates] Per-gate option overrides.
 * @param {object} [spec.stats] Explicit change statistics.
 * @returns {object} A context object shaped like the real one.
 */
export function makeContext(spec = {}) {
  const files = spec.files ?? {};
  const before = spec.before ?? {};
  const paths = Object.keys(files);
  const addedFrom = spec.addedFrom ?? paths;

  // Mirrors the one-level merge the real config loader performs, so a fixture
  // that overrides a single nested rule does not silently blank its siblings.
  const config = defaultConfig();
  for (const [gateId, options] of Object.entries(spec.gates ?? {})) {
    const merged = { ...config.gates[gateId] };
    for (const [key, value] of Object.entries(options)) {
      merged[key] = value !== null && typeof value === 'object' && !Array.isArray(value)
        ? { ...merged[key], ...value }
        : value;
    }
    config.gates[gateId] = merged;
  }

  const changedFiles = (spec.changed ?? paths.map((path) => ({ path, status: 'M' }))).map((change) => ({
    oldPath: null,
    insertions: (files[change.path] ?? '').split('\n').length,
    deletions: 0,
    binary: false,
    ...change,
  }));

  const message = spec.message ?? '';
  const stats = spec.stats ?? {
    files: changedFiles.length,
    insertions: changedFiles.reduce((sum, file) => sum + file.insertions, 0),
    deletions: changedFiles.reduce((sum, file) => sum + file.deletions, 0),
  };
  stats.linesChanged = stats.insertions + stats.deletions;

  return {
    root: spec.root ?? '/repo',
    mode: 'staged',
    ref: 'staged',
    config,

    commitMessage: message,
    commitSubject: message.split('\n')[0] ?? '',
    commitBody: message.split('\n').slice(1).join('\n').trim(),
    hasCommitMessage: message.trim() !== '',

    changedFiles,
    diff: '',
    addedLines: spec.addedLines ?? addedLinesFrom(files, addedFrom),
    stats,
    skips: parseSkipDirectives(message),

    isIgnored: () => false,
    isTestPath: isTestFile,
    isSourcePath: isSourceFile,

    skipDirectiveFor(gateId) {
      return this.skips.find((skip) => skip.gate === gateId);
    },
    readFile(filePath) {
      return files[filePath] ?? '';
    },
    readTracked(filePath) {
      return files[filePath] ?? '';
    },
    readFileBefore(filePath) {
      return before[filePath] ?? '';
    },
    listRepoFiles() {
      return spec.repoFiles ?? paths;
    },
    evidenceDocuments() {
      return [{ text: message, source: 'commit message' }, ...(spec.evidence ?? [])];
    },
  };
}

/**
 * Run one gate against a fixture and return its result, or the reason it did
 * not run.
 *
 * Mirrors the runner's `appliesTo` check so a test cannot accidentally assert
 * on a gate that the real runner would never have invoked.
 *
 * @param {object} gate Gate definition.
 * @param {object} spec Fixture description passed to `makeContext`.
 * @returns {Promise<{status: string, message: string, findings: object[]}>} Result.
 */
export async function runGate(gate, spec) {
  const ctx = makeContext(spec);
  if (!gate.appliesTo(ctx)) {
    return { status: 'skip', message: 'not applicable to this change', findings: [] };
  }
  return gate.run(ctx);
}
