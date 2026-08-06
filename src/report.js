/**
 * Rendering of run results, and the exit code contract.
 *
 * A gate report is read in three places with different constraints: a terminal
 * during a commit, a CI log after the fact, and a machine consuming JSON. The
 * terminal case is the one that decides whether the tool survives, so the
 * human renderer optimises for a single question: what do I do now. Every
 * failure prints the offending locations and the exact remediation, because a
 * report that says "failed" and stops is a report people learn to bypass.
 *
 * @module report
 */

/** Terminal width used for wrapping when the real width is unknown. */
const FALLBACK_WIDTH = 96;

/** Column at which gate messages start, keeping status and id aligned. */
const MESSAGE_COLUMN = 30;

/** ANSI codes, applied only when the output is a colour-capable terminal. */
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  grey: '\u001b[90m',
};

/**
 * Whether colour should be used for a given stream.
 *
 * Honours `NO_COLOR`, the de facto standard, before anything else.
 *
 * @param {NodeJS.WriteStream} stream Output stream.
 * @param {boolean|null} [override=null] Explicit user preference.
 * @returns {boolean} True when ANSI codes should be emitted.
 */
export function shouldUseColor(stream, override = null) {
  if (override !== null) return override;
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return Boolean(stream?.isTTY);
}

/**
 * Build a paint function that either applies ANSI codes or passes text through.
 *
 * @param {boolean} enabled Whether colour is active.
 * @returns {(text: string, ...styles: string[]) => string} Painter.
 */
function painter(enabled) {
  return (text, ...styles) => {
    if (!enabled || styles.length === 0) return text;
    return `${styles.map((style) => ANSI[style] ?? '').join('')}${text}${ANSI.reset}`;
  };
}

/**
 * Wrap text to a width, indenting every line after the first.
 *
 * @param {string} text Text to wrap; existing newlines are preserved as breaks.
 * @param {number} width Maximum line length.
 * @param {string} indent Prefix for every emitted line.
 * @returns {string[]} Wrapped lines, each already indented.
 */
function wrap(text, width, indent) {
  const limit = Math.max(20, width - indent.length);
  const lines = [];

  for (const paragraph of String(text).split('\n')) {
    if (paragraph.trim() === '') {
      lines.push(indent.trimEnd());
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (current === '') current = word;
      else if (`${current} ${word}`.length <= limit) current += ` ${word}`;
      else {
        lines.push(indent + current);
        current = word;
      }
    }
    if (current !== '') lines.push(indent + current);
  }

  return lines;
}

/** Presentation for each outcome. */
const OUTCOME = {
  pass: { label: 'PASS', styles: ['green'] },
  fail: { label: 'FAIL', styles: ['red', 'bold'] },
  warn: { label: 'WARN', styles: ['yellow'] },
  skip: { label: 'SKIP', styles: ['grey'] },
  error: { label: 'ERR!', styles: ['red', 'bold'] },
};

/**
 * Classify a result for display.
 *
 * A failing gate configured as a warning prints as WARN, so the label always
 * matches the consequence. Showing FAIL next to something that did not stop the
 * commit teaches people to ignore the word.
 *
 * @param {object} result Gate result.
 * @returns {string} Outcome key.
 */
function outcomeOf(result) {
  if (result.status === 'fail') return result.blocking ? 'fail' : 'warn';
  return result.status;
}

/**
 * Render the full human-readable report.
 *
 * @param {object} run Aggregated run result.
 * @param {object} [options] Rendering options.
 * @param {boolean} [options.color=false] Whether to emit ANSI codes.
 * @param {number} [options.width] Terminal width.
 * @param {boolean} [options.verbose=false] Show messages for passing gates too.
 * @returns {string} Report text without a trailing newline.
 */
