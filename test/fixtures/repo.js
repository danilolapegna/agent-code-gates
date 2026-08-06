/**
 * Temporary git repositories for the integration tests.
 *
 * Context construction is the one part of this tool that cannot be tested with
 * a stub: its whole job is to ask git the right questions and parse the
 * answers. Those tests need a real repository, so this fixture makes one that
 * is cheap to create and guaranteed to be cleaned up.
 *
 * @module test/fixtures/repo
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * A disposable repository with helpers for staging and committing.
 */
export class TempRepo {
  /**
   * @param {string} root Absolute path of the repository.
   */
  constructor(root) {
    this.root = root;
  }

  /**
   * Create an initialised repository in a temporary directory.
   *
   * Identity and signing are configured locally so the fixture works on a
   * machine with commit signing enabled globally, where an unsigned test
   * commit would otherwise fail.
   *
   * @returns {TempRepo} The repository.
   */
  static create() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-code-gates-'));
    const repo = new TempRepo(fs.realpathSync(root));
    repo.git(['init', '-q', '-b', 'main']);
    repo.git(['config', 'user.name', 'Gate Fixture']);
    repo.git(['config', 'user.email', 'fixture@example.test']);
    repo.git(['config', 'commit.gpgsign', 'false']);
    return repo;
  }

  /**
   * Run git inside the repository.
   *
   * @param {string[]} args Git arguments.
   * @returns {string} Trimmed stdout.
   */
  git(args) {
    return execFileSync('git', args, { cwd: this.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }

  /**
   * Write a file, creating parent directories as needed.
   *
   * @param {string} relativePath Path inside the repository.
   * @param {string} content File content.
   * @returns {TempRepo} This repository, for chaining.
   */
  write(relativePath, content) {
    const target = path.join(this.root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return this;
  }

  /**
   * Delete a file from the working tree.
   *
   * @param {string} relativePath Path inside the repository.
   * @returns {TempRepo} This repository, for chaining.
   */
  remove(relativePath) {
    fs.rmSync(path.join(this.root, relativePath), { force: true });
    return this;
  }

  /**
   * Stage everything currently in the working tree.
   *
   * @returns {TempRepo} This repository, for chaining.
   */
  stage() {
    this.git(['add', '-A']);
    return this;
  }

  /**
   * Stage everything and commit it.
   *
   * @param {string} message Commit message.
   * @returns {string} The new commit's short hash.
   */
  commit(message) {
    this.stage();
    this.git(['commit', '-q', '--no-verify', '-m', message]);
    return this.git(['rev-parse', '--short', 'HEAD']);
  }

  /**
   * Write a commit message to a file, as git does for the commit-msg hook.
   *
   * @param {string} message Message text.
   * @returns {string} Absolute path of the message file.
   */
  messageFile(message) {
    const target = path.join(this.root, '.git', 'GATE_TEST_MSG');
    fs.writeFileSync(target, message);
    return target;
  }

  /** Remove the repository from disk. */
  destroy() {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
