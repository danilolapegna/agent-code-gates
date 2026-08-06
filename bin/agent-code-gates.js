#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * Three exit codes, and they mean three different things on purpose:
 *
 *   0  every gate that ran is satisfied
 *   1  at least one gate is blocking this change
 *   2  the tool could not run: bad arguments, bad config, not a repository
 *
 * CI needs the distinction. A `2` means fix the pipeline; a `1` means fix the
 * code, and conflating them produces the worst outcome available here, which is
 * a broken setup that reports clean.
 *
 * @module bin/agent-code-gates
 */

import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildContext } from '../src/context.js';
import { loadConfig, ConfigError, CONFIG_FILENAME } from '../src/config.js';
import { runGates } from '../src/runner.js';
import { renderHuman, renderJson, renderList, exitCodeFor, shouldUseColor } from '../src/report.js';
import { gateRegistry, findGate } from '../src/gates/index.js';
import { installHook } from '../src/hooks.js';
import { repoRoot } from '../src/git.js';

/** Exit code for a problem with the invocation rather than with the code. */
const EXIT_USAGE = 2;

/**
 * Read this package's version without importing JSON, which still needs an
 * assertion clause on some supported Node versions.
 *
 * @returns {string} Semantic version string.
 */
function toolVersion() {
  const manifest = fileURLToPath(new URL('../package.json', import.meta.url));
  try {
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

/** Usage text, kept close to the flag parser so the two cannot drift apart. */
const HELP = `
agent-code-gates ${toolVersion()}

  Mechanical gates that block AI-written code from being declared done
  when it isn't. Run it from a commit-msg hook, or in CI against a commit.

Usage
  agent-code-gates [options]

Selecting what to inspect
  --staged                 Evaluate the staged change (default)
  --commit <ref>           Evaluate a finished commit, for CI or an audit
  --message-file <path>    Read the commit message from a file (hooks pass "$1")
  --cwd <path>             Run against a repository other than the current one

Selecting which gates
  --gate <ID>              Run only this gate; repeatable
  --list                   List every gate with its default severity
  --config <path>          Use a config file other than ${CONFIG_FILENAME}

Output
  --json                   Machine-readable result on stdout
  --verbose                Show messages for passing and skipped gates too
  --no-color               Disable ANSI colour (also honours NO_COLOR)
  --strict                 Treat warnings as blocking

Setup
  --install-hooks          Write the commit-msg hook into this repository
  --init                   Write a starter ${CONFIG_FILENAME}
  --force                  Allow --install-hooks and --init to overwrite

  -h, --help               Show this text
  -v, --version            Show the version

Exit codes
  0  nothing blocking      1  a gate is blocking      2  could not run
`.trim();

/**
 * Parse argv into an options object.
 *
 * Unknown flags are a usage error rather than being ignored, so a mistyped
 * `--stricct` in a CI file fails visibly instead of quietly weakening the run.
 *
 * @param {string[]} argv Arguments after the node binary and script.
 * @returns {object} Parsed options.
 * @throws {Error} On an unknown flag or a missing value.
 */
function parseArgs(argv) {
  const options = {
    mode: 'staged',
    ref: 'HEAD',
    messageFile: null,
    cwd: process.cwd(),
    only: [],
    config: null,
    json: false,
    verbose: false,
    color: null,
    strict: false,
    list: false,
    installHooks: false,
    init: false,
    force: false,
    help: false,
    version: false,
  };

  const requireValue = (flag, value) => {
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--staged': options.mode = 'staged'; break;
      case '--commit': options.mode = 'commit'; options.ref = requireValue(arg, argv[++i]); break;
      case '--message-file': options.messageFile = requireValue(arg, argv[++i]); break;
      case '--cwd': options.cwd = requireValue(arg, argv[++i]); break;
      case '--gate': options.only.push(requireValue(arg, argv[++i])); break;
      case '--config': options.config = requireValue(arg, argv[++i]); break;
      case '--json': options.json = true; break;
      case '--verbose': options.verbose = true; break;
      case '--no-color': options.color = false; break;
      case '--color': options.color = true; break;
      case '--strict': options.strict = true; break;
      case '--list': options.list = true; break;
      case '--install-hooks': options.installHooks = true; break;
      case '--init': options.init = true; break;
      case '--force': options.force = true; break;
      case '-h': case '--help': options.help = true; break;
      case '-v': case '--version': options.version = true; break;
      default:
        throw new Error(`unknown option "${arg}" (try --help)`);
    }
  }

  const unknownGate = options.only.find((id) => !findGate(id));
  if (unknownGate) throw new Error(`unknown gate "${unknownGate}" (try --list)`);

  return options;
}

/** Starter configuration written by `--init`, with the two knobs worth having first. */
const STARTER_CONFIG = `{
  "ignore": [],
  "gates": {
    "SMOKE_EVIDENCE": {
      "comment_paths": "list the directories that hold user-facing code",
      "paths": ["src/components/**", "src/pages/**"]
    },
    "COMMIT_SIZE": {
      "maxFiles": 5,
      "maxLines": 500
    }
  }
}
`;

/**
 * Write a starter configuration file.
 *
 * @param {string} root Repository root.
 * @param {boolean} force Whether to overwrite an existing file.
 * @returns {string} Message describing what happened.
 * @throws {Error} When the file exists and `force` is not set.
 */
function writeStarterConfig(root, force) {
  const target = `${root}/${CONFIG_FILENAME}`;
  if (fs.existsSync(target) && !force) {
    throw new Error(`${target} already exists; pass --force to overwrite it`);
  }
  // The comment key is illustrative only and is stripped before writing, since
  // a config the tool would reject is a poor thing to hand someone as a start.
  const parsed = JSON.parse(STARTER_CONFIG);
  delete parsed.gates.SMOKE_EVIDENCE.comment_paths;
  fs.writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`);
  return `wrote ${CONFIG_FILENAME}`;
}

/**
 * Run the command line.
 *
 * @returns {Promise<number>} Process exit code.
 */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`agent-code-gates: ${error.message}\n`);
    return EXIT_USAGE;
  }

  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${toolVersion()}\n`);
    return 0;
  }

  const color = shouldUseColor(process.stdout, options.color);

  let root;
  try {
    root = repoRoot(options.cwd);
  } catch {
    process.stderr.write(`agent-code-gates: ${options.cwd} is not inside a git repository\n`);
    return EXIT_USAGE;
  }

  let config;
  try {
    ({ config } = loadConfig(root, options.config));
  } catch (error) {
    process.stderr.write(`agent-code-gates: ${error instanceof ConfigError ? error.message : error}\n`);
    return EXIT_USAGE;
  }

  if (options.list) {
    process.stdout.write(`${renderList(gateRegistry, { color, config })}\n`);
    return 0;
  }

  if (options.init) {
    try {
      process.stdout.write(`agent-code-gates: ${writeStarterConfig(root, options.force)}\n`);
    } catch (error) {
      process.stderr.write(`agent-code-gates: ${error.message}\n`);
      return EXIT_USAGE;
    }
  }

  if (options.installHooks) {
    try {
      const { path: hookPath, action } = installHook(root, { force: options.force });
      process.stdout.write(`agent-code-gates: ${action} ${hookPath}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`agent-code-gates: ${error.message}\n`);
      return EXIT_USAGE;
    }
  }

  if (options.init) return 0;

  let ctx;
  try {
    ctx = buildContext({
      cwd: root,
      mode: options.mode,
      ref: options.ref,
      messageFile: options.messageFile,
      config,
    });
  } catch (error) {
    process.stderr.write(`agent-code-gates: ${error.message}\n`);
    return EXIT_USAGE;
  }

  const run = await runGates(ctx, { only: options.only, strict: options.strict });

  if (options.json) {
    process.stdout.write(`${renderJson(run)}\n`);
  } else {
    process.stdout.write(`${renderHuman(run, {
      color,
      width: process.stdout.columns ?? undefined,
      verbose: options.verbose,
    })}\n`);
  }

  return exitCodeFor(run);
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`agent-code-gates: unexpected failure: ${error?.stack ?? error}\n`);
    process.exitCode = EXIT_USAGE;
  },
);
