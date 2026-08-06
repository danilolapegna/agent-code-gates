/**
 * The gate registry.
 *
 * Order matters and is not alphabetical. Gates run in the order listed, cheap
 * and local first, so that a change with an obvious problem reports it in
 * milliseconds instead of after the test suite has run. `PROJECT_TESTS` is
 * deliberately last: it is the only gate that spawns a long-running process.
 *
 * Adding a gate means adding a module here and nothing else. The command line
 * listing, the configuration schema and its validation, and the documentation
 * table are all derived from this array, so a gate cannot exist without being
 * configurable and discoverable.
 *
 * @module gates
 */

import todoDensity from './todo-density.js';
import debugResidue from './debug-residue.js';
import skippedTests from './skipped-tests.js';
import secretShapedLiteral from './secret-shaped-literal.js';
import commitSize from './commit-size.js';
import planDeliverables from './plan-deliverables.js';
import testForNewLogic from './test-for-new-logic.js';
import dropImpact from './drop-impact.js';
import ephemeralLifecycle from './ephemeral-lifecycle.js';
import smokeEvidence from './smoke-evidence.js';
import deliveredLock from './delivered-lock.js';
import projectTests from './project-tests.js';

/**
 * All built-in gates, in execution order.
 *
 * @type {ReadonlyArray<object>}
 */
export const gateRegistry = Object.freeze([
  todoDensity,
  debugResidue,
  skippedTests,
  secretShapedLiteral,
  commitSize,
  planDeliverables,
  testForNewLogic,
  dropImpact,
  ephemeralLifecycle,
  smokeEvidence,
  deliveredLock,
  projectTests,
]);

/**
 * Look one gate up by identifier.
 *
 * @param {string} id Gate identifier, for example `TODO_DENSITY`.
 * @returns {object|undefined} The gate, or undefined when the id is unknown.
 */
export function findGate(id) {
  return gateRegistry.find((gate) => gate.id === id);
}

/**
 * Every registered gate identifier.
 *
 * @returns {string[]} Identifiers in execution order.
 */
export function gateIds() {
  return gateRegistry.map((gate) => gate.id);
}
