/**
 * DEBUG_RESIDUE: debugging statements left in changed production source.
 *
 * A `console.log` that reaches production is rarely a crash. It is a slow leak:
 * noise in the log pipeline, occasionally a customer identifier printed where
 * it should not be, and a signal that whoever wrote the code stopped at "it
 * worked when I ran it". Agents produce these constantly, because printing
 * state is how they observe their own work.
 *
 * Calibration note: the default rule set contains only statements that are
 * unambiguously debugging artifacts. `print()` in Python is included but
 * excluded on paths that are conventionally command-line entry points, where
 * printing is the program's purpose. Rules for languages whose print statement
 * is routinely legitimate output (Go, Java, Rust) ship disabled and can be
 * turned on per project.
 *
 * @module gates/debug-residue
 */

import { isAnnotated, excerpt } from '../text.js';
import { isCommentLine, extensionOf } from '../languages.js';
import { matchesAnyGlob } from '../glob.js';

/**
 * The rule set, keyed by the configuration flag that enables each rule.
 *
 * @type {Array<{key: string, label: string, pattern: RegExp, extensions: string[], excludeGlobs?: string[]}>}
 */
const RULES = [
  {
    key: 'console',
    label: 'console debug call',
    pattern: /\bconsole\s*\.\s*(?:log|debug|dir|trace|table)\s*\(/,
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte'],
  },
  {
    key: 'debugger',
    label: 'debugger statement',
    pattern: /(?:^|[\s;{}])debugger\s*(?:;|$)/,
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte'],
  },
  {
    key: 'pythonDebugger',
    label: 'python debugger hook',
    pattern: /\b(?:import\s+pdb\b|pdb\s*\.\s*set_trace\s*\(|breakpoint\s*\(\s*\))/,
    extensions: ['.py'],
  },
  {
    key: 'pythonPrint',
    label: 'print() call',
    pattern: /(?:^|[\s;=({[])print\s*\(/,
    extensions: ['.py'],
    excludeGlobs: [
      '**/bin/**', '**/scripts/**', '**/cli.py', '**/__main__.py',
      '**/manage.py', '**/setup.py', '**/conftest.py',
    ],
  },
  {
    key: 'phpDump',
    label: 'php dump call',
    pattern: /\b(?:var_dump|print_r|dd|dump)\s*\(/,
    extensions: ['.php'],
  },
  {
    key: 'goPrint',
    label: 'fmt.Print call',
    pattern: /\bfmt\s*\.\s*Print(?:ln|f)?\s*\(/,
    extensions: ['.go'],
  },
  {
    key: 'javaPrint',
    label: 'System.out print',
    pattern: /\bSystem\s*\.\s*(?:out|err)\s*\.\s*print(?:ln|f)?\s*\(/,
    extensions: ['.java', '.kt', '.kts'],
  },
  {
    key: 'rustPrint',
    label: 'println! macro',
    pattern: /\b(?:println|eprintln|dbg)\s*!\s*\(/,
    extensions: ['.rs'],
  },
];

export default {
  id: 'DEBUG_RESIDUE',
  title: 'Debug statements left in changed source',
  description: 'Print, log and breakpoint calls added to non-test source in this change.',
  severity: 'error',

  defaults: {
    /** Per-language rules. Enable the ones that are debug artifacts in your codebase. */
    rules: {
      console: true,
      debugger: true,
      pythonDebugger: true,
      pythonPrint: true,
      phpDump: true,
      goPrint: false,
      javaPrint: false,
      rustPrint: false,
    },
    /** Inline annotation that records a deliberate, kept statement. */
    annotation: 'SAFE-LOG',
    /** Extra paths never scanned by this gate, on top of the global ignore list. */
    exclude: [],
  },

  /**
   * Relevant when the change adds lines to non-test source files.
   *
   * @param {object} ctx Gate context.
   * @returns {boolean} True when at least one added line is production source.
   */
  appliesTo(ctx) {
    return ctx.addedLines.some((added) => ctx.isSourcePath(added.file) && !ctx.isTestPath(added.file));
  },

  /**
   * @param {object} ctx Gate context.
   * @returns {{status: string, message: string, findings: object[]}} Gate result.
   */
  run(ctx) {
    const options = ctx.config.gates[this.id];
    const active = RULES.filter((rule) => options.rules[rule.key]);
    const fileLines = new Map();
    const findings = [];

    for (const added of ctx.addedLines) {
      if (ctx.isTestPath(added.file)) continue;
      if (matchesAnyGlob(added.file, options.exclude)) continue;
      if (isCommentLine(added.text, added.file)) continue;

      const extension = extensionOf(added.file);
      const rule = active.find(
        (candidate) => candidate.extensions.includes(extension)
          && !matchesAnyGlob(added.file, candidate.excludeGlobs ?? [])
          && candidate.pattern.test(added.text),
      );
      if (!rule) continue;

      if (!fileLines.has(added.file)) fileLines.set(added.file, ctx.readFile(added.file).split('\n'));
      if (isAnnotated(fileLines.get(added.file), added.line - 1, options.annotation, added.file)) continue;

      findings.push({
        file: added.file,
        line: added.line,
        excerpt: excerpt(added.text),
        detail: rule.label,
      });
    }

    if (findings.length === 0) {
      return { status: 'pass', message: 'no debug statements added to production source', findings: [] };
    }

    return {
      status: 'fail',
      message:
        `${findings.length} debug statement(s) added to production source. ` +
        `Remove them, route them through your logger, or mark a deliberate one with ` +
        `\`${options.annotation}: <why this stays>\` on the line or the line above.`,
      findings,
    };
  },
};
