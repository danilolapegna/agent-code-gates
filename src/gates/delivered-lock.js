/**
 * DELIVERED_LOCK: release claims that nobody observed.
 *
 * This is the gate the rest of the tool exists to support.
 *
 * Every other check here catches a defect in code. This one catches a defect
 * in the *claim about* the code, which is the failure that actually costs
 * money. An agent finishes a feature, sees a green build, and writes
 * "production-ready". Nothing ran. Nobody looked. The sentence is free to
 * write, it is what the human reads, and it is wrong often enough that the
 * human eventually stops reading any of them.
 *
 * The fix is not to ban the sentence. It is to price it. Claiming release
 * costs a `## Runtime observation` block naming what was actually seen, on a
 * URL that is not the author's laptop. Being honest costs one token and a
 * short handoff block:
 *
 *     CODE-COMPLETE, RUNTIME-UNVERIFIED
 *
 *     ## Runtime handoff
 *     cannot-run: no staging credentials in this environment
 *     owner: @someone
 *     to-verify: open /orders, confirm the totals row shows the tax line
 *
 * Honest is cheap, dishonest is expensive, and the gate never has to judge
 * anyone's intent. Note what it does not do: it cannot know whether the
 * observation you wrote is true. It makes the claim traceable to a person and
 * a URL, which is all a mechanical check can honestly promise.
 *
 * @module gates/delivered-lock
 */

import { readField, readSection, isLocalUrl, isPlaceholderValue, firstUrl } from '../text.js';

/**
 * Phrases that assert a release rather than describing work.
 *
 * Bare "shipped" and "delivered" are excluded on purpose. They are ordinary
 * domain vocabulary in commerce, logistics and messaging codebases, and a gate
 * that fires on "fix delivered-orders filter" is a gate that gets uninstalled
 * within a week. Only the qualified forms count.
 */
const RELEASE_CLAIM = /\b(?:production[-\s]ready|fully[-\s]functional|works?\s+end[-\s]to[-\s]end|ready\s+for\s+(?:users|production|launch)|(?:shipped|deployed|delivered|released|rolled\s+out)\s+(?:it\s+)?(?:to|in|into)\s+(?:prod|production|users|customers)|(?:now\s+)?live\s+(?:in|on)\s+production|verified\s+in\s+production)\b/i;

/** Words that turn a claim into its opposite on the same line. */
const NEGATION = /\b(?:not|isn'?t|aren'?t|won'?t|can'?t|cannot|never|no longer|not yet|before|until|once|unless)\b/i;

/** Values that describe a component mounting rather than a system working. */
const MOUNT_ONLY = /^(?:it\s+)?(?:renders?|rendered|loads?|loaded|mounts?|mounted|builds?|compiles?|no\s+(?:crash|errors?|warnings?)|works?|ok|fine|green|passing)\.?$/i;

/** Markers that say verification is still outstanding. */
const PENDING = /\bPENDING[-\s]?(?:VERIFY|PROD|DEPLOY)\b|\bTO[-\s]VERIFY\b/i;

