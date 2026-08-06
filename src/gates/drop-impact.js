/**
 * DROP_IMPACT: something was deleted and the callers were left behind.
 *
 * Deleting is the operation agents are worst at, because the evidence that a
 * deletion is safe lives everywhere except the file being deleted. The usual
 * shape is: remove a module, fix whatever the type checker complains about,
 * declare it done. Dynamic references, string-keyed lookups, tests and
 * untyped call sites survive, and they fail at runtime rather than at build
 * time, which is to say they fail in front of a user.
 *
 * Two searches run for every removed path. Import specifiers are *resolved*
 * against the importing file rather than string-matched, so deleting
 * `src/lib/utils.ts` does not flag every other `./utils` in the repository.
 * Exported symbols are matched as whole words, and any symbol that is still
 * defined somewhere else is dropped from the search entirely, which is what
 * makes a move-and-rename land clean instead of drowning in noise.
 *
 * @module gates/drop-impact
 */

import path from 'node:path';
import { excerpt } from '../text.js';
import { isCommentLine, extensionOf } from '../languages.js';
import { matchesAnyGlob } from '../glob.js';

/** Exported-symbol declarations, per language family. */
const EXPORT_DECLARATIONS = [
  /^\s*export\s+(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm,
  /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm,
  /^class\s+([A-Za-z_][\w]*)/gm,
  /^\s*pub\s+(?:fn|struct|enum|trait|const)\s+([A-Za-z_][\w]*)/gm,
  /^\s*func\s+([A-Z][\w]*)/gm,
  /^\s*public\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][\w]*)/gm,
];

/** Re-export lists: `export { a, b as c }`. The consumer-visible name is what matters. */
const EXPORT_LIST = /^\s*export\s*\{([^}]*)\}/gm;

