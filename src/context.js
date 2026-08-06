/**
 * Construction of the `GateContext`: the single, immutable snapshot every gate
 * reads from.
 *
 * Gates never shell out to git themselves. Collecting the change set once and
 * handing it to every gate keeps a run fast, keeps gate code free of process
 * management, and guarantees that two gates cannot disagree about what changed
 * because one of them asked git a subtly different question.
 *
 * @module context
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  git,
  gitSafe,
  parseAddedLines,
  parseNameStatus,
  parseNumstat,
  repoRoot as resolveRepoRoot,
  revExists,
} from './git.js';
import { effectiveIgnore } from './config.js';
import { matchesAnyGlob } from './glob.js';
import { isSourceFile, isTestFile } from './languages.js';

/** Marker an author writes in a commit body to bypass exactly one gate. */
export const SKIP_DIRECTIVE = 'agent-code-gates-skip';

/** Shortest reason accepted with a skip directive. "x" is not a reason. */
const MIN_SKIP_REASON = 4;

/**
 * Read a commit message from a file, dropping git's comment lines.
 *
 * This is the path used by the `commit-msg` hook, where git passes the message
 * file as the first argument. It is the only point in the commit lifecycle at
 * which the real message and the final staged tree are both available.
 *
 * @param {string} file Path to the message file.
 * @returns {string} Message text with comment lines removed.
 */
function readMessageFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim();
}

/**
 * Parse skip directives out of a commit message.
 *
 * @param {string} message Full commit message.
 * @returns {Array<{gate: string, reason: string, raw: string}>} Directives in order.
 */
export function parseSkipDirectives(message) {
  const pattern = new RegExp(
    `^[\\s>]*(?:[-*+]\\s*)?${SKIP_DIRECTIVE}\\s*:\\s*([A-Z][A-Z0-9_]*)\\s*[-:]?\\s*(.*)$`,
    'gim',
  );
  const directives = [];
  for (const match of (message ?? '').matchAll(pattern)) {
    directives.push({ gate: match[1], reason: match[2].trim(), raw: match[0].trim() });
  }
  return directives;
}

/**
 * Git argument sets for the two evaluation modes.
 *
 * Staged mode compares the index against `HEAD`, which is what a hook must
 * judge. Commit mode reads a finished commit, which is what CI and a manual
 * audit need. `--root` on the commit form matters: without it the very first
 * commit in a repository has no parent to diff against and every query returns
 * an error that would read as "nothing changed".
 *
 * @param {'staged'|'commit'} mode Evaluation mode.
 * @param {string} ref Revision, used in commit mode.
 * @returns {{nameStatus: string[], numstat: string[], diff: string[]}} Argument sets.
 */
function diffArgs(mode, ref) {
  if (mode === 'staged') {
    return {
      nameStatus: ['diff', '--cached', '--name-status', '-M', '-z'],
      numstat: ['diff', '--cached', '--numstat', '-M', '-z'],
      diff: ['diff', '--cached', '-U0', '-M'],
    };
  }
  return {
    nameStatus: ['show', '--format=', '--name-status', '-M', '-z', ref],
    numstat: ['show', '--format=', '--numstat', '-M', '-z', ref],
    diff: ['show', '--format=', '-U0', '-M', ref],
  };
}

/**
 * Build the context every gate will read.
 *
 * @param {object} options Construction options.
 * @param {string} options.cwd Any directory inside the repository.
 * @param {'staged'|'commit'} [options.mode='staged'] What to evaluate.
 * @param {string} [options.ref='HEAD'] Revision to evaluate in commit mode.
 * @param {string|null} [options.messageFile=null] File holding the commit message.
 * @param {object} options.config Resolved configuration.
 * @returns {object} A frozen-in-spirit context object shared by all gates.
 * @throws {Error} When `cwd` is not a repository or `ref` does not resolve.
 */
