/**
 * SMOKE_EVIDENCE: user-facing changes with no record of anyone using them.
 *
 * A component that mounts is not a feature that works. The evidence that gets
 * offered for user-facing work is almost always mount-shaped: "renders", "no
 * console errors", "builds clean". All three are true of a screen showing an
 * empty list because the query returned nothing, and of a screen that will
 * throw the moment the deployed backend answers instead of the local stub.
 *
 * So the gate asks for three things that a mount cannot fake: whether the data
 * was real, what content was confirmed present, and where it was seen. The
 * third one matters most, because "it worked locally" and "it works" differ by
 * exactly one deployment.
 *
 * The honest alternative is explicit and always available: declare
 * `PENDING-VERIFY:` with what is unverified and who owns it. Deferring
 * verification is a legitimate engineering decision; leaving it unsaid is not.
 *
 * Calibrated as a warning by default. Unlike DELIVERED_LOCK, this gate fires
 * on a file-path signal rather than on a sentence the author chose to write,
 * so it will sometimes ask for evidence on a change that plainly does not need
 * it. Promote it to `error` once your path patterns are tuned.
 *
 * @module gates/smoke-evidence
 */

import { readField, readSection, isLocalUrl, isPlaceholderValue, firstUrl } from '../text.js';
import { matchesAnyGlob } from '../glob.js';

/** Values that describe a render rather than a working feature. */
const MOUNT_ONLY = /\b(?:renders?|rendered|mounts?|mounted|loads?|loaded|builds?|compiles?|no\s+(?:crash|errors?|warnings?)|works?|looks?\s+(?:good|fine|right)|ok|fine)\b/i;

/** Content-shaped assertions: a number of things, or a named thing being present. */
const CONTENT_ASSERTION = /\b\d+\s+\w+|\b(?:shows?|showing|displays?|contains?|lists?|returns?|equals?|reads?|says?)\b/i;

export default {
  id: 'SMOKE_EVIDENCE',
  title: 'User-facing change with no smoke evidence',
  description: 'A change to user-facing files with no record of the feature being exercised.',
  severity: 'warning',
  needsCommitMessage: true,

  defaults: {
    /** Paths whose change makes smoke evidence expected. Tune these first. */
    paths: [
      'src/components/**', 'src/pages/**', 'src/routes/**', 'src/views/**', 'src/screens/**',
      'app/**', 'components/**', 'pages/**', 'views/**', 'templates/**', 'ui/**',
      '**/*.vue', '**/*.svelte', '**/*.jsx', '**/*.tsx',
    ],
    /** Heading the evidence block must carry. */
    heading: 'Smoke evidence',
    /** When false, evidence recorded against a local URL is accepted. */
    requireDeployedUrl: true,
  },

  /**
   * Relevant when this change touches a configured user-facing path.
   *
   * @param {object} ctx Gate context.
   * @returns {boolean} True when at least one user-facing file changed.
   */
  appliesTo(ctx) {
    const options = ctx.config.gates[this.id];
    return ctx.changedFiles.some(
      (file) => file.status !== 'D'
        && !ctx.isTestPath(file.path)
        && matchesAnyGlob(file.path, options.paths),
    );
  },

  /**
   * @param {object} ctx Gate context.
   * @returns {{status: string, message: string, findings: object[]}} Gate result.
   */
  run(ctx) {
    const options = ctx.config.gates[this.id];
    const touched = ctx.changedFiles
      .filter((file) => file.status !== 'D' && matchesAnyGlob(file.path, options.paths))
      .map((file) => ({ file: file.path, line: null, excerpt: 'user-facing change', detail: 'needs evidence' }));

    const block = this.findBlock(ctx, options.heading);
    if (!block) {
      return {
        status: 'fail',
        message: this.template(options, 'No "## ' + options.heading + '" block found in the commit message or the evidence directory.'),
        findings: touched.slice(0, 8),
      };
    }

    const pending = readField(block.text, 'PENDING-VERIFY');
    if (pending !== null) {
      const owner = readField(block.text, 'owner');
      if (isPlaceholderValue(pending, 8) || isPlaceholderValue(owner ?? '')) {
        return {
          status: 'fail',
          message:
            `The "## ${options.heading}" block defers verification but does not say enough to act on. ` +
            `PENDING-VERIFY: needs what is unverified, and owner: needs who checks it.`,
          findings: touched.slice(0, 8),
        };
      }
      return {
        status: 'pass',
        message: `verification explicitly deferred and owned (${block.source})`,
        findings: [],
      };
    }

    const problems = [];

    const data = readField(block.text, 'data');
    if (!data || !/^(?:real|stubbed)\b/i.test(data)) {
      problems.push('data: must say "real" or "stubbed", so a reader knows what the run proves');
    }

    const criteria = readField(block.text, 'success criteria') ?? readField(block.text, 'success_criteria');
    if (!criteria || isPlaceholderValue(criteria, 8)) {
      problems.push('success criteria: needs the real content you confirmed on screen');
    } else if (!CONTENT_ASSERTION.test(criteria) && MOUNT_ONLY.test(criteria)) {
      problems.push(
        `success criteria: "${criteria}" describes a mount, not a result. Name the content: `
        + '"order total shows 148.20", "the list shows 3 saved filters"',
      );
    }

    if (options.requireDeployedUrl) {
      const url = firstUrl(readField(block.text, 'url') ?? '');
      if (!url || isLocalUrl(url)) {
        problems.push('url: needs the deployed address where this was exercised');
      }
    }

    if (problems.length === 0) {
      return { status: 'pass', message: `smoke evidence recorded (${block.source})`, findings: [] };
    }

    return {
      status: 'fail',
      message: this.template(options, `The "## ${options.heading}" block (${block.source}) is incomplete: ${problems.join('; ')}.`),
      findings: touched.slice(0, 8),
    };
  },

  /**
   * Locate the evidence block in the message or the evidence directories.
   *
   * @param {object} ctx Gate context.
   * @param {string} heading Heading text.
   * @returns {{text: string, source: string}|null} Block and its source.
   */
  findBlock(ctx, heading) {
    for (const document of ctx.evidenceDocuments()) {
      const section = readSection(document.text, heading);
      if (section !== null) return { text: section, source: document.source };
    }
    return null;
  },

  /**
   * Compose a failure message with the copy-paste template appended.
   *
   * @param {object} options Resolved gate options.
   * @param {string} problem What is wrong.
   * @returns {string} Full message.
   */
  template(options, problem) {
    return (
      `${problem}\n`
      + `Add this to the commit body (or to a file in your evidence directory):\n`
      + `  ## ${options.heading}\n`
      + `  data: real\n`
      + `  success criteria: <the real content you confirmed, not "renders">\n`
      + `  url: <deployed address where you saw it>\n`
      + `Deferring is fine, as long as it is said out loud:\n`
      + `  PENDING-VERIFY: <what is still unverified>\n`
      + `  owner: <who verifies it>`
    );
  },
};
