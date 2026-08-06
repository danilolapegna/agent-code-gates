/**
 * PLAN_DELIVERABLES: plan items delivered in silence.
 *
 * The single most expensive habit in agent-assisted work is the silent
 * omission. Given a five-item plan, an agent delivers three, writes a summary
 * about the three it did, and never mentions the other two. Nothing lies. Two
 * items simply stop existing, and the reader has no way to notice absence.
 *
 * So the gate makes absence loud. If the commit points at a plan file, every
 * open item in that plan needs an explicit word next to it: DONE, PARTIAL,
 * NOT-STARTED or SKIPPED. Silence is not a status.
 *
 * Items already checked off in the plan itself are treated as reported: the
 * plan file is the tracker, and re-declaring closed items in every subsequent
 * commit would be busywork that trains people to bypass the gate.
 *
 * @module gates/plan-deliverables
 */

import path from 'node:path';
import { wordOverlap, excerpt } from '../text.js';

/** Checklist item: `- [ ] text` or `* [x] text`. */
const CHECKLIST_ITEM = /^\s{0,6}[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;

/** Top-level numbered item: `1. text` or `2) text`. */
const NUMBERED_ITEM = /^\s{0,3}(\d{1,2})[.)]\s+(.+?)\s*$/;

/** Explicit pointer an author can write to name the plan unambiguously. */
const EXPLICIT_PLAN_FIELD = /^\s*(?:[-*+]\s*)?plan\s*:\s*(\S+\.md)\s*$/im;

/** Every markdown path mentioned anywhere in the message. */
const MARKDOWN_PATH = /(?:^|[\s(<"'`])([\w./-]+\.md)\b/g;

/**
 * Collect the plan files a commit message points at and that exist on disk.
 *
 * @param {object} ctx Gate context.
 * @param {RegExp} nameFilter Pattern a filename must match to count as a plan.
 * @returns {string[]} Repo-relative paths, de-duplicated.
 */
function referencedPlans(ctx, nameFilter) {
  const candidates = new Set();

  const explicit = ctx.commitMessage.match(EXPLICIT_PLAN_FIELD);
  if (explicit) candidates.add(explicit[1]);

  for (const match of ctx.commitMessage.matchAll(MARKDOWN_PATH)) {
    if (nameFilter.test(path.basename(match[1]))) candidates.add(match[1]);
  }

  const tracked = new Set(ctx.listRepoFiles());
  return [...candidates]
    .map((candidate) => candidate.replace(/^\.\//, ''))
    .filter((candidate) => tracked.has(candidate));
}

/**
 * Extract enumerated items from a plan document.
 *
 * Checklists win over numbered lists when both are present, because a document
 * that uses checkboxes has already declared how it tracks state and its
 * numbered lines are usually prose, not deliverables.
 *
 * @param {string} source Plan file content.
 * @returns {Array<{index: number, text: string, closed: boolean, line: number}>} Items.
 */
function parsePlanItems(source) {
  const lines = source.split('\n');
  const checklist = [];
  const numbered = [];

  lines.forEach((line, offset) => {
    const check = line.match(CHECKLIST_ITEM);
    if (check) {
      checklist.push({
        index: checklist.length + 1,
        text: check[2],
        closed: check[1].toLowerCase() === 'x',
        line: offset + 1,
      });
      return;
    }
    const number = line.match(NUMBERED_ITEM);
    if (number) {
      numbered.push({ index: Number(number[1]), text: number[2], closed: false, line: offset + 1 });
    }
  });

  return checklist.length > 0 ? checklist : numbered;
}

/**
 * Whether the commit message declares a status for one plan item.
 *
 * Two ways to match, because two ways are how people actually write. Either the
 * line names the item by number (`3. DONE`, `#3 SKIPPED`), or it restates
 * enough of the item's wording to be unambiguous.
 *
 * @param {string} message Commit message.
 * @param {{index: number, text: string}} item Plan item.
 * @param {RegExp} statusPattern Status vocabulary.
 * @param {number} threshold Minimum word overlap, 0 to 1.
 * @returns {boolean} True when a status is declared for the item.
 */
function hasDeclaredStatus(message, item, statusPattern, threshold) {
  const byNumber = new RegExp(`(?:^|[\\s(\\[#])${item.index}[.)\\]:]?\\s`);
  return message.split('\n').some((line) => {
    if (!statusPattern.test(line)) return false;
    if (byNumber.test(line)) return true;
    return wordOverlap(item.text, line) >= threshold;
  });
}

export default {
  id: 'PLAN_DELIVERABLES',
  title: 'Plan items delivered without a status',
  description: 'Open items in a referenced plan that the commit never accounts for.',
  severity: 'error',
  needsCommitMessage: true,

  defaults: {
    /** A markdown filename must match this to be treated as a plan. */
    planFilePattern: 'plan',
    /**
     * Words that count as an explicit status declaration. Internal separators
     * are matched loosely, so `NOT-STARTED`, `NOT STARTED` and `NOT_STARTED`
     * are all the same word and only one of them needs listing here.
     */
    statuses: ['DONE', 'PARTIAL', 'NOT-STARTED', 'SKIPPED'],
    /** Fraction of an item's significant words a line must restate to match it. */
    matchThreshold: 0.5,
  },

  /**
   * Relevant only when the commit message mentions a markdown file at all.
   *
   * @param {object} ctx Gate context.
   * @returns {boolean} True when a plan reference is plausible.
   */
  appliesTo(ctx) {
    return /\.md\b/i.test(ctx.commitMessage);
  },

  /**
   * @param {object} ctx Gate context.
   * @returns {{status: string, message: string, findings: object[]}} Gate result.
   */
  run(ctx) {
    const options = ctx.config.gates[this.id];
    const nameFilter = new RegExp(options.planFilePattern, 'i');
    const plans = referencedPlans(ctx, nameFilter);

    if (plans.length === 0) {
      return { status: 'skip', message: 'no tracked plan file referenced by this commit', findings: [] };
    }

    const statusPattern = new RegExp(
      `\\b(?:${options.statuses
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-_ ]/g, '[-_ ]'))
        .join('|')})\\b`,
      'i',
    );

    const findings = [];
    let openItems = 0;

    for (const plan of plans) {
      const items = parsePlanItems(ctx.readFile(plan));
      for (const item of items) {
        if (item.closed) continue;
        openItems += 1;
        if (hasDeclaredStatus(ctx.commitMessage, item, statusPattern, options.matchThreshold)) continue;
        findings.push({
          file: plan,
          line: item.line,
          excerpt: excerpt(item.text),
          detail: `item ${item.index} has no status in the commit message`,
        });
      }
    }

    if (openItems === 0) {
      return {
        status: 'pass',
        message: `${plans.join(', ')} referenced; no open items to account for`,
        findings: [],
      };
    }

    if (findings.length === 0) {
      return {
        status: 'pass',
        message: `all ${openItems} open item(s) in ${plans.join(', ')} carry a status`,
        findings: [],
      };
    }

    return {
      status: 'fail',
      message:
        `${findings.length} of ${openItems} open plan item(s) are unaccounted for. ` +
        `Add one line per item to the commit body with ${options.statuses.join(', ')}. ` +
        `Saying NOT-STARTED costs nothing; saying nothing is how work disappears.`,
      findings,
    };
  },
};
