/**
 * Configuration loading, validation and defaulting.
 *
 * Configuration is validated strictly and loudly. A typo in a gate id or an
 * option name is reported as an error rather than ignored, because the failure
 * mode of silent tolerance is the worst one available here: a team believes a
 * gate is configured, the option never takes effect, and the gate either
 * blocks work it should not or waves through work it should not. Loud beats
 * lenient when the whole product is trustworthiness.
 *
 * @module config
 */

import fs from 'node:fs';
import path from 'node:path';
import { gateRegistry } from './gates/index.js';

/** Default filename looked up at the repository root. */
export const CONFIG_FILENAME = '.agentgatesrc.json';

/** Severity levels a gate failure can carry. */
export const SEVERITIES = ['error', 'warning'];

/** Options every gate accepts, on top of whatever it declares itself. */
const UNIVERSAL_GATE_OPTIONS = ['enabled', 'severity'];

/** Paths never scanned, regardless of user configuration. */
const ALWAYS_IGNORED = [
  'node_modules/**',
  '**/node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  'vendor/**',
  '**/*.min.js',
  '**/*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

/**
 * Raised when a configuration file cannot be used as written.
 */
export class ConfigError extends Error {
  /**
   * @param {string[]} problems One message per distinct problem found.
   * @param {string|null} [file] Path of the offending file, when there is one.
   */
  constructor(problems, file = null) {
    super(`Invalid configuration${file ? ` in ${file}` : ''}:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
    this.file = file;
  }
}

/**
 * The configuration used when no file is present.
 *
 * Built from the gate registry rather than duplicated as a literal, so a new
 * gate cannot be added without its defaults becoming reachable.
 *
 * @returns {object} A fully populated configuration object.
 */
export function defaultConfig() {
  const gates = {};
  for (const gate of gateRegistry) {
    gates[gate.id] = {
      enabled: true,
      severity: gate.severity,
      ...structuredClone(gate.defaults ?? {}),
    };
  }
  return {
    ignore: [],
    evidenceDirs: ['.gates-evidence'],
    strict: false,
    gates,
  };
}

/**
 * Validate and merge a raw configuration object over the defaults.
 *
 * @param {unknown} raw Parsed JSON from a configuration file.
 * @param {string|null} [file] Path used in error messages.
 * @returns {object} Resolved configuration.
 * @throws {ConfigError} When any key, type or value is unusable.
 */
export function resolveConfig(raw, file = null) {
  const problems = [];
  const resolved = defaultConfig();

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(['the top level must be a JSON object'], file);
  }

  const knownTop = new Set(['$schema', 'ignore', 'evidenceDirs', 'strict', 'gates']);
  for (const key of Object.keys(raw)) {
    if (!knownTop.has(key)) {
      problems.push(`unknown top-level key "${key}" (expected: ${[...knownTop].join(', ')})`);
    }
  }

  if (raw.ignore !== undefined) {
    if (isStringArray(raw.ignore)) resolved.ignore = [...raw.ignore];
    else problems.push('"ignore" must be an array of glob strings');
  }

  if (raw.evidenceDirs !== undefined) {
    if (isStringArray(raw.evidenceDirs)) resolved.evidenceDirs = [...raw.evidenceDirs];
    else problems.push('"evidenceDirs" must be an array of directory paths');
  }

  if (raw.strict !== undefined) {
    if (typeof raw.strict === 'boolean') resolved.strict = raw.strict;
    else problems.push('"strict" must be a boolean');
  }

  if (raw.gates !== undefined) {
    if (raw.gates === null || typeof raw.gates !== 'object' || Array.isArray(raw.gates)) {
      problems.push('"gates" must be an object keyed by gate id');
    } else {
      for (const [id, options] of Object.entries(raw.gates)) {
        const gate = gateRegistry.find((candidate) => candidate.id === id);
        if (!gate) {
          problems.push(`unknown gate "${id}" (run: agent-code-gates --list)`);
          continue;
        }
        if (options === null || typeof options !== 'object' || Array.isArray(options)) {
          problems.push(`gates.${id} must be an object`);
          continue;
        }
        problems.push(...mergeGateOptions(resolved.gates[id], gate, options));
      }
    }
  }

  if (problems.length > 0) throw new ConfigError(problems, file);
  return resolved;
}

/**
 * Merge one gate's user options into its resolved options, in place.
 *
 * @param {object} target Resolved options for this gate.
 * @param {object} gate Gate definition supplying the allowed option names.
 * @param {object} options User-supplied options.
 * @returns {string[]} Problems found; empty when the options are usable.
 */
function mergeGateOptions(target, gate, options) {
  const problems = [];
  const allowed = new Set([...UNIVERSAL_GATE_OPTIONS, ...Object.keys(gate.defaults ?? {})]);

  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) {
      problems.push(`gates.${gate.id}: unknown option "${key}" (allowed: ${[...allowed].sort().join(', ')})`);
      continue;
    }
    if (key === 'enabled') {
      if (typeof value !== 'boolean') problems.push(`gates.${gate.id}.enabled must be a boolean`);
      else target.enabled = value;
      continue;
    }
    if (key === 'severity') {
      if (!SEVERITIES.includes(value)) {
        problems.push(`gates.${gate.id}.severity must be one of: ${SEVERITIES.join(', ')}`);
      } else {
        target.severity = value;
      }
      continue;
    }
    const expected = gate.defaults[key];
    const problem = typeMismatch(`gates.${gate.id}.${key}`, expected, value);
    if (problem) {
      problems.push(problem);
      continue;
    }
    if (Array.isArray(value)) {
      target[key] = [...value];
    } else if (value !== null && typeof value === 'object') {
      // Object-valued options are merged, not replaced. Replacing would make
      // `"rules": { "goPrint": true }` silently disable every other rule, which
      // is the opposite of what anyone writing that line intends.
      target[key] = { ...target[key], ...value };
    } else {
      target[key] = value;
    }
  }

  return problems;
}

/**
 * Compare a user value against the shape of the gate's default for that option.
 *
 * Shape comparison rather than a schema keeps the gate definition as the single
 * source of truth: a gate author declares a default and gets validation for it
 * without writing a second declaration that can drift from the first.
 *
 * @param {string} label Dotted path used in the message.
 * @param {unknown} expected The gate's default value.
 * @param {unknown} actual The user's value.
 * @returns {string|null} A problem message, or null when the value is usable.
 */
function typeMismatch(label, expected, actual) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${label} must be an array`;
    if (expected.length > 0 && typeof expected[0] === 'string' && !isStringArray(actual)) {
      return `${label} must be an array of strings`;
    }
    return null;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return `${label} must be an object`;
    }
    const problems = [];
    for (const [key, value] of Object.entries(actual)) {
      if (!(key in expected)) {
        problems.push(`${label}: unknown key "${key}"`);
        continue;
      }
      const nested = typeMismatch(`${label}.${key}`, expected[key], value);
      if (nested) problems.push(nested);
    }
    return problems.length > 0 ? problems.join('; ') : null;
  }
  if (typeof actual !== typeof expected) return `${label} must be a ${typeof expected}`;
  if (typeof expected === 'number' && !Number.isFinite(actual)) return `${label} must be a finite number`;
  return null;
}

/**
 * Whether a value is an array containing only strings.
 *
 * @param {unknown} value Candidate.
 * @returns {boolean} True for a homogeneous string array.
 */
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Load configuration from a repository, falling back to defaults.
 *
 * A missing file is normal and silent. A malformed file is fatal: proceeding
 * with defaults would run a different set of gates than the team configured,
 * while reporting success.
 *
 * @param {string} repoRoot Absolute repository root.
 * @param {string|null} [explicitPath] Path given on the command line.
 * @returns {{config: object, file: string|null}} Resolved config and its source.
 * @throws {ConfigError} When the file exists but cannot be used.
 */
export function loadConfig(repoRoot, explicitPath = null) {
  const file = explicitPath
    ? path.resolve(repoRoot, explicitPath)
    : path.join(repoRoot, CONFIG_FILENAME);

  if (!fs.existsSync(file)) {
    if (explicitPath) throw new ConfigError([`file not found: ${file}`], file);
    return { config: defaultConfig(), file: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError([`not valid JSON: ${error.message}`], file);
  }

  return { config: resolveConfig(parsed, file), file };
}

/**
 * The ignore list a context should apply: the user's plus the permanent ones.
 *
 * @param {object} config Resolved configuration.
 * @returns {string[]} Glob patterns.
 */
export function effectiveIgnore(config) {
  return [...ALWAYS_IGNORED, ...(config.ignore ?? [])];
}
