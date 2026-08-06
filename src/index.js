/**
 * Public programmatic API.
 *
 * The command line is a thin wrapper over these exports. Anything the CLI can
 * do is available to a script, a CI step or a custom review bot, and the gate
 * contract is the same in both directions: your own gate object dropped into
 * `runGates` behaves exactly like a built-in one.
 *
 * @example
 * import { buildContext, loadConfig, runGates, renderJson } from 'agent-code-gates';
 *
 * const { config } = loadConfig(process.cwd());
 * const ctx = buildContext({ cwd: process.cwd(), mode: 'commit', ref: 'HEAD', config });
 * const run = await runGates(ctx);
 * console.log(renderJson(run));
 *
 * @module agent-code-gates
 */

export { buildContext, parseSkipDirectives, SKIP_DIRECTIVE } from './context.js';
export {
  loadConfig,
  resolveConfig,
  defaultConfig,
  effectiveIgnore,
  ConfigError,
  CONFIG_FILENAME,
  SEVERITIES,
} from './config.js';
export { runGates } from './runner.js';
export { renderHuman, renderJson, renderList, exitCodeFor, shouldUseColor } from './report.js';
export { gateRegistry, findGate, gateIds } from './gates/index.js';
export { installHook, hooksDirectory, hookCommand, renderHook, HOOK_NAME } from './hooks.js';
export { git, gitSafe, repoRoot, parseAddedLines, parseNameStatus, parseNumstat, GitError } from './git.js';
export { globToRegExp, matchesGlob, matchesAnyGlob } from './glob.js';
export {
  hasAnnotation,
  isAnnotated,
  isPlaceholderValue,
  isLocalUrl,
  firstUrl,
  readField,
  readSection,
  wordOverlap,
  significantWords,
  excerpt,
} from './text.js';
export { isCommentLine, isSourceFile, isTestFile, extensionOf, commentPrefixesFor } from './languages.js';