export default {
  id: 'DELIVERED_LOCK',
  title: 'Release claim without an observation',
  description: 'A commit that claims production readiness without recording what was observed running.',
  severity: 'error',
  needsCommitMessage: true,

  defaults: {
    /** Heading that must accompany a RUNTIME-VERIFIED claim. */
    observationHeading: 'Runtime observation',
    /** Heading that must accompany the honest downgrade. */
    handoffHeading: 'Runtime handoff',
    /** Shortest useful description of what was seen on screen. */
    minObservationLength: 12,
    /** When false, an observation on a local URL is accepted. */
    requireDeployedUrl: true,
  },

  /**
   * Relevant whenever there is a commit message to read.
   *
   * Deliberately not scoped to particular file paths. The trigger is the
   * sentence the author wrote, not the directory they wrote it about, which is
   * what keeps this gate stack-agnostic and its false-positive rate near zero.
   *
   * @param {object} ctx Gate context.
   * @returns {boolean} True when a message exists.
   */
  appliesTo(ctx) {
    return ctx.hasCommitMessage;
  },

  /**
   * @param {object} ctx Gate context.
   * @returns {{status: string, message: string, findings: object[]}} Gate result.
   */
  run(ctx) {
    const options = ctx.config.gates[this.id];
    const message = ctx.commitMessage;

    const claimLine = message
      .split('\n')
      .find((line) => RELEASE_CLAIM.test(line) && !NEGATION.test(line));

    const verified = /\bRUNTIME-VERIFIED\b/.test(message);
    const unverified = /\bRUNTIME-UNVERIFIED\b/.test(message);

    if (!claimLine) {
      if (!unverified) {
        return { status: 'pass', message: 'no release claim to back up', findings: [] };
      }
      return this.checkHandoff(ctx, options);
    }

    const guidance = this.guidance(options);
    const finding = { file: null, line: null, excerpt: claimLine.trim(), detail: 'release claim' };

    if (verified && unverified) {
      return {
        status: 'fail',
        message: `The commit declares both RUNTIME-VERIFIED and RUNTIME-UNVERIFIED. Pick one. ${guidance}`,
        findings: [finding],
      };
    }
    if (!verified && !unverified) {
      return {
        status: 'fail',
        message: `The commit claims a release but declares no runtime status. ${guidance}`,
        findings: [finding],
      };
    }
    if (unverified) {
      return {
        status: 'fail',
        message:
          `The commit claims a release and also declares RUNTIME-UNVERIFIED, which contradicts it. ` +
          `If nobody has watched it run, it is not released: drop the wording and keep the honest status. ${guidance}`,
        findings: [finding],
      };
    }

    return this.checkObservation(ctx, options, finding, guidance);
  },

  /**
   * Validate the `## Runtime observation` block behind a RUNTIME-VERIFIED claim.
   *
   * @param {object} ctx Gate context.
   * @param {object} options Resolved gate options.
   * @param {object} claimFinding Finding describing the claim line.
   * @param {string} guidance Shared remediation text.
   * @returns {{status: string, message: string, findings: object[]}} Gate result.
   */
  checkObservation(ctx, options, claimFinding, guidance) {
    const block = this.findBlock(ctx, options.observationHeading);
    if (!block) {
      return {
        status: 'fail',
        message:
          `RUNTIME-VERIFIED is declared but there is no "## ${options.observationHeading}" block ` +
          `in the commit message or the evidence directory. ${guidance}`,
        findings: [claimFinding],
      };
    }

    const problems = [];
    const data = readField(block.text, 'data');
    if (!data || !/^real\b/i.test(data)) {
      problems.push('data: must say "real"; a run against stubs proves the code can bind, not that the system works');
    }

    const observed = readField(block.text, 'observed');
    if (!observed || isPlaceholderValue(observed, options.minObservationLength) || MOUNT_ONLY.test(observed)) {
      problems.push('observed: needs the actual value or behaviour seen on screen, not "renders" or "no errors"');
    }

    if (options.requireDeployedUrl) {
      const raw = readField(block.text, 'url') ?? readField(block.text, 'verified-at') ?? '';
      const url = firstUrl(raw);
      if (!url || isLocalUrl(url)) {
        problems.push('url: needs the deployed address where this was observed; a development server is not a deployment');
      }
    }

    if (PENDING.test(block.text)) {
      problems.push('a PENDING marker under a RUNTIME-VERIFIED claim; pending is not delivered, so downgrade the status');
    }

    if (problems.length === 0) {
      return {
        status: 'pass',
        message: `release claim backed by a runtime observation (${block.source})`,
        findings: [],
      };
    }

    return {
      status: 'fail',
      message:
        `The "## ${options.observationHeading}" block (${block.source}) is not an observation yet: ` +
        `${problems.join('; ')}. ${guidance}`,
      findings: [claimFinding],
    };
  },

  /**
   * Validate the `## Runtime handoff` block behind the honest downgrade.
   *
   * The downgrade has teeth on purpose. `RUNTIME-UNVERIFIED` with no handoff is
   * a footnote that quietly ages into never being checked; with a named owner
   * and a concrete checklist it is a piece of work somebody holds.
   *
   * @param {object} ctx Gate context.
   * @param {object} options Resolved gate options.
   * @returns {{status: string, message: string, findings: object[]}} Gate result.
   */
  checkHandoff(ctx, options) {
    const block = this.findBlock(ctx, options.handoffHeading);
    const owner = block ? readField(block.text, 'owner') : null;
    const toVerify = block ? readField(block.text, 'to-verify') : null;

    if (block && !isPlaceholderValue(owner ?? '') && !isPlaceholderValue(toVerify ?? '', 8)) {
      return {
        status: 'pass',
        message: `honest RUNTIME-UNVERIFIED status with a complete handoff (${block.source})`,
        findings: [],
      };
    }

    return {
      status: 'fail',
      message:
        `RUNTIME-UNVERIFIED is declared without a usable "## ${options.handoffHeading}" block. ` +
        `The downgrade is the right call; it just has to leave someone able to act on it. Add:\n` +
        `  ## ${options.handoffHeading}\n` +
        `  cannot-run: <why this environment cannot exercise it>\n` +
        `  owner: <who verifies>\n` +
        `  to-verify: <the exact steps and the real value expected>`,
      findings: [],
    };
  },

  /**
   * Locate a heading block in the commit message or the evidence directories.
   *
   * @param {object} ctx Gate context.
   * @param {string} heading Heading text without leading hashes.
   * @returns {{text: string, source: string}|null} The block and where it came from.
   */
  findBlock(ctx, heading) {
    for (const document of ctx.evidenceDocuments()) {
      const section = readSection(document.text, heading);
      if (section !== null) return { text: section, source: document.source };
    }
    return null;
  },

  /**
   * The remediation paragraph shared by every failure path.
   *
   * @param {object} options Resolved gate options.
   * @returns {string} Guidance text.
   */
  guidance(options) {
    return (
      `Declare exactly one of:\n`
      + `  RUNTIME-VERIFIED  + ## ${options.observationHeading} (data: real / observed: <what you saw> / url: <deployed address>)\n`
      + `  CODE-COMPLETE, RUNTIME-UNVERIFIED  + ## ${options.handoffHeading} (cannot-run / owner / to-verify), and drop the release wording.`
    );
  },
};
