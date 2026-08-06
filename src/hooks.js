/**
 * Git hook installation.
 *
 * The hook is installed as `commit-msg`, not `pre-commit`, and that choice is
 * the whole design of this file.
 *
 * At `pre-commit` time the commit message does not exist yet. Git has staged
 * the tree but has not written the message anywhere a hook can read it, and
 * `.git/COMMIT_EDITMSG` still holds the *previous* commit's text. Five of the
 * twelve gates read the message: the release claim, the plan statuses, the
 * size justification, the evidence block, and the escape hatch itself. Running
 * them at `pre-commit` means judging the wrong text while appearing to work,
 * which is the exact failure mode this tool exists to prevent.
 *
 * At `commit-msg` time both inputs are final: the staged tree is what will be
 * committed, and git passes the real message file as the first argument. One
 * hook, both inputs, no stale reads. The cost is that the gates run a moment
 * later than a `pre-commit` hook would, which nobody notices.
 *
 * @module hooks
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitSafe } from './git.js';

/** Line that identifies a hook as ours, so we never clobber someone else's. */
const MANAGED_MARKER = '# managed by agent-code-gates';

/** Hook git invokes with the final message and the final staged tree. */
export const HOOK_NAME = 'commit-msg';

/**
 * Locate the directory git reads hooks from.
 *
 * `core.hooksPath` is respected because teams that centralise hooks have
 * usually done so deliberately, and silently writing to `.git/hooks` would
 * produce a hook that is never executed and a user who believes it is.
 *
 * @param {string} repoRoot Absolute repository root.
 * @returns {string} Absolute path to the hooks directory.
 */
export function hooksDirectory(repoRoot) {
  const configured = gitSafe(repoRoot, ['config', '--get', 'core.hooksPath']).trim();
  if (configured !== '') return path.resolve(repoRoot, configured);
  const gitDir = gitSafe(repoRoot, ['rev-parse', '--git-dir']).trim() || '.git';
  return path.resolve(repoRoot, gitDir, 'hooks');
}

/**
 * Build the command the hook should invoke.
 *
 * When the tool is a dependency of the repository, `npx --no-install` keeps the
 * hook portable across machines and pinned to the version in the lockfile.
 * When it is not, an absolute path is the only thing guaranteed to resolve
 * inside a hook, where `PATH` is frequently not the interactive shell's.
 *
 * @param {string} repoRoot Absolute repository root.
 * @returns {string} Shell command including the message-file argument.
 */
export function hookCommand(repoRoot) {
  const binary = fileURLToPath(new URL('../bin/agent-code-gates.js', import.meta.url));
  const localModules = path.join(repoRoot, 'node_modules');
  const isDependency = binary.startsWith(`${localModules}${path.sep}`);

  const invocation = isDependency
    ? 'npx --no-install agent-code-gates'
    : `node ${JSON.stringify(binary)}`;

  return `${invocation} --staged --message-file "$1"`;
}

/**
 * Render the hook script.
 *
 * `AGENT_CODE_GATES_SKIP=1` exists because a bypass will happen anyway, and an
 * escape hatch that is documented and visible in shell history is better than
 * `--no-verify`, which disables every hook the repository has.
 *
 * @param {string} repoRoot Absolute repository root.
 * @returns {string} Complete hook script.
 */
export function renderHook(repoRoot) {
  return [
    '#!/bin/sh',
    MANAGED_MARKER,
    '# Reinstall with: agent-code-gates --install-hooks',
    '# Bypass once:   AGENT_CODE_GATES_SKIP=1 git commit ...',
    '',
    'if [ "$AGENT_CODE_GATES_SKIP" = "1" ]; then',
    '  echo "agent-code-gates: skipped via AGENT_CODE_GATES_SKIP=1"',
    '  exit 0',
    'fi',
    '',
    `exec ${hookCommand(repoRoot)}`,
    '',
  ].join('\n');
}

/**
 * Install the hook.
 *
 * @param {string} repoRoot Absolute repository root.
 * @param {object} [options] Installation options.
 * @param {boolean} [options.force=false] Overwrite a hook this tool did not write.
 * @returns {{path: string, action: 'created'|'updated'|'unchanged'}} What happened.
 * @throws {Error} When an unmanaged hook is present and `force` is not set.
 */
export function installHook(repoRoot, { force = false } = {}) {
  const directory = hooksDirectory(repoRoot);
  const target = path.join(directory, HOOK_NAME);
  const contents = renderHook(repoRoot);

  fs.mkdirSync(directory, { recursive: true });

  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8');
    if (!existing.includes(MANAGED_MARKER) && !force) {
      throw new Error(
        `${target} already exists and was not written by agent-code-gates.\n`
        + 'Merge the two by hand, or pass --force to replace it. The line to add is:\n'
        + `  ${hookCommand(repoRoot)}`,
      );
    }
    if (existing === contents) return { path: target, action: 'unchanged' };
    fs.writeFileSync(target, contents, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    return { path: target, action: 'updated' };
  }

  fs.writeFileSync(target, contents, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
  return { path: target, action: 'created' };
}