export function renderHuman(run, { color = false, width = FALLBACK_WIDTH, verbose = false } = {}) {
  const paint = painter(color);
  const out = [];
  const indent = ' '.repeat(MESSAGE_COLUMN);

  out.push('');
  out.push(
    `${paint('agent-code-gates', 'bold')} ${paint(`${run.mode}${run.mode === 'commit' ? ` ${run.ref}` : ''}`, 'grey')}`
    + ` ${paint(`${run.summary.total} gate(s)`, 'grey')}`,
  );
  out.push('');

  for (const result of run.gates) {
    const outcome = OUTCOME[outcomeOf(result)];
    const head = `  ${paint(outcome.label, ...outcome.styles)}  ${result.id.padEnd(MESSAGE_COLUMN - 8)}`;
    const isNoise = result.status === 'pass' || result.status === 'skip';

    if (isNoise && !verbose) {
      out.push(`${head}${paint(result.message, 'grey')}`);
      continue;
    }
    if (isNoise) {
      out.push(`${head}${result.message}`);
      continue;
    }

    const [first, ...rest] = wrap(result.message, width, indent);
    out.push(`${head}${(first ?? '').trimStart()}`);
    out.push(...rest);

    for (const finding of result.findings) {
      const location = finding.file
        ? `${finding.file}${finding.line ? `:${finding.line}` : ''}`
        : '(this commit)';
      const detail = finding.detail ? paint(`  (${finding.detail})`, 'grey') : '';
      out.push(`${indent}${paint(location, 'blue')}  ${finding.excerpt ?? ''}${detail}`);
    }
    out.push('');
  }

  if (run.directives.length > 0) {
    out.push('');
    for (const directive of run.directives) {
      out.push(`  ${paint('SKIPPED BY DIRECTIVE', 'yellow', 'bold')}  ${directive.gate}: ${directive.reason || '(no reason given)'}`);
    }
  }

  if (run.problems.length > 0) {
    out.push('');
    for (const problem of run.problems) {
      out.push(...wrap(problem, width, '  ').map((line, index) => (index === 0 ? `  ${paint('PROBLEM', 'red', 'bold')}  ${line.trimStart()}` : `           ${line.trimStart()}`)));
    }
  }

  out.push('');
  out.push(`  ${paint(countsLine(run), 'grey')}`);
  out.push(run.ok
    ? `  ${paint('PASSED', 'green', 'bold')}  nothing is blocking this commit.`
    : `  ${paint('BLOCKED', 'red', 'bold')}  fix the failures above, or record a single exception in the commit body:\n`
      + `           agent-code-gates-skip: <GATE_ID> <why this one, this time>`);
  out.push('');

  return out.join('\n');
}

/**
 * Compose the one-line tally.
 *
 * @param {object} run Aggregated run result.
 * @returns {string} Human-readable counts.
 */
function countsLine(run) {
  const { summary } = run;
  const parts = [
    `${summary.passed} passed`,
    summary.failed > 0 ? `${summary.failed} blocking` : null,
    summary.warned > 0 ? `${summary.warned} warning` : null,
    summary.errored > 0 ? `${summary.errored} gate error` : null,
    summary.skipped > 0 ? `${summary.skipped} skipped` : null,
  ].filter(Boolean);
  return `${parts.join(', ')} in ${(run.durationMs / 1000).toFixed(2)}s`;
}

/**
 * Render the run as JSON for machine consumers.
 *
 * The shape is stable within a major version: `ok` and `summary` are what a CI
 * step should branch on, and `gates[].findings` is what a review bot should
 * turn into inline comments.
 *
 * @param {object} run Aggregated run result.
 * @returns {string} Pretty-printed JSON.
 */
export function renderJson(run) {
  return JSON.stringify(
    {
      tool: 'agent-code-gates',
      ok: run.ok,
      mode: run.mode,
      ref: run.ref,
      strict: run.strict,
      durationMs: run.durationMs,
      summary: run.summary,
      problems: run.problems,
      directives: run.directives.map(({ gate, reason }) => ({ gate, reason })),
      gates: run.gates.map((result) => ({
        id: result.id,
        title: result.title,
        status: result.status,
        outcome: outcomeOf(result),
        severity: result.severity,
        blocking: result.blocking,
        message: result.message,
        durationMs: result.durationMs,
        skip: result.skip,
        findings: result.findings,
      })),
    },
    null,
    2,
  );
}

/**
 * Render the gate catalogue for `--list`.
 *
 * @param {ReadonlyArray<object>} gates Gate definitions.
 * @param {object} [options] Rendering options.
 * @param {boolean} [options.color=false] Whether to emit ANSI codes.
 * @param {object|null} [options.config=null] Resolved config, to show effective settings.
 * @returns {string} Catalogue text.
 */
export function renderList(gates, { color = false, config = null } = {}) {
  const paint = painter(color);
  const out = ['', `${paint('agent-code-gates', 'bold')} ${paint(`${gates.length} gates`, 'grey')}`, ''];

  for (const gate of gates) {
    const settings = config?.gates?.[gate.id];
    const severity = settings?.severity ?? gate.severity;
    const enabled = settings?.enabled !== false;
    const badge = enabled
      ? paint(severity === 'error' ? 'error  ' : 'warning', severity === 'error' ? 'red' : 'yellow')
      : paint('off    ', 'grey');

    out.push(`  ${badge}  ${paint(gate.id, 'bold')}`);
    out.push(`           ${gate.description}`);
    out.push('');
  }

  out.push(paint('  Configure any of these in .agentgatesrc.json under "gates".', 'grey'));
  out.push('');
  return out.join('\n');
}

/**
 * The process exit code for a completed run.
 *
 * @param {object} run Aggregated run result.
 * @returns {number} 0 when nothing blocks, 1 when something does.
 */
export function exitCodeFor(run) {
  return run.ok ? 0 : 1;
}
