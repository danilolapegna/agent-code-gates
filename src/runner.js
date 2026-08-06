/**
 * Gate selection, execution and aggregation.
 *
 * The runner owns every decision a gate should not have to make: whether it is
 * enabled, whether the author asked to bypass it, whether the inputs it needs
 * exist, and what a failure means for the exit code. Gates stay small and
 * testable because all of that lives here.
 *
 * @module runner
 */

import { gateRegistry } from './gates/index.js';
import { SKIP_DIRECTIVE } from './context.js';

/** Shortest reason accepted alongside a skip directive. */
const MIN_SKIP_REASON = 4;

/**
 * Run gates against a context.
 *
 * Never throws for a gate-level problem. A gate that crashes is reported as an
 * `error` result and blocks the run: a check whose outcome is unknown must not
 * be counted as a pass, or the first bug in a gate silently disables it.
 *
 * @param {object} ctx Gate context from `buildContext`.
 * @param {object} [options] Execution options.
 * @param {string[]|null} [options.only=null] Run only these gate identifiers.
 * @param {boolean} [options.strict=false] Treat warnings as blocking.
 * @param {ReadonlyArray<object>} [options.gates] Gate definitions to run. Defaults
 *   to the built-in registry; pass your own array to add or replace gates.
 * @returns {Promise<object>} Aggregated run result.
 */
export async function runGates(ctx, { only = null, strict = false, gates = gateRegistry } = {}) {
  const startedAt = Date.now();
  const problems = validateDirectives(ctx, gates);
  const selected = selectGates(ctx, only, gates);
  const results = [];

  for (const gate of selected) {
    results.push(await runOne(gate, ctx));
  }

  const effectiveStrict = strict || ctx.config.strict === true;
  for (const result of results) {
    result.blocking = isBlocking(result, effectiveStrict);
  }

  const summary = summarise(results);
  summary.problems = problems.length;

  return {
    repo: ctx.root,
    mode: ctx.mode,
    ref: ctx.ref,
    strict: effectiveStrict,
    durationMs: Date.now() - startedAt,
    directives: ctx.skips,
    problems,
    gates: results,
    summary,
    ok: problems.length === 0 && results.every((result) => !result.blocking),
  };
}

/**
 * Choose which gates to run.
 *
 * An explicit `--gate` selection overrides the enabled flag, because a user who
 * names a gate on the command line is asking to see it, not asking to respect a
 * configuration file they are probably debugging.
 *
 * @param {object} ctx Gate context.
 * @param {string[]|null} only Requested gate identifiers.
 * @param {ReadonlyArray<object>} gates Available gate definitions.
 * @returns {object[]} Gates to execute, in registry order.
 */
function selectGates(ctx, only, gates) {
  if (Array.isArray(only) && only.length > 0) {
    return only.map((id) => gates.find((gate) => gate.id === id)).filter(Boolean);
  }
  return gates.filter((gate) => ctx.config.gates[gate.id]?.enabled !== false);
}

/**
 * Check the skip directives themselves.
 *
 * The escape hatch is meant to be usable once, visibly, with a reason. Every
 * rule here defends that shape: a nameless gate, a missing reason or a handful
 * of directives at once are each a way of turning the hatch back into a
 * blanket bypass.
 *
 * @param {object} ctx Gate context.
 * @param {ReadonlyArray<object>} gates Available gate definitions.
 * @returns {string[]} Run-level problems; empty when the directives are well formed.
 */
function validateDirectives(ctx, gates) {
  const problems = [];
  const named = new Set();

  for (const directive of ctx.skips) {
    if (!gates.some((gate) => gate.id === directive.gate)) {
      problems.push(`${SKIP_DIRECTIVE}: "${directive.gate}" is not a known gate (see --list)`);
      continue;
    }
    if (directive.reason.length < MIN_SKIP_REASON) {
      problems.push(`${SKIP_DIRECTIVE}: ${directive.gate} needs a reason, not just a gate name`);
      continue;
    }
    named.add(directive.gate);
  }

  if (named.size > 1) {
    problems.push(
      `${named.size} gates skipped in one commit (${[...named].join(', ')}). `
      + 'One is an exception; several is a bypass. Fix the gates or split the commit.',
    );
  }

  return problems;
}