/** Any declaration of a name, used to prove a symbol still exists elsewhere. */
function definitionPattern(symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:export\\s+(?:async\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${escaped}\\b`
    + `|(?:async\\s+)?function\\s+${escaped}\\b`
    + `|class\\s+${escaped}\\b`
    + `|(?:async\\s+)?def\\s+${escaped}\\b`
    + `|(?:const|let|var)\\s+${escaped}\\s*[=:]`
    + `|\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()`
    + `|fn\\s+${escaped}\\b`
    + `|func\\s+${escaped}\\b`
    + `|exports\\.${escaped}\\s*=`
    + `|\\b${escaped}\\s+as\\b)`,
  );
}

/** Import specifier forms this gate understands. */
const SPECIFIER_PATTERNS = [
  /(?:^|[^\w.])from\s+['"]([^'"\n]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /^\s*import\s+['"]([^'"\n]+)['"]/gm,
  /^\s*from\s+([\w.]+)\s+import\b/gm,
  /^\s*import\s+([\w.]+)\s*$/gm,
];

/**
 * Strip a file extension and a trailing `/index` segment.
 *
 * Module identity ignores both: `./foo`, `./foo.js` and `./foo/index.js` all
 * name the same module to a bundler, and treating them as different is how a
 * reference search misses the reference that matters.
 *
 * @param {string} modulePath Repo-relative path.
 * @returns {string} Normalised module identity.
 */
function moduleIdentity(modulePath) {
  const withoutExtension = modulePath.replace(/\.[A-Za-z0-9]+$/, '');
  return withoutExtension.replace(/\/index$/, '');
}

/**
 * Resolve an import specifier to a repo-relative module identity.
 *
 * Relative specifiers resolve exactly. Bare and aliased specifiers cannot be
 * resolved without reading the project's module resolution config, so they are
 * returned as a tail to be compared by suffix, which is precise enough in
 * practice and never invents a match out of a single shared segment.
 *
 * @param {string} specifier The literal inside the import.
 * @param {string} fromFile Repo-relative path of the importing file.
 * @returns {{exact: string|null, tail: string}} Resolution result.
 */
function resolveSpecifier(specifier, fromFile) {
  const normalised = specifier.includes('/') || !specifier.includes('.')
    ? specifier
    : specifier.replace(/\./g, '/');

  if (normalised.startsWith('.')) {
    const joined = path.posix.join(path.posix.dirname(fromFile), normalised);
    return { exact: moduleIdentity(path.posix.normalize(joined)), tail: '' };
  }
  const withoutAlias = normalised.replace(/^(?:@|~|#)\/?/, '').replace(/^src\//, '');
  return { exact: null, tail: moduleIdentity(withoutAlias) };
}

/**
 * Collect the symbols a removed file exported.
 *
 * @param {string} source Content of the file before deletion.
 * @param {number} minLength Shortest symbol worth searching for.
 * @param {Set<string>} stopList Names too generic to search for.
 * @returns {Set<string>} Exported names.
 */
function exportedSymbols(source, minLength, stopList) {
  const symbols = new Set();
  const add = (name) => {
    const clean = name.trim();
    if (clean.length >= minLength && !stopList.has(clean.toLowerCase())) symbols.add(clean);
  };

  for (const pattern of EXPORT_DECLARATIONS) {
    for (const match of source.matchAll(pattern)) add(match[1]);
  }
  for (const match of source.matchAll(EXPORT_LIST)) {
    for (const entry of match[1].split(',')) {
      const parts = entry.trim().split(/\s+as\s+/);
      const visible = parts[parts.length - 1];
      if (visible) add(visible.replace(/[^\w$]/g, ''));
    }
  }
  return symbols;
}

export default {
  id: 'DROP_IMPACT',
  title: 'Deleted code still referenced',
  description: 'Files or exported symbols removed by this change that other code still calls.',
  severity: 'error',

  defaults: {
    /** Shortest exported symbol searched for; short names collide with everything. */
    minSymbolLength: 4,
    /** Symbol names too generic to search for, matched case-insensitively. */
    ignoreSymbols: [
      'index', 'main', 'default', 'config', 'options', 'data', 'value', 'type',
      'error', 'handler', 'render', 'init', 'setup', 'name', 'item', 'items',
      'create', 'update', 'delete', 'list', 'get', 'set', 'run', 'test', 'state',
    ],
    /** When true, references inside documentation also count as breakage. */
    includeDocs: false,
    /** Paths whose deletion is never checked. */
    exclude: ['**/_archive/**', '**/*.bak', '**/*.old'],
    /** Findings reported per removed path before the list is truncated. */
    maxFindingsPerPath: 6,
  },

  /**
   * Relevant when the change removes a path, whether by deletion or rename.
   *
   * @param {object} ctx Gate context.
   * @returns {boolean} True when at least one path stops existing.
   */
  appliesTo(ctx) {
    return ctx.changedFiles.some((file) => file.status === 'D' || file.status === 'R');
  },

  /**
   * @param {object} ctx Gate context.
   * @returns {{status: string, message: string, findings: object[]}} Gate result.
   */
  run(ctx) {
    const options = ctx.config.gates[this.id];
    const stopList = new Set(options.ignoreSymbols.map((name) => name.toLowerCase()));

    const removed = ctx.changedFiles
      .filter((file) => file.status === 'D' || file.status === 'R')
      .map((file) => ({
        path: file.status === 'R' ? file.oldPath : file.path,
        renamed: file.status === 'R',
      }))
      .filter((entry) => entry.path && !matchesAnyGlob(entry.path, options.exclude));

    if (removed.length === 0) {
      return { status: 'pass', message: 'no tracked paths removed outside excluded directories', findings: [] };
    }

    const survivors = ctx.listRepoFiles().filter((file) => {
      if (!options.includeDocs && extensionOf(file) === '.md') return false;
      return ctx.isSourcePath(file) || extensionOf(file) === '.md';
    });

    // A symbol that still has a definition somewhere is not an orphan; it moved.
    const symbolTargets = new Map();
    for (const entry of removed) {
      if (entry.renamed) continue;
      const before = ctx.readFileBefore(entry.path);
      for (const symbol of exportedSymbols(before, options.minSymbolLength, stopList)) {
        if (!symbolTargets.has(symbol)) symbolTargets.set(symbol, entry.path);
      }
    }
    for (const symbol of [...symbolTargets.keys()]) {
      const stillDefined = survivors.some((file) => {
        const content = ctx.readTracked(file);
        return content.includes(symbol) && definitionPattern(symbol).test(content);
      });
      if (stillDefined) symbolTargets.delete(symbol);
    }

    const removedIdentities = new Map(removed.map((entry) => [moduleIdentity(entry.path), entry.path]));
    const findings = [];
    const perPath = new Map();

    const record = (finding) => {
      const seen = perPath.get(finding.owner) ?? 0;
      if (seen >= options.maxFindingsPerPath) return;
      perPath.set(finding.owner, seen + 1);
      findings.push(finding);
    };

    for (const file of survivors) {
      if (removedIdentities.has(moduleIdentity(file))) continue;
      const content = ctx.readTracked(file);
      if (content === '') continue;
      const lines = content.split('\n');

      for (const pattern of SPECIFIER_PATTERNS) {
        for (const match of content.matchAll(pattern)) {
          const { exact, tail } = resolveSpecifier(match[1], file);
          const hit = exact !== null
            ? removedIdentities.get(exact)
            : [...removedIdentities.entries()].find(
              ([identity]) => tail !== '' && (identity === tail || identity.endsWith(`/${tail}`)),
            )?.[1];
          if (!hit) continue;
          const line = lineNumberOf(lines, match[0]);
          record({
            owner: hit,
            file,
            line,
            excerpt: excerpt(lines[line - 1] ?? match[0]),
            detail: `imports ${hit}, which this change removes`,
          });
        }
      }

      for (const [symbol, source] of symbolTargets) {
        if (!content.includes(symbol)) continue;
        const wordPattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        const index = lines.findIndex((line) => wordPattern.test(line) && !isCommentLine(line, file));
        if (index === -1) continue;
        record({
          owner: source,
          file,
          line: index + 1,
          excerpt: excerpt(lines[index]),
          detail: `references "${symbol}", exported by the removed ${source}`,
        });
      }
    }

    if (findings.length === 0) {
      return {
        status: 'pass',
        message: `${removed.length} path(s) removed, no surviving references found`,
        findings: [],
      };
    }

    return {
      status: 'fail',
      message:
        `${findings.length} surviving reference(s) to code this change removes. ` +
        `Update or delete each call site in this same commit: a reference to something that no ` +
        `longer exists fails at run time, not at build time.`,
      findings: findings.map(({ owner, ...finding }) => finding),
    };
  },
};

/**
 * Find the one-based line number of the first line containing a fragment.
 *
 * @param {string[]} lines File lines.
 * @param {string} fragment Text to locate.
 * @returns {number} Line number, or 1 when the fragment spans lines.
 */
function lineNumberOf(lines, fragment) {
  const head = fragment.split('\n')[0].trim();
  const index = lines.findIndex((line) => line.includes(head));
  return index === -1 ? 1 : index + 1;
}