export function buildContext({ cwd, mode = 'staged', ref = 'HEAD', messageFile = null, config }) {
  const root = resolveRepoRoot(cwd);

  if (mode === 'commit' && !revExists(root, ref)) {
    throw new Error(`revision "${ref}" does not resolve in ${root}`);
  }

  const args = diffArgs(mode, ref);
  const changes = parseNameStatus(gitSafe(root, args.nameStatus));
  const churn = parseNumstat(gitSafe(root, args.numstat));
  const diff = gitSafe(root, args.diff);

  const ignore = effectiveIgnore(config);
  const isIgnored = (filePath) => matchesAnyGlob(filePath, ignore);

  const changedFiles = changes
    .filter((change) => !isIgnored(change.path))
    .map((change) => ({
      ...change,
      insertions: churn.get(change.path)?.insertions ?? 0,
      deletions: churn.get(change.path)?.deletions ?? 0,
      binary: churn.get(change.path)?.binary ?? false,
    }));

  const addedLines = parseAddedLines(diff).filter((entry) => !isIgnored(entry.file));

  const commitMessage = resolveCommitMessage({ root, mode, ref, messageFile });
  const [subject, ...bodyLines] = commitMessage.split('\n');

  const stats = {
    files: changedFiles.length,
    insertions: changedFiles.reduce((sum, file) => sum + file.insertions, 0),
    deletions: changedFiles.reduce((sum, file) => sum + file.deletions, 0),
  };
  stats.linesChanged = stats.insertions + stats.deletions;

  /** Revision to read surviving file contents from. */
  const contentRev = mode === 'staged' ? '' : ref;
  /** Revision holding the state before this change. */
  const baseRev = mode === 'staged' ? 'HEAD' : `${ref}^`;

  return {
    root,
    mode,
    ref: mode === 'commit' ? gitSafe(root, ['rev-parse', '--short', ref]) || ref : 'staged',
    config,

    commitMessage,
    commitSubject: subject ?? '',
    commitBody: bodyLines.join('\n').trim(),
    hasCommitMessage: commitMessage.trim().length > 0,

    changedFiles,
    diff,
    addedLines,
    stats,
    skips: parseSkipDirectives(commitMessage),

    /**
     * Whether a path is excluded from scanning by configuration.
     *
     * @param {string} filePath Repo-relative path.
     * @returns {boolean} True when the path must not be inspected.
     */
    isIgnored,

    /**
     * Whether a path looks like test code.
     *
     * @param {string} filePath Repo-relative path.
     * @returns {boolean} True for tests, specs and fixtures.
     */
    isTestPath: isTestFile,

    /**
     * Whether a path holds program source.
     *
     * @param {string} filePath Repo-relative path.
     * @returns {boolean} True for recognised source extensions.
     */
    isSourcePath: isSourceFile,

    /**
     * The skip directive targeting a gate, when the author wrote one.
     *
     * @param {string} gateId Gate identifier.
     * @returns {{gate: string, reason: string, raw: string}|undefined} The directive.
     */
    skipDirectiveFor(gateId) {
      return this.skips.find((skip) => skip.gate === gateId);
    },

    /**
     * Content of a file as it exists in the change being evaluated.
     *
     * In staged mode this reads the index rather than the working tree, so a
     * gate judges what is about to be committed and not whatever the author
     * happens to have unsaved in an editor.
     *
     * @param {string} filePath Repo-relative path.
     * @returns {string} File content, or an empty string when unreadable.
     */
    readFile(filePath) {
      return gitSafe(root, ['show', `${contentRev}:${filePath}`]);
    },

    /**
     * Content of a file as it existed before this change.
     *
     * The only way to learn what a deleted file used to export.
     *
     * @param {string} filePath Repo-relative path.
     * @returns {string} Previous content, or an empty string when there was none.
     */
    readFileBefore(filePath) {
      return gitSafe(root, ['show', `${baseRev}:${filePath}`]);
    },

    /**
     * Content of any tracked file, cached, for gates that scan the repository.
     *
     * Reference-searching gates read hundreds of files. Spawning git once per
     * file makes a hook slow enough that people uninstall it, so unchanged
     * files are read straight off disk. Files this change touches still go
     * through git, because for those the working tree and the thing being
     * committed are not guaranteed to agree.
     *
     * @param {string} filePath Repo-relative path.
     * @returns {string} File content, or an empty string when unreadable.
     */
    readTracked(filePath) {
      const cached = this._contentCache.get(filePath);
      if (cached !== undefined) return cached;

      const touched = this._touchedPaths ??= new Set(changedFiles.map((file) => file.path));
      let content = '';
      if (mode === 'staged' && !touched.has(filePath)) {
        try {
          content = fs.readFileSync(path.join(root, filePath), 'utf8');
        } catch {
          content = this.readFile(filePath);
        }
      } else {
        content = this.readFile(filePath);
      }

      this._contentCache.set(filePath, content);
      return content;
    },

    /**
     * Every tracked file that survives this change, minus ignored paths.
     *
     * Cached on first use because the reference-search gates call it once per
     * deleted symbol and the file list cannot change mid-run.
     *
     * @returns {string[]} Repo-relative paths.
     */
    listRepoFiles() {
      if (!this._repoFiles) {
        const listing = contentRev === ''
          ? gitSafe(root, ['ls-files', '-z'])
          : gitSafe(root, ['ls-tree', '-r', '--name-only', '-z', contentRev]);
        this._repoFiles = listing.split('\0').filter((entry) => entry !== '' && !isIgnored(entry));
      }
      return this._repoFiles;
    },

    /**
     * Texts a gate may search for an evidence block: the commit message first,
     * then any markdown file in the configured evidence directories.
     *
     * Supporting both keeps short commit messages viable for teams that prefer
     * them, without weakening what the evidence has to contain.
     *
     * @returns {Array<{text: string, source: string}>} Searchable documents.
     */
    evidenceDocuments() {
      if (!this._evidence) {
        const documents = [{ text: commitMessage, source: 'commit message' }];
        for (const dir of config.evidenceDirs ?? []) {
          const absolute = path.join(root, dir);
          let entries = [];
          try {
            entries = fs.readdirSync(absolute).filter((name) => name.endsWith('.md'));
          } catch {
            continue;
          }
          for (const name of entries) {
            try {
              documents.push({
                text: fs.readFileSync(path.join(absolute, name), 'utf8'),
                source: `${dir}/${name}`,
              });
            } catch {
              // An unreadable evidence file is reported by the gate that needed
              // it, as missing evidence. Failing the whole run here would turn
              // a permissions problem into an unexplained crash.
            }
          }
        }
        this._evidence = documents;
      }
      return this._evidence;
    },

    /** Internal caches; not part of the documented gate contract. */
    _repoFiles: null,
    _evidence: null,
    _touchedPaths: null,
    _contentCache: new Map(),
  };
}

/**
 * Determine the commit message for this run.
 *
 * `.git/COMMIT_EDITMSG` is deliberately not consulted. During a `pre-commit`
 * hook that file still holds the *previous* commit's message, so reading it
 * makes body-dependent gates judge the wrong text while looking like they
 * worked. When no message is available the context reports that honestly and
 * the runner skips the gates that need one.
 *
 * @param {object} options Lookup options.
 * @param {string} options.root Repository root.
 * @param {'staged'|'commit'} options.mode Evaluation mode.
 * @param {string} options.ref Revision in commit mode.
 * @param {string|null} options.messageFile Explicit message file.
 * @returns {string} The message, or an empty string when unavailable.
 */
function resolveCommitMessage({ root, mode, ref, messageFile }) {
  if (messageFile) {
    try {
      return readMessageFile(messageFile);
    } catch (error) {
      throw new Error(`cannot read commit message file "${messageFile}": ${error.message}`);
    }
  }
  if (mode === 'commit') return git(root, ['log', '-1', '--format=%B', ref]).trim();
  return '';
}
