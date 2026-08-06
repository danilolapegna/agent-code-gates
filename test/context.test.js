import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, parseSkipDirectives } from '../src/context.js';
import { defaultConfig } from '../src/config.js';
import { TempRepo } from './fixtures/repo.js';

/**
 * Run a body against a fresh repository and always clean up after it.
 *
 * @param {(repo: TempRepo) => void} body Test body.
 * @returns {void}
 */
function withRepo(body) {
  const repo = TempRepo.create();
  try {
    body(repo);
  } finally {
    repo.destroy();
  }
}

test('staged mode reports the index, with real line numbers', () => {
  withRepo((repo) => {
    repo.write('src/a.js', 'const a = 1;\nconst b = 2;\n');
    repo.commit('chore: base');
    repo.write('src/a.js', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    repo.write('src/new.js', 'export const n = 1;\n');
    repo.stage();

    const ctx = buildContext({ cwd: repo.root, mode: 'staged', config: defaultConfig() });
    assert.equal(ctx.changedFiles.length, 2);
    assert.equal(ctx.changedFiles.find((file) => file.path === 'src/new.js').status, 'A');

    const added = ctx.addedLines.filter((line) => line.file === 'src/a.js');
    assert.equal(added.length, 1);
    assert.equal(added[0].line, 3);
    assert.equal(added[0].text, 'const c = 3;');
  });
});

test('staged mode has no commit message and says so', () => {
  withRepo((repo) => {
    repo.write('src/a.js', 'const a = 1;\n');
    repo.stage();
    const ctx = buildContext({ cwd: repo.root, mode: 'staged', config: defaultConfig() });
    assert.equal(ctx.hasCommitMessage, false);
  });
});

test('a message file supplies the message and drops git comment lines', () => {
  withRepo((repo) => {
    repo.write('src/a.js', 'const a = 1;\n');
    repo.stage();
    const messageFile = repo.messageFile('feat: thing\n\nbody line\n# Please enter the commit message\n');
    const ctx = buildContext({ cwd: repo.root, mode: 'staged', messageFile, config: defaultConfig() });
    assert.equal(ctx.hasCommitMessage, true);
    assert.equal(ctx.commitSubject, 'feat: thing');
    assert.match(ctx.commitBody, /body line/);
    assert.ok(!ctx.commitMessage.includes('Please enter'));
  });
});

test('commit mode reads a finished commit, including the very first one', () => {
  withRepo((repo) => {
    repo.write('src/a.js', 'const a = 1;\n');
    const sha = repo.commit('chore: first commit\n\nwith a body');

    const ctx = buildContext({ cwd: repo.root, mode: 'commit', ref: sha, config: defaultConfig() });
    assert.equal(ctx.changedFiles.length, 1);
    assert.equal(ctx.changedFiles[0].status, 'A');
    assert.equal(ctx.addedLines.length, 1);
    assert.equal(ctx.commitSubject, 'chore: first commit');
  });
});

test('deleted files expose their previous content', () => {
  withRepo((repo) => {
    repo.write('src/gone.js', 'export const gone = 1;\n');
    repo.commit('chore: base');
    repo.remove('src/gone.js');
    repo.stage();

    const ctx = buildContext({ cwd: repo.root, mode: 'staged', config: defaultConfig() });
    assert.equal(ctx.changedFiles[0].status, 'D');
    assert.match(ctx.readFileBefore('src/gone.js'), /export const gone/);
  });
});

test('renames are reported with the path they came from', () => {
  withRepo((repo) => {
    const body = Array.from({ length: 20 }, (unused, i) => `export const v${i} = ${i};`).join('\n');
    repo.write('src/old.js', body);
    repo.commit('chore: base');
    repo.remove('src/old.js');
    repo.write('src/new.js', body);
    repo.stage();

    const ctx = buildContext({ cwd: repo.root, mode: 'staged', config: defaultConfig() });
    const rename = ctx.changedFiles.find((file) => file.status === 'R');
    assert.ok(rename, 'expected a rename record');
    assert.equal(rename.oldPath, 'src/old.js');
    assert.equal(rename.path, 'src/new.js');
  });
});

test('ignored paths are filtered out of both files and lines', () => {
  withRepo((repo) => {
    repo.write('src/a.js', 'const a = 1;\n');
    repo.write('generated/big.js', 'const g = 1;\n');
    repo.stage();

    const config = defaultConfig();
    config.ignore = ['generated/**'];
    const ctx = buildContext({ cwd: repo.root, mode: 'staged', config });
    assert.deepEqual(ctx.changedFiles.map((file) => file.path), ['src/a.js']);
    assert.ok(ctx.addedLines.every((line) => line.file === 'src/a.js'));
  });
});

test('node_modules is ignored even when nobody configured it', () => {
  withRepo((repo) => {
    repo.write('node_modules/pkg/index.js', 'module.exports = 1;\n');
    repo.write('src/a.js', 'const a = 1;\n');
    repo.stage();
    const ctx = buildContext({ cwd: repo.root, mode: 'staged', config: defaultConfig() });
    assert.deepEqual(ctx.changedFiles.map((file) => file.path), ['src/a.js']);
  });
});

test('statistics count both sides of the change', () => {
  withRepo((repo) => {
    repo.write('src/a.js', 'one\ntwo\nthree\n');
    repo.commit('chore: base');
    repo.write('src/a.js', 'one\nchanged\nthree\nfour\n');
    repo.stage();
    const ctx = buildContext({ cwd: repo.root, mode: 'staged', config: defaultConfig() });
    assert.equal(ctx.stats.files, 1);
    assert.equal(ctx.stats.linesChanged, ctx.stats.insertions + ctx.stats.deletions);
    assert.ok(ctx.stats.insertions >= 2);
  });
});

test('a path with a space survives the round trip', () => {
  withRepo((repo) => {
    repo.write('src/my folder/a b.js', 'const a = 1;\n');
    repo.stage();
    const ctx = buildContext({ cwd: repo.root, mode: 'staged', config: defaultConfig() });
    assert.deepEqual(ctx.changedFiles.map((file) => file.path), ['src/my folder/a b.js']);
    assert.equal(ctx.addedLines[0].file, 'src/my folder/a b.js');
  });
});

test('an unresolvable revision is refused rather than read as an empty change', () => {
  withRepo((repo) => {
    repo.write('src/a.js', 'const a = 1;\n');
    repo.commit('chore: base');
    assert.throws(
      () => buildContext({ cwd: repo.root, mode: 'commit', ref: 'nope', config: defaultConfig() }),
      /does not resolve/,
    );
  });
});

test('skip directives are parsed with their reasons', () => {
  const directives = parseSkipDirectives([
    'fix: hotfix',
    '',
    'agent-code-gates-skip: TODO_DENSITY the tracker is down, filing tomorrow',
    '- agent-code-gates-skip: COMMIT_SIZE: generated client, one unit',
  ].join('\n'));

  assert.equal(directives.length, 2);
  assert.equal(directives[0].gate, 'TODO_DENSITY');
  assert.match(directives[0].reason, /tracker is down/);
  assert.equal(directives[1].gate, 'COMMIT_SIZE');
  assert.match(directives[1].reason, /generated client/);
});
