/**
 * SKIPPED_TESTS: tests disabled by this change.
 *
 * "All tests pass" and "all tests ran" are different claims, and only the first
 * one gets reported. A `.skip` added in the same commit as the feature it was
 * supposed to cover produces a green suite that proves nothing, and the green
 * suite is what the summary quotes.
 *
 * Focused-test markers (`.only`) are treated the same way and for the same
 * reason: an `it.only` left in a file silently disables every other test in it,
 * which is a larger hole than a single skip.
 *
 * @module gates/skipped-tests
 */

import { isAnnotated, excerpt } from '../text.js';
import { isCommentLine } from '../languages.js';
import { matchesAnyGlob } from '../glob.js';

/**
 * Disable markers across common test frameworks.
 *
 * Each entry is anchored enough that it cannot match ordinary application
 * code: `.skip(` and `.only(` are effectively exclusive to test runners, and
 * the decorator and attribute forms are literal syntax.
 *
 * @type {Array<{label: string, pattern: RegExp}>}
 */
const MARKERS = [
  { label: 'skipped test', pattern: /\b(?:describe|it|test|context|suite|scenario|bench)\s*\.\s*skip\s*[(<`]/ },
  { label: 'skipped test', pattern: /\bx(?:it|describe|test|context)\s*\(/ },
  { label: 'placeholder test', pattern: /\b(?:test|it)\s*\.\s*todo\s*\(/ },
  { label: 'focused test', pattern: /\b(?:describe|it|test|context|suite)\s*\.\s*only\s*[(<`]/ },
  { label: 'focused test', pattern: /\bf(?:it|describe)\s*\(/ },
  { label: 'skipped test', pattern: /@pytest\s*\.\s*mark\s*\.\s*(?:skip|skipif|xfail)\b/ },
  { label: 'skipped test', pattern: /@unittest\s*\.\s*skip(?:If|Unless)?\s*\(/ },
  { label: 'skipped test', pattern: /\[\s*Ignore\s*[(\]]/ },
  { label: 'skipped test', pattern: /#\s*\[\s*ignore\s*\]/ },
  { label: 'skipped test', pattern: /\bt\s*\.\s*Skip(?:Now|f)?\s*\(/ },
  { label: 'skipped test', pattern: /\b(?:pending|xspecify)\s*\(\s*["'`]/ },
];

export default {
  id: 'SKIPPED_TESTS',
  title: 'Tests disabled in this change',
  description: 'Skip, todo and focus markers added to the test suite by this change.',
  severity: 'error',

  defaults: {
    /** Inline annotation recording a deliberate quarantine and where it is tracked. */
    annotation: 'SAFE-SKIP',
    /** When false, focused-test markers such as `.only` are not reported. */
    includeFocused: true,
    /**
     * When true, only program source is scanned, keeping documentation that
     * shows these markers as examples out of the results.
     */
    sourceOnly: true,
    /**
     * Extra paths never scanned. A project whose own test fixtures contain
     * these markers as data, rather than as disabled tests, belongs here.
     */
    exclude: [],
  },

  /**
   * Relevant whenever the change adds lines. Skip markers can appear in any
   * file, not only files this tool recognises as tests.
   *
   * @param {object} ctx Gate context.
   * @returns {boolean} True when there is anything to scan.
   */
  appliesTo(ctx) {
    return ctx.addedLines.length > 0;
  },

  /**
   * @param {object} ctx Gate context.
   * @returns {{status: string, message: string, findings: object[]}} Gate result.
   */
  run(ctx) {
    const options = ctx.config.gates[this.id];
    const markers = options.includeFocused
      ? MARKERS
      : MARKERS.filter((marker) => marker.label !== 'focused test');

    const fileLines = new Map();
    const findings = [];

    for (const added of ctx.addedLines) {
      if (options.sourceOnly && !ctx.isSourcePath(added.file)) continue;
      if (matchesAnyGlob(added.file, options.exclude)) continue;
      if (isCommentLine(added.text, added.file)) continue;
      const marker = markers.find((candidate) => candidate.pattern.test(added.text));
      if (!marker) continue;

      if (!fileLines.has(added.file)) fileLines.set(added.file, ctx.readFile(added.file).split('\n'));
      if (isAnnotated(fileLines.get(added.file), added.line - 1, options.annotation, added.file)) continue;

      findings.push({
        file: added.file,
        line: added.line,
        excerpt: excerpt(added.text),
        detail: marker.label,
      });
    }

    if (findings.length === 0) {
      return { status: 'pass', message: 'no tests disabled by this change', findings: [] };
    }

    return {
      status: 'fail',
      message:
        `${findings.length} test(s) disabled by this change. A suite that does not run the ` +
        `case is not evidence the case works. Re-enable them, delete them if they are obsolete, ` +
        `or annotate a deliberate quarantine with \`${options.annotation}: <reason and tracker>\`.`,
      findings,
    };
  },
};
