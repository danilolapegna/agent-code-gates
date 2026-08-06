/**
 * TODO_DENSITY: unannotated deferral markers introduced by this change.
 *
 * The failure this prevents is a comment being treated as work. An agent that
 * writes `// TODO: handle the empty case` has not handled the empty case, but
 * the file compiles, the tests pass, and the summary says the feature is done.
 * The marker is the only trace, and nothing reads it.
 *
 * The gate scans added lines only. Scanning whole files would surface debt the
 * author did not create, which is the fastest way to teach people to bypass a
 * check. An intentional deferral stays legal: annotate it, and the annotation
 * makes the deferral a decision someone can find, rather than a note nobody
 * will read.
 *
 * @module gates/todo-density
 */

import { isAnnotated, excerpt } from '../text.js';
import { commentPrefixesFor } from '../languages.js';
import { matchesAnyGlob } from '../glob.js';

/**
 * Build the detector for the configured deferral tokens.
 *
 * The token must sit at the start of a comment: `todoList.push(x)` is code and
 * must not fire, while `// todo: fix` must. Word boundaries handle the first
 * case, the comment prefix requirement handles prose in string literals.
 *
 * @param {string[]} tokens Marker words such as `TODO`.
 * @param {string[]} prefixes Comment prefixes valid for the file.
 * @returns {RegExp} Expression matching a comment-anchored marker.
 */
function markerPattern(tokens, prefixes) {
  const escapedPrefixes = [...prefixes, '/*', '*', '<!--']
    .map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const escapedTokens = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?:${escapedPrefixes})\\s*(?:@)?\\b(${escapedTokens})\\b`, 'i');
}

export default {
  id: 'TODO_DENSITY',
  title: 'Unannotated TODO/FIXME in new code',
  description: 'Deferral markers added by this change that carry no explicit annotation.',
  severity: 'error',

  defaults: {
    /** Markers treated as a deferral. */
    tokens: ['TODO', 'FIXME', 'HACK', 'XXX'],
    /** Inline annotation that converts a marker into a recorded decision. */
    annotation: 'SAFE-TODO',
    /** When false, markers added inside test files are ignored. */
    includeTests: true,
    /**
     * When true, only program source is scanned. Markdown checklists and issue
     * templates are full of these words by design, and flagging a planning
     * document is the fastest way to make a team stop reading the output.
     */
    sourceOnly: true,
    /** Extra paths never scanned, on top of the global ignore list. */
    exclude: [],
  },

  /**
   * Relevant whenever the change adds lines to a file that has comment syntax.
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
    const fileLines = new Map();
    const findings = [];

    for (const added of ctx.addedLines) {
      if (!options.includeTests && ctx.isTestPath(added.file)) continue;
      if (options.sourceOnly && !ctx.isSourcePath(added.file)) continue;
      if (matchesAnyGlob(added.file, options.exclude)) continue;

      const pattern = markerPattern(options.tokens, commentPrefixesFor(added.file));
      const match = added.text.match(pattern);
      if (!match) continue;

      if (!fileLines.has(added.file)) fileLines.set(added.file, ctx.readFile(added.file).split('\n'));
      const lines = fileLines.get(added.file);
      if (isAnnotated(lines, added.line - 1, options.annotation, added.file)) continue;

      findings.push({
        file: added.file,
        line: added.line,
        excerpt: excerpt(added.text),
        detail: `${match[1].toUpperCase()} marker with no ${options.annotation} annotation`,
      });
    }

    if (findings.length === 0) {
      return {
        status: 'pass',
        message: `no unannotated ${options.tokens.join('/')} added`,
        findings: [],
      };
    }

    return {
      status: 'fail',
      message:
        `${findings.length} deferral marker(s) added with no annotation. ` +
        `Either do the work now, or record the decision on the same line or the line above: ` +
        `\`${options.annotation}: <why it is deferred, and where it is tracked>\`.`,
      findings,
    };
  },
};
