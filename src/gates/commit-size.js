/**
 * COMMIT_SIZE: changes too large to review, landing without a reason.
 *
 * Size is a proxy, not a defect, and this gate is deliberately calibrated as a
 * warning because of that. A 900-line commit is sometimes the honest shape of a
 * rename; blocking it would only teach people to reach for the bypass, and a
 * bypass reflex costs more than the occasional large commit.
 *
 * What the gate actually buys is a forced sentence. Writing "Why monolith: the
 * generated client and its call sites have to move together" takes ten seconds
 * and is the difference between a reviewer who knows what to look for and one
 * who scrolls. Teams that want it to block can set `severity: "error"`.
 *
 * @module gates/commit-size
 */

export default {
  id: 'COMMIT_SIZE',
  title: 'Oversized change without a stated reason',
  description: 'A change past the review budget with no explanation of why it must land as one unit.',
  severity: 'warning',
  needsCommitMessage: true,

  defaults: {
    /** Changed files past which a reason is expected. */
    maxFiles: 5,
    /** Insertions plus deletions past which a reason is expected. */
    maxLines: 500,
    /** Phrase that satisfies the gate; matched at the start of a line, case-insensitively. */
    justification: 'Why monolith:',
    /** Number of largest files listed in the findings. */
    listFiles: 8,
  },

  /**
   * Relevant whenever the change touches at least one file.
   *
   * @param {object} ctx Gate context.
   * @returns {boolean} True when there is a change to measure.
   */
  appliesTo(ctx) {
    return ctx.stats.files > 0;
  },

  /**
   * @param {object} ctx Gate context.
   * @returns {{status: string, message: string, findings: object[]}} Gate result.
   */
  run(ctx) {
    const options = ctx.config.gates[this.id];
    const { files, linesChanged } = ctx.stats;

    const overFiles = files > options.maxFiles;
    const overLines = linesChanged > options.maxLines;
    if (!overFiles && !overLines) {
      return {
        status: 'pass',
        message: `${files} file(s), ${linesChanged} line(s) changed, within the review budget`,
        findings: [],
      };
    }

    const label = options.justification.replace(/:$/, '');
    const heading = new RegExp(`^\\s{0,3}(?:#{1,6}\\s+)?${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?`, 'im');
    if (heading.test(ctx.commitMessage)) {
      return {
        status: 'pass',
        message: `${files} file(s), ${linesChanged} line(s) changed, and the commit explains why it lands as one unit`,
        findings: [],
      };
    }

    const exceeded = [
      overFiles ? `${files} files (budget ${options.maxFiles})` : null,
      overLines ? `${linesChanged} lines (budget ${options.maxLines})` : null,
    ].filter(Boolean);

    const findings = [...ctx.changedFiles]
      .sort((a, b) => (b.insertions + b.deletions) - (a.insertions + a.deletions))
      .slice(0, options.listFiles)
      .map((file) => ({
        file: file.path,
        line: null,
        excerpt: file.binary ? 'binary' : `+${file.insertions} -${file.deletions}`,
        detail: 'largest changes first, as split candidates',
      }));

    return {
      status: 'fail',
      message:
        `Change exceeds the review budget: ${exceeded.join(' and ')}. ` +
        `Split it, or add a line to the commit body starting with "${options.justification}" ` +
        `explaining what breaks if these pieces land separately.`,
      findings,
    };
  },
};
