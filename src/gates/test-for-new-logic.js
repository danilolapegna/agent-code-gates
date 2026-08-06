/**
 * TEST_FOR_NEW_LOGIC: a new module with branches and no test anywhere.
 *
 * Agents write tests enthusiastically when asked and almost never when not.
 * The result is a codebase where the suite is green, the coverage number looks
 * respectable because the old code is well covered, and the module added this
 * week has never been executed by anything except the author's happy path.
 *
 * The gate fires only on *new* files that contain *branching* logic. A new
 * constants file, a barrel re-export or a type declaration has nothing to
 * test, and reporting those would be exactly the kind of noise that gets a
 * check disabled. It ships as a warning: an untested new module is a smell,
 * and smells belong in the report, not in the way.
 *
 * @module gates/test-for-new-logic
 */

import path from 'node:path';
import { excerpt } from '../text.js';
import { isCommentLine, extensionOf } from '../languages.js';
import { matchesAnyGlob } from '../glob.js';

/** Keywords that indicate a decision the code can get wrong. */
const BRANCH_KEYWORDS = /\b(?:if|elif|else|for|while|switch|case|catch|except|guard|unless|match)\b/;

/** Signals that a file exposes something a test could call. */
const EXPORT_SIGNALS = [
  /^\s*export\s+/m,
  /\bmodule\.exports\b/,
  /^\s*(?:public|internal|open)\s+(?:class|fun|func|struct|interface)\b/m,
  /^\s*(?:pub\s+)?fn\s+\w+/m,
  /^\s*func\s+[A-Z]\w*/m,
  /^\s*(?:async\s+)?def\s+\w+/m,
  /^\s*class\s+\w+/m,
  /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/m,
];

/**
 * Candidate test filenames for a source file, across common ecosystems.
 *
 * @param {string} filePath Repo-relative path of the new source file.
 * @returns {string[]} Basenames that would conventionally hold its tests.
 */
function siblingTestNames(filePath) {
  const extension = extensionOf(filePath);
  const stem = path.basename(filePath, extension);
  return [
    `${stem}.test${extension}`,
    `${stem}.spec${extension}`,
    `test_${stem}${extension}`,
    `${stem}_test${extension}`,
    `${stem}_spec${extension}`,
    `${stem}Test${extension}`,
    `${stem}Tests${extension}`,
  ];
}

/**
 * Whether a file carries enough logic that a test would say something.
 *
 * @param {string} source File content.
 * @param {number} minBranches Branch keywords required.
 * @returns {boolean} True when the file has real behaviour.
 */
function hasRealLogic(source, minBranches) {
  const lines = source.split('\n').filter((line) => line.trim() !== '');
  const codeLines = lines.filter((line) => !isCommentLine(line, 'x.js') && !isCommentLine(line, 'x.py'));
  const branches = codeLines.filter((line) => BRANCH_KEYWORDS.test(line)).length;
  const exported = EXPORT_SIGNALS.some((signal) => signal.test(source));
  return branches >= minBranches && exported;
}

export default {
  id: 'TEST_FOR_NEW_LOGIC',
  title: 'New logic module with no test',
  description: 'A new source file with branching logic that no test in the repository exercises.',
  severity: 'warning',

  defaults: {
    /** Branch keywords a new file needs before a test is expected of it. */
    minBranches: 2,
    /** Comment marker that records a deliberate, accepted gap. */
    annotation: 'test-debt-ack',
    /** Paths never expected to carry tests, on top of the global ignore list. */
    exclude: ['**/*.d.ts', '**/migrations/**', '**/generated/**', '**/*.gen.*'],
  },

  /**
   * Relevant when the change adds new non-test source files.
   *
   * @param {object} ctx Gate context.
   * @returns {boolean} True when there is at least one new source file.
   */
  appliesTo(ctx) {
    return ctx.changedFiles.some(
      (file) => file.status === 'A' && ctx.isSourcePath(file.path) && !ctx.isTestPath(file.path),
    );
  },

  /**
   * @param {object} ctx Gate context.
   * @returns {{status: string, message: string, findings: object[]}} Gate result.
   */
  run(ctx) {
    const options = ctx.config.gates[this.id];

    const newModules = ctx.changedFiles.filter(
      (file) => file.status === 'A'
        && ctx.isSourcePath(file.path)
        && !ctx.isTestPath(file.path)
        && !matchesAnyGlob(file.path, options.exclude),
    );

    const testFiles = ctx.listRepoFiles().filter((file) => ctx.isTestPath(file));
    const testBasenames = new Set(testFiles.map((file) => path.basename(file)));

    const findings = [];
    let examined = 0;

    for (const module of newModules) {
      const source = ctx.readFile(module.path);
      if (source.includes(`${options.annotation}:`)) continue;
      if (!hasRealLogic(source, options.minBranches)) continue;
      examined += 1;

      const hasSibling = siblingTestNames(module.path).some((name) => testBasenames.has(name));
      if (hasSibling) continue;

      const stem = path.basename(module.path, extensionOf(module.path));
      const referencePattern = new RegExp(
        `['"\`][^'"\`]*\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.[a-z]+)?['"\`]|\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      );
      const referenced = testFiles.some((file) => referencePattern.test(ctx.readTracked(file)));
      if (referenced) continue;

      findings.push({
        file: module.path,
        line: null,
        excerpt: excerpt(`+${module.insertions} lines, no test file references it`),
        detail: 'new branching logic with no test',
      });
    }

    if (findings.length === 0) {
      return {
        status: 'pass',
        message: examined === 0
          ? 'no new modules with branching logic'
          : `${examined} new logic module(s), all covered by a test`,
        findings: [],
      };
    }

    return {
      status: 'fail',
      message:
        `${findings.length} new module(s) with branching logic and no test. ` +
        `Add a test next to the module, or record the gap in the file with ` +
        `\`${options.annotation}: <why, and what would catch a regression instead>\`.`,
      findings,
    };
  },
};
