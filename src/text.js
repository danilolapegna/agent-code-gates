/**
 * Shared text utilities for gate authors.
 *
 * These exist so that every gate agrees on what "annotated", "placeholder" and
 * "local URL" mean. When those definitions drift between gates, users learn
 * that the escape hatch works in one place and not another, and they stop
 * trusting the whole tool.
 *
 * @module text
 */

import { isCommentLine } from './languages.js';

/**
 * Values that look like a field was filled in but carry no information.
 * A gate that accepts `observed: TBD` is a gate that certifies nothing.
 */
const PLACEHOLDER_VALUES = /^(?:n\/?a|tbd|todo|none|null|nil|\?+|-+|\.{2,}|x+|<[^>]*>|your[-_ ].*|placeholder|example|changeme|fixme)$/i;

/** Hosts and ports that prove a page was opened on the author's own machine. */
const LOCAL_URL = /(?:^|\/\/|@)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[^/\s]*\.local)(?::\d+)?(?:[/:?#]|$)/i;

/** Ports that are conventionally a development server rather than a deployment. */
const DEV_PORT = /:(?:3000|3001|4000|4173|5000|5173|5174|8000|8080|8081|9000)\b/;

/** Words that are too generic to carry meaning in an overlap comparison. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'when',
  'then', 'than', 'they', 'them', 'their', 'have', 'has', 'was', 'were', 'are',
  'add', 'adds', 'added', 'make', 'made', 'use', 'used', 'using', 'via', 'per',
  'all', 'any', 'new', 'old', 'not', 'but', 'its', 'out', 'off', 'also',
]);

/**
 * Whether a line carries an inline escape annotation such as `SAFE-TODO:`.
 *
 * Annotations are matched anywhere on the line and are case-sensitive. Case
 * sensitivity is deliberate: `safe-todo` written in prose inside a sentence
 * should not disarm a gate, only a marker an author typed on purpose should.
 *
 * @param {string} line Raw source line.
 * @param {string} annotation Marker without the trailing colon, for example `SAFE-LOG`.
 * @returns {boolean} True when the annotation is present.
 */
export function hasAnnotation(line, annotation) {
  return line.includes(`${annotation}:`);
}

/**
 * Whether a finding at `index` is disarmed by an annotation on its own line or
 * on a dedicated comment line immediately above it.
 *
 * Allowing the line above matters for real code: the natural place to justify a
 * deliberate debug statement is a comment over it, not a trailing comment that
 * pushes the line past the formatter's width limit.
 *
 * The line above only counts when it is a comment and nothing else. Without
 * that condition an annotation trailing one statement would silently disarm the
 * next statement too, and an escape hatch with unintended reach is worse than
 * no escape hatch: it exempts things nobody meant to exempt.
 *
 * @param {string[]} lines All lines of the file, in order.
 * @param {number} index Zero-based index of the offending line.
 * @param {string} annotation Marker without the trailing colon.
 * @param {string} [filePath] Path used to pick comment syntax for the line above.
 * @returns {boolean} True when the finding is annotated.
 */
export function isAnnotated(lines, index, annotation, filePath = 'file.js') {
  if (hasAnnotation(lines[index] ?? '', annotation)) return true;
  if (index === 0) return false;
  const above = lines[index - 1] ?? '';
  return isCommentLine(above, filePath) && hasAnnotation(above, annotation);
}

/**
 * Whether a field value is a placeholder rather than real content.
 *
 * @param {string} value Trimmed field value.
 * @param {number} [minLength=3] Shortest value considered informative.
 * @returns {boolean} True when the value carries no information.
 */
export function isPlaceholderValue(value, minLength = 3) {
  const trimmed = (value ?? '').trim();
  if (trimmed.length < minLength) return true;
  return PLACEHOLDER_VALUES.test(trimmed);
}

/**
 * Whether a URL points at the author's own machine rather than a deployment.
 *
 * Both the hostname and the port are checked. A tunnel host on port 5173 is
 * still a development server as far as evidence quality is concerned, and an
 * author who has genuinely deployed to a custom port can say so in prose.
 *
 * @param {string} url Candidate URL.
 * @returns {boolean} True when the URL is local or a well-known dev server.
 */
export function isLocalUrl(url) {
  const value = (url ?? '').trim();
  if (value === '') return true;
  return LOCAL_URL.test(value) || DEV_PORT.test(value);
}

/**
 * Extract the first `http(s)` URL from a string.
 *
 * @param {string} value Any text.
 * @returns {string|null} The URL, or null when the text contains none.
 */
export function firstUrl(value) {
  const match = (value ?? '').match(/https?:\/\/[^\s<>()"']+/i);
  return match ? match[0] : null;
}

/**
 * Read a `key: value` field out of a block of text.
 *
 * Tolerates a leading list bullet and either underscore or hyphen or space in
 * the key, because evidence blocks are written by humans under time pressure
 * and rejecting `- success-criteria:` while accepting `success_criteria:`
 * teaches nothing except that the tool is fussy.
 *
 * @param {string} text Block to search.
 * @param {string} key Field name; separators inside it are matched loosely.
 * @returns {string|null} The trimmed value, or null when the field is absent.
 */
export function readField(text, key) {
  const loose = key.replace(/[-_ ]/g, '[-_ ]');
  const pattern = new RegExp(`^\\s*(?:[-*+]\\s*)?${loose}\\s*:\\s*(.+?)\\s*$`, 'im');
  const match = (text ?? '').match(pattern);
  return match ? match[1].trim() : null;
}

/**
 * Extract a markdown section body, from a `## Heading` to the next heading of
 * the same or higher level.
 *
 * @param {string} text Markdown document or commit message.
 * @param {string} heading Heading text without leading hashes.
 * @returns {string|null} Section body, or null when the heading is absent.
 */
export function readSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = new RegExp(`^\\s{0,3}#{1,6}\\s+${escaped}\\s*$`, 'im');
  const match = (text ?? '').match(start);
  if (!match || match.index === undefined) return null;
  const after = text.slice(match.index + match[0].length);
  const nextHeading = after.match(/^\s{0,3}#{1,6}\s+\S/m);
  return nextHeading && nextHeading.index !== undefined ? after.slice(0, nextHeading.index) : after;
}

/**
 * Reduce a phrase to its significant lowercase words, for overlap comparison.
 *
 * @param {string} value Any phrase.
 * @returns {Set<string>} Words of three or more characters, stop words removed.
 */
export function significantWords(value) {
  const words = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  return new Set(words);
}

/**
 * Fraction of `expected`'s significant words that also appear in `candidate`.
 *
 * Directional on purpose: a commit line may say much more than the plan item
 * it reports on, and that should still count as a match. The reverse (a plan
 * item saying much more than the line) should not.
 *
 * @param {string} expected Reference phrase, for example a plan item.
 * @param {string} candidate Phrase to test, for example a commit body line.
 * @returns {number} Value between 0 and 1; 0 when `expected` has no words.
 */
export function wordOverlap(expected, candidate) {
  const wanted = significantWords(expected);
  if (wanted.size === 0) return 0;
  const found = significantWords(candidate);
  let hits = 0;
  for (const word of wanted) if (found.has(word)) hits += 1;
  return hits / wanted.size;
}

/**
 * Shorten a line for display in a findings list.
 *
 * @param {string} line Raw line.
 * @param {number} [max=120] Maximum length before truncation.
 * @returns {string} Trimmed, length-capped excerpt.
 */
export function excerpt(line, max = 120) {
  const trimmed = (line ?? '').trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 3)}...`;
}