/**
 * Execute a single gate and normalise its result.
 *
 * @param {object} gate Gate definition.
 * @param {object} ctx Gate context.
 * @returns {Promise<object>} Result record.
 */
async function runOne(gate, ctx) {
  // A gate the configuration has never heard of is a custom gate passed in by a
  // caller. Materialising its declared defaults here means custom gates read
  // their options exactly the way built-in ones do, with no special case.
  if (ctx.config.gates[gate.id] === undefined) {
    ctx.config.gates[gate.id] = { enabled: true, severity: gate.severity, ...structuredClone(gate.defaults ?? {}) };
  }
  const options = ctx.config.gates[gate.id];
  const base = {
    id: gate.id,
    title: gate.title,
    description: gate.description,
    severity: options.severity ?? gate.severity,
    status: 'skip',
    message: '',
    findings: [],
    durationMs: 0,
    skip: null,
    blocking: false,
  };

  const startedAt = Date.now();

  // The `enabled` flag is applied during selection, not here. Naming a gate on
  // the command line therefore runs it even when configuration has it switched
  // off, which is what someone debugging that configuration is asking for.
  if (gate.honorsSkipDirective !== false) {
    const directive = ctx.skipDirectiveFor(gate.id);
    if (directive && directive.reason.length >= MIN_SKIP_REASON) {
      return {
        ...base,
        message: `skipped by directive: ${directive.reason}`,
        skip: { kind: 'directive', reason: directive.reason },
      };
    }
  }

  if (gate.needsCommitMessage && !ctx.hasCommitMessage) {
    return {
      ...base,
      message: 'no commit message available at this point in the commit lifecycle',
      skip: {
        kind: 'no-commit-message',
        reason: 'run from the commit-msg hook, or pass --message-file, to enable this gate',
      },
    };
  }

  try {
    if (!gate.appliesTo(ctx)) {
      return {
        ...base,
        message: 'not applicable to this change',
        durationMs: Date.now() - startedAt,
        skip: { kind: 'not-applicable', reason: 'not applicable to this change' },
      };
    }

    const outcome = await gate.run(ctx);
    return {
      ...base,
      status: outcome.status,
      message: outcome.message ?? '',
      findings: outcome.findings ?? [],
      durationMs: Date.now() - startedAt,
      skip: outcome.status === 'skip' ? { kind: 'gate', reason: outcome.message ?? '' } : null,
    };
  } catch (error) {
    return {
      ...base,
      status: 'error',
      message: `gate threw: ${error?.message ?? String(error)}`,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Whether a result should stop the commit.
 *
 * @param {object} result Gate result.
 * @param {boolean} strict Whether warnings block.
 * @returns {boolean} True when the result blocks.
 */
function isBlocking(result, strict) {
  if (result.status === 'error') return true;
  if (result.status !== 'fail') return false;
  return result.severity === 'error' || strict;
}

/**
 * Count outcomes for the report and the exit code.
 *
 * @param {object[]} results Gate results.
 * @returns {object} Counts by outcome.
 */
function summarise(results) {
  const summary = {
    total: results.length,
    passed: 0,
    failed: 0,
    warned: 0,
    skipped: 0,
    errored: 0,
    findings: 0,
  };

  for (const result of results) {
    summary.findings += result.findings.length;
    if (result.status === 'pass') summary.passed += 1;
    else if (result.status === 'skip') summary.skipped += 1;
    else if (result.status === 'error') summary.errored += 1;
    else if (result.blocking) summary.failed += 1;
    else summary.warned += 1;
  }

  return summary;
}
