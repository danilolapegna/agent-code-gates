/**
 * EPHEMERAL_LIFECYCLE: a table that expires rows, with nothing that removes them.
 *
 * A column called `expires_at` is a promise, and the promise is usually kept in
 * exactly one place: the read query filters on it. The rows stay. Nothing
 * fails, nothing alerts, and eighteen months later a table of one-time tokens
 * is the largest object in the database and a query that used to take four
 * milliseconds takes four seconds.
 *
 * This is a good gate to have because the fix is nearly free at the moment the
 * migration is written and expensive at any later moment: the cleanup job needs
 * a maintenance window, and the index needs one on a table that is now large.
 * Three things belong in the same migration as the table, and the gate asks for
 * exactly those three: an index on the expiry column, something that deletes,
 * and a written retention policy.
 *
 * The check is plain SQL, with no vendor extensions assumed. Scheduling
 * primitives differ between databases, so a comment declaring where cleanup
 * happens counts, as long as it says where.
 *
 * @module gates/ephemeral-lifecycle
 */

import { matchesAnyGlob } from '../glob.js';

/** Column names that mean a row is meant to stop being relevant. */
const TTL_COLUMN = /\b(\w*(?:expires?_at|expiry|expires|valid_until|valid_through|purge_after|delete_after|ttl(?:_ms|_seconds|_secs)?))\b/i;

/** A statement creating a table. */
const CREATE_TABLE = /\bcreate\s+table\b/i;

export default {
  id: 'EPHEMERAL_LIFECYCLE',
  title: 'Expiring table with no cleanup',
  description: 'A new migration creating a table with an expiry column but no index, cleanup or retention policy.',
  severity: 'error',

  defaults: {
    /** Paths treated as migrations. */
    paths: ['**/migrations/*.sql', '**/migrate/*.sql', '**/db/migrate/*.sql', '**/sql/migrations/*.sql'],
    /** Comment prefix that declares where retention is defined. */
    retentionKeyword: 'Retention',
    /** Comment prefix that declares cleanup happening outside this file. */
    cleanupKeyword: 'Cleanup',
  },

  /**
   * Relevant when this change adds a migration file.
   *
   * Only added files are considered. A later migration that alters an existing
   * table inherits a lifecycle decided elsewhere, and asking it to restate that
   * decision would be ceremony.
   *
   * @param {object} ctx Gate context.
   * @returns {boolean} True when at least one migration is new.
   */
  appliesTo(ctx) {
    const options = ctx.config.gates[this.id];
    return ctx.changedFiles.some((file) => file.status === 'A' && matchesAnyGlob(file.path, options.paths));
  },

  /**
   * @param {object} ctx Gate context.
   * @returns {{status: string, message: string, findings: object[]}} Gate result.
   */
  run(ctx) {
    const options = ctx.config.gates[this.id];
    const migrations = ctx.changedFiles.filter(
      (file) => file.status === 'A' && matchesAnyGlob(file.path, options.paths),
    );

    const findings = [];
    let inspected = 0;

    for (const migration of migrations) {
      const sql = ctx.readFile(migration.path);
      // Column detection runs on the statement text with comments removed. A
      // retention note that mentions "expiry" in prose would otherwise be read
      // as the column name, and every later check would look for a column that
      // does not exist and report it missing.
      const statements = stripComments(sql);
      if (!CREATE_TABLE.test(statements)) continue;

      const ttlMatch = statements.match(TTL_COLUMN);
      if (!ttlMatch) continue;
      inspected += 1;

      const column = ttlMatch[1];
      const missing = [];

      const indexed = new RegExp(
        `create\\s+(?:unique\\s+)?index[\\s\\S]{0,200}?\\(\\s*[^)]*\\b${column}\\b`,
        'i',
      ).test(statements);
      if (!indexed) missing.push(`an index on ${column}`);

      const deletes = new RegExp(`delete\\s+from[\\s\\S]{0,200}?\\b${column}\\b`, 'i').test(statements);
      const scheduled = /\b(?:cron\.schedule|create\s+(?:or\s+replace\s+)?trigger|create\s+event|pg_cron|dbms_scheduler)\b/i.test(statements);
      const declared = new RegExp(`--\\s*${options.cleanupKeyword}\\s*:`, 'i').test(sql);
      if (!deletes && !scheduled && !declared) {
        missing.push(`something that deletes expired rows, or a "-- ${options.cleanupKeyword}: <where it runs>" comment`);
      }

      const retention = new RegExp(`--\\s*(?:${options.retentionKeyword}|TTL)\\s*:`, 'i').test(sql);
      if (!retention) missing.push(`a "-- ${options.retentionKeyword}: <how long rows are kept>" comment`);

      if (missing.length > 0) {
        findings.push({
          file: migration.path,
          line: lineOf(sql, ttlMatch[0]),
          excerpt: `table expires on ${column}`,
          detail: `missing ${missing.join(', ')}`,
        });
      }
    }

    if (inspected === 0) {
      return { status: 'pass', message: 'no new tables with an expiry column', findings: [] };
    }
    if (findings.length === 0) {
      return {
        status: 'pass',
        message: `${inspected} expiring table(s), each with an index, a cleanup path and a retention policy`,
        findings: [],
      };
    }

    return {
      status: 'fail',
      message:
        `${findings.length} new table(s) expire rows with no complete lifecycle. Add the missing pieces ` +
        `to the same migration: rows that expire and are never deleted accumulate forever, and the ` +
        `index that makes cleanup cheap is expensive to add once the table is large.`,
      findings,
    };
  },
};

/**
 * Blank out SQL comments while preserving line structure.
 *
 * Line positions are kept intact so that a line number computed against the
 * stripped text still points at the right line of the original file.
 *
 * @param {string} sql Migration content.
 * @returns {string} The same text with comment bodies replaced by spaces.
 */
function stripComments(sql) {
  return sql
    .replace(/--[^\n]*/g, (match) => ' '.repeat(match.length))
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

/**
 * One-based line number of the first occurrence of a fragment.
 *
 * @param {string} source File content.
 * @param {string} fragment Text to locate.
 * @returns {number} Line number, or 1 when absent.
 */
function lineOf(source, fragment) {
  const index = source.indexOf(fragment);
  return index === -1 ? 1 : source.slice(0, index).split('\n').length;
}
