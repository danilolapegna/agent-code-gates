/**
 * Minimal, dependency-free glob matching for repo-relative POSIX paths.
 *
 * A full glob library would be a runtime dependency, and a runtime dependency
 * in a tool that runs inside a git hook is a supply-chain surface plus an
 * install-time failure mode. The subset implemented here covers every path
 * pattern the gates actually need, and nothing else:
 *
 *   `*`   matches any run of characters except `/`
 *   `**`  matches any run of characters including `/`
 *   `?`   matches exactly one character except `/`
 *
 * Anything else is treated as a literal, so a pattern that looks like a regex
 * behaves like a filename rather than silently matching too much.
 *
 * @module glob
 */

/** Regex metacharacters that must survive as literals inside a compiled glob. */
const REGEX_SPECIALS = new Set([...'\\^$.|+()[]{}']);

/** Compiled-pattern cache. Gates re-test the same globs against every changed file. */
const cache = new Map();

/**
 * Compile a glob pattern into an anchored regular expression.
 *
 * `**` is handled in two forms because they mean different things to a reader:
 * `**` followed by `/` should also match zero directory levels (so
 * `**\/*.sql` matches `a.sql` as well as `db/a.sql`), while a trailing `**`
 * should swallow the remainder of the path.
 *
 * @param {string} pattern Glob pattern using POSIX separators.
 * @returns {RegExp} Anchored expression that matches a whole path.
 */
export function globToRegExp(pattern) {
  const cached = cache.get(pattern);
  if (cached) return cached;

  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          source += '(?:[^/]*/)*';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += REGEX_SPECIALS.has(char) ? `\\${char}` : char;
  }

  const compiled = new RegExp(`^${source}$`);
  cache.set(pattern, compiled);
  return compiled;
}

/**
 * Test one repo-relative path against a glob.
 *
 * @param {string} filePath Repo-relative path with `/` separators.
 * @param {string} pattern Glob pattern.
 * @returns {boolean} True when the whole path matches.
 */
export function matchesGlob(filePath, pattern) {
  return globToRegExp(pattern).test(filePath);
}

/**
 * Test one path against a list of globs.
 *
 * An empty or missing list returns `false` rather than "matches everything",
 * because every caller here uses these lists as opt-in filters and an empty
 * filter that matched all paths would silently widen a gate's blast radius.
 *
 * @param {string} filePath Repo-relative path.
 * @param {string[]} [patterns] Glob patterns.
 * @returns {boolean} True when at least one pattern matches.
 */
export function matchesAnyGlob(filePath, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  return patterns.some((pattern) => matchesGlob(filePath, pattern));
}
