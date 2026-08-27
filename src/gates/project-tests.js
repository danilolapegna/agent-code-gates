/**
 * PROJECT_TESTS: the project's own suite, actually run.
 *
 * Every other gate here is a cheap structural check. None of them replaces the
 * tests the team already wrote, so this gate runs them and refuses one specific
 * excuse.
 *
 * The excuse is this: "the test runner would not start, so the tests were
 * skipped." That sentence describes an environment that is broken, and an
 * environment that is broken is a bug with a fix, usually a one-line one. It is
 * never a property of the change being committed. Left unchallenged it becomes
 * the default: the suite stops running, stays green in everyone's memory, and
 * nobody notices for weeks.
 *
 * So the skip directive is honoured for reasons of *scope* ("documentation
 * only", "no executable code here") and rejected for reasons of *environment*
 * ("cannot boot", "module not found", "runner missing"). This is the one gate
 * that inspects its own skip directive instead of letting the runner apply it.
 *
 * @module gates/project-tests
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * The environment the suite deserves: the caller's, minus git's hook handoff.
 *
 * When this gate runs from a pre-commit hook, git exports GIT_DIR, GIT_INDEX_FILE,
 * GIT_WORK_TREE and GIT_PREFIX. A suite that shells out to git — `git init` in a
 * fixture, a temp repo per case — then has every one of those calls silently
 * redirected at the repository being committed to, and fails for a reason that has
 * nothing to do with the change under test. The suite must start where a developer
 * starts it: from a terminal, with no repository already chosen for it.
 */
function gitFreeEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

/** Skip reasons that describe a broken environment rather than an irrelevant suite. */
const ENVIRONMENT_EXCUSE = /\b(?:can(?:no|')?t\s+(?:boot|run|start)|could\s?n[o']t\s+(?:boot|run|start)|did\s?n[o']t\s+(?:boot|run|start)|won[o']?t\s+(?:boot|run|start)|fail(?:s|ed)?\s+to\s+(?:boot|run|start)|module\s+not\s+found|not\s+installed|command\s+not\s+found|no\s+(?:runner|binary|interpreter)|runner\s+(?:missing|broken|unavailable)|native\s+module|environment\s+(?:issue|problem|broken)|missing\s+dependenc)/i;

/** Runner output that indicates the process never got as far as running tests. */
const BOOT_FAILURE = /\b(?:Cannot find module|ERR_MODULE_NOT_FOUND|command not found|No such file or directory|ModuleNotFoundError|ImportError|is not recognized as an internal)\b/i;

/** npm's placeholder script, which is not a test command. */
const NPM_PLACEHOLDER = /no test specified/i;

export default {
  id: 'PROJECT_TESTS',
  title: "The project's own test suite",
  description: "Runs the project's configured test command and rejects environment-shaped excuses for skipping it.",
  severity: 'error',
  honorsSkipDirective: false,

  defaults: {
    /** Command to run. When null, the `test` script in package.json is used. */
    command: null,
    /** Milliseconds before the run is abandoned. */
    timeoutMs: 300000,
    /** Lines of failing output included in the report. */
    outputLines: 25,
  },

  /**
   * Relevant when a test command can be determined.
   *
   * @param {object} ctx Gate context.
   * @returns {boolean} True when there is something to run.
   */
  appliesTo(ctx) {
    return resolveCommand(ctx) !== null;
  },

  /**
   * @param {object} ctx Gate context.
   * @returns {{status: string, message: string, findings: object[]}} Gate result.
   */
  run(ctx) {
    const options = ctx.config.gates[this.id];
    const directive = ctx.skipDirectiveFor(this.id);

    if (directive) {
      if (ENVIRONMENT_EXCUSE.test(directive.reason)) {
        return {
          status: 'fail',
          message:
            `The skip reason "${directive.reason}" describes a broken environment, not a reason this ` +
            `change does not need tests. A runner that will not start is a bug with a fix. Repair it, ` +
            `or use a scope reason such as "documentation only".`,
          findings: [],
        };
      }
      return { status: 'skip', message: `skipped by directive: ${directive.reason}`, findings: [] };
    }

    const command = resolveCommand(ctx);
    try {
      execSync(command, {
        cwd: ctx.root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeoutMs,
        env: { ...gitFreeEnv(), CI: process.env.CI ?? '1' },
      });
      return { status: 'pass', message: `\`${command}\` passed`, findings: [] };
    } catch (error) {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      const interesting = output
        .split('\n')
        .filter((line) => /fail|error|✗|×|not ok|assert/i.test(line))
        .slice(0, options.outputLines)
        .map((line) => ({ file: null, line: null, excerpt: line.trim().slice(0, 160), detail: null }));

      if (error.code === 'ETIMEDOUT') {
        return {
          status: 'fail',
          message: `\`${command}\` did not finish within ${options.timeoutMs} ms. Raise gates.PROJECT_TESTS.timeoutMs or make the suite faster.`,
          findings: [],
        };
      }

      const message = BOOT_FAILURE.test(output)
        ? `\`${command}\` never reached the tests: the runner failed to start. Fix the environment; do not skip the suite.`
        : `\`${command}\` failed.`;

      return { status: 'fail', message, findings: interesting };
    }
  },
};

/**
 * Determine which command to run.
 *
 * Explicit configuration wins. Otherwise the npm `test` script is used, unless
 * it is the placeholder npm generates, which exists precisely to be replaced
 * and would otherwise report a passing suite that does not exist.
 *
 * @param {object} ctx Gate context.
 * @returns {string|null} Shell command, or null when none is configured.
 */
function resolveCommand(ctx) {
  const configured = ctx.config.gates.PROJECT_TESTS?.command;
  if (typeof configured === 'string' && configured.trim() !== '') return configured;

  const manifest = path.join(ctx.root, 'package.json');
  if (!fs.existsSync(manifest)) return null;
  try {
    const script = JSON.parse(fs.readFileSync(manifest, 'utf8'))?.scripts?.test;
    if (typeof script !== 'string' || script.trim() === '' || NPM_PLACEHOLDER.test(script)) return null;
    return 'npm test --silent';
  } catch {
    return null;
  }
}
