/**
 * SECRET_SHAPED_LITERAL: credentials committed as source.
 *
 * Coding agents inline credentials for a reason that is almost sympathetic:
 * they are optimising for the code running, and an environment variable that
 * is not set yet makes the code not run. So the key goes in the file, the demo
 * works, and the key is now in git history forever.
 *
 * Detection runs in two tiers. Tier one is issuer-prefixed tokens, where the
 * shape itself is proof and no heuristic is needed. Tier two is a credential
 * shaped assignment: a secret-sounding name bound to a literal that carries
 * real entropy. Tier two applies a placeholder filter first, so documentation,
 * example files and `${...}` interpolation stay quiet.
 *
 * This gate reports shape, not provenance. A rotated key still matches, and
 * that is correct: a rotated key in git history is a key someone has to
 * remember was rotated.
 *
 * @module gates/secret-shaped-literal
 */

import { isAnnotated, excerpt } from '../text.js';
import { matchesAnyGlob } from '../glob.js';

/**
 * Tokens whose issuer prefix makes them self-identifying.
 *
 * @type {Array<{label: string, pattern: RegExp}>}
 */
const ISSUER_TOKENS = [
  { label: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b/ },
  { label: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/ },
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'Stripe live key', pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/ },
  { label: 'model provider key', pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/ },
  { label: 'private key block', pattern: /-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { label: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/ },
];

/** Variable and field names that make a bound literal a credential. */
const SECRET_NAME = /(?:^|[^A-Za-z0-9])(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|encryption[_-]?key|signing[_-]?key|password|passwd|pwd|secret|token|credential)s?(?:["']?\s*(?::|=>|=))/i;

/** Literal on the right-hand side of an assignment. */
const QUOTED_VALUE = /(?::|=>|=)\s*(?:r|b|f|u)?(['"`])([^'"`\n]*)\1/;

/** Values that look filled in but carry nothing. */
const PLACEHOLDER = /^(?:(?:your|my|the|a|some)[-_ .].*|.*(?:example|sample|placeholder|dummy|fake|mock|redacted|changeme|change[-_]me|not[-_]a[-_]real|test[-_]?only)\b.*|x{3,}|\*{3,}|\.{3,}|-+|_+|[0-9]+|null|none|nil|undefined|password|secret|token|key|value|string)$/i;

/** Interpolation and lookup forms that mean the value is resolved elsewhere. */
const INDIRECTION = /\$\{|\{\{|%\(|%s\b|process\.env|os\.environ|System\.getenv|ENV\[|config\.|settings\.|<[^>]+>/;

/**
 * Whether a literal carries enough entropy to be a real credential.
 *
 * The three conditions together are what keep this quiet: a long lowercase
 * English phrase fails the character-class test, a repeated filler string
 * fails the distinct-character test, and anything short fails on length. A
 * real key passes all three without effort.
 *
 * @param {string} value Literal contents, quotes removed.
 * @param {number} minLength Shortest value considered.
 * @returns {boolean} True when the literal looks like a credential.
 */
function looksHighEntropy(value, minLength) {
  if (value.length < minLength) return false;
  if (/\s/.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((cls) => cls.test(value)).length;
  if (classes < 2) return false;
  return new Set(value).size >= 8;
}

export default {
  id: 'SECRET_SHAPED_LITERAL',
  title: 'Credential-shaped literal in source',
  description: 'API keys, tokens, passwords and private keys added as literals in this change.',
  severity: 'error',

  defaults: {
    /** Shortest literal considered for the credential-shaped-assignment tier. */
    minLength: 12,
    /** Inline annotation recording a reviewed, deliberate literal. */
    annotation: 'allowlist-secret',
    /** Paths exempt from scanning, for template and example files. */
    exclude: ['**/*.example', '**/*.example.*', '**/*.sample', '**/*.template', '**/*.dist'],
    /** Extra regular expressions whose matches are never reported. */
    allow: [],
  },

  /**
   * Relevant whenever the change adds lines to any file.
   *
   * A credential in a YAML file or a README is as leaked as one in source, so
   * this gate deliberately does not restrict itself to program source.
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
    const allowPatterns = options.allow.map((source) => new RegExp(source));
    const fileLines = new Map();
    const findings = [];

    for (const added of ctx.addedLines) {
      if (matchesAnyGlob(added.file, options.exclude)) continue;
      if (allowPatterns.some((pattern) => pattern.test(added.text))) continue;

      const issuer = ISSUER_TOKENS.find((token) => token.pattern.test(added.text));
      let detail = issuer?.label ?? null;

      if (!detail && SECRET_NAME.test(added.text) && !INDIRECTION.test(added.text)) {
        const value = added.text.match(QUOTED_VALUE)?.[2] ?? '';
        if (!PLACEHOLDER.test(value) && looksHighEntropy(value, options.minLength)) {
          detail = 'credential-shaped assignment';
        }
      }
      if (!detail) continue;

      if (!fileLines.has(added.file)) fileLines.set(added.file, ctx.readFile(added.file).split('\n'));
      if (isAnnotated(fileLines.get(added.file), added.line - 1, options.annotation, added.file)) continue;

      findings.push({
        file: added.file,
        line: added.line,
        excerpt: redact(added.text),
        detail,
      });
    }

    if (findings.length === 0) {
      return { status: 'pass', message: 'no credential-shaped literals added', findings: [] };
    }

    return {
      status: 'fail',
      message:
        `${findings.length} credential-shaped literal(s) added. Move each one to an environment ` +
        `variable or a secret store and rotate it, because anything committed is compromised even ` +
        `after the commit is amended. A reviewed false positive can be marked with ` +
        `\`${options.annotation}: <why this is safe>\`.`,
      findings,
    };
  },
};

/**
 * Mask the middle of a long literal in the reported excerpt.
 *
 * The report itself is written to terminals, CI logs and pull request comments.
 * Echoing the key verbatim would copy the leak to every one of them.
 *
 * @param {string} line Offending source line.
 * @returns {string} Excerpt with long literal runs masked.
 */
function redact(line) {
  const masked = line.replace(/([A-Za-z0-9_\-+/=]{12,})/g, (run) => `${run.slice(0, 4)}${'*'.repeat(6)}${run.slice(-2)}`);
  return excerpt(masked);
}
