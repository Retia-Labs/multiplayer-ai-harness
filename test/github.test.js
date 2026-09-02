/**
 * Tests for the GitHub layer.
 *
 * Everything here runs against real local git repositories - a bare repo acting
 * as "origin" and a clone of it - so push and remote-tracking are exercised for
 * real rather than mocked. Nothing touches the network or github.com.
 *
 * The gh-dependent paths are checked for how they FAIL, because on most
 * machines gh is either missing or unauthenticated, and an app that offers an
 * action it cannot perform is worse than one that says so up front.
 *
 * Run with: npm run test:github
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const gh = require('../src/main/github');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A bare "origin" plus a working clone, the shape every real repo has. */
function repoPair() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-gh-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(origin, { recursive: true });
  git(['init', '--bare', '-b', 'main'], origin);

  fs.mkdirSync(work, { recursive: true });
  git(['init', '-b', 'main'], work);
  git(['config', 'user.email', 't@t'], work);
  git(['config', 'user.name', 'Test'], work);
  fs.writeFileSync(path.join(work, 'README.md'), '# test\n');
  git(['add', '-A'], work);
  git(['commit', '-qm', 'init'], work);
  git(['remote', 'add', 'origin', origin], work);
  git(['push', '-q', '--set-upstream', 'origin', 'main'], work);
  return { root, origin, work };
}

/* ---------------- parsing what people paste ---------------- */

test('normalizeRepo accepts the forms people actually paste', () => {
  const expected = 'https://github.com/likalight/quorum.git';
  for (const input of [
    'likalight/quorum',
    'https://github.com/likalight/quorum',
    'https://github.com/likalight/quorum.git',
    'https://github.com/likalight/quorum/tree/main/src'
  ]) {
    assert.equal(gh.normalizeRepo(input).url, expected, 'should handle ' + input);
    assert.equal(gh.normalizeRepo(input).slug, 'likalight/quorum');
  }
  const ssh = gh.normalizeRepo('git@github.com:likalight/quorum.git');
  assert.equal(ssh.slug, 'likalight/quorum');
  assert.equal(ssh.url, 'git@github.com:likalight/quorum.git', 'an ssh remote is left alone');
});

test('normalizeRepo passes through other hosts and refuses nonsense', () => {
  assert.equal(gh.normalizeRepo('https://gitlab.com/a/b.git').slug, null, 'not every repo is on GitHub');
  assert.throws(() => gh.normalizeRepo(''), /required/);
  assert.throws(() => gh.normalizeRepo('just some words'), /does not look like a repository/);
});

/* ---------------- reading a workspace ---------------- */

test('repoInfo reports the remote, branch and whether it is pushed', async () => {
  const { work, origin } = repoPair();
  const info = await gh.repoInfo(work);
  assert.equal(info.branch, 'main');
  assert.equal(info.remote, origin);
  assert.equal(info.pushed, true);

  git(['checkout', '-q', '-b', 'quorum/feature'], work);
  const onBranch = await gh.repoInfo(work);
  assert.equal(onBranch.branch, 'quorum/feature');
  assert.equal(onBranch.pushed, false, 'a fresh branch has no upstream yet');
});

test('repoInfo returns null rather than throwing outside a repo', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plain-'));
  assert.equal(await gh.repoInfo(plain), null);
  assert.equal(await gh.repoInfo(path.join(plain, 'does-not-exist')), null);
});

/* ---------------- cloning ---------------- */

test('clone brings the code down and reports where it went', async () => {
  const { origin, root } = repoPair();
  const into = path.join(root, 'joiners-machine');
  const res = await gh.clone({ repo: origin, intoParent: into, name: 'project' });
  assert.equal(res.ok, true, res.error);
  assert.ok(fs.existsSync(path.join(res.dir, 'README.md')), 'the files are really there');
});

test('clone refuses to write over an existing folder', async () => {
  const { origin, root } = repoPair();
  const into = path.join(root, 'joiners-machine');
  fs.mkdirSync(path.join(into, 'project'), { recursive: true });
  fs.writeFileSync(path.join(into, 'project', 'my-work.txt'), 'do not delete me');

  const res = await gh.clone({ repo: origin, intoParent: into, name: 'project' });
  assert.equal(res.ok, false);
  assert.match(res.error, /already there/);
  assert.equal(
    fs.readFileSync(path.join(into, 'project', 'my-work.txt'), 'utf8'),
    'do not delete me',
    'somebody else\'s files must survive'
  );
});

test('clone reports a bad repository instead of hanging', async () => {
  const { root } = repoPair();
  const res = await gh.clone({
    repo: path.join(root, 'nothing-here.git'),
    intoParent: path.join(root, 'dest'),
    name: 'x'
  });
  assert.equal(res.ok, false);
  assert.ok(res.error && res.error.length, 'and says why');
});

/* ---------------- pushing ---------------- */

test('push sets upstream on a new branch and lands the commit', async () => {
  const { work, origin } = repoPair();
  git(['checkout', '-q', '-b', 'quorum/feature'], work);
  fs.writeFileSync(path.join(work, 'NOTES.md'), '# notes\n');
  git(['add', '-A'], work);
  git(['commit', '-qm', 'add notes'], work);

  const res = await gh.push(work);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.branch, 'quorum/feature');

  // The branch really exists on the other side.
  const remoteBranches = git(['branch', '--format=%(refname:short)'], origin).split('\n');
  assert.ok(remoteBranches.includes('quorum/feature'), 'origin has the branch');

  const after = await gh.repoInfo(work);
  assert.equal(after.pushed, true);
});

test('push refuses a detached HEAD with a reason a person can act on', async () => {
  const { work } = repoPair();
  const sha = git(['rev-parse', 'HEAD'], work);
  git(['checkout', '-q', sha], work);
  const res = await gh.push(work);
  assert.equal(res.ok, false);
  assert.match(res.error, /detached/);
});

test('push outside a repository fails cleanly', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plain2-'));
  const res = await gh.push(plain);
  assert.equal(res.ok, false);
  assert.match(res.error, /Not a git repository/);
});

/* ---------------- capabilities and honest degradation ---------------- */

test('capabilities reports what is actually usable here', async () => {
  const caps = await gh.capabilities();
  assert.equal(caps.git, true, 'git is required for any of this and is present');
  assert.equal(typeof caps.gh, 'boolean');
  // canOpenPr must never be true without both gh and auth, because the UI
  // enables the button from exactly this flag.
  if (caps.canOpenPr) {
    assert.equal(caps.gh, true);
    assert.equal(caps.authenticated, true);
  }
});

test('opening a PR without gh says so rather than failing silently', async () => {
  const { work } = repoPair();
  const caps = await gh.capabilities();
  const res = await gh.openPullRequest(work, { title: 'Test' });
  if (!caps.canOpenPr) {
    assert.equal(res.ok, false);
    assert.match(res.error, /gh|auth/i, 'the message names what is missing');
  } else {
    // gh is installed and authenticated, but this repo has no GitHub remote,
    // so it must still fail cleanly rather than inventing a pull request.
    assert.equal(res.ok, false);
    assert.ok(res.error.length, 'and explains itself');
  }
});

test('currentPullRequest is null rather than throwing when there is none', async () => {
  const { work } = repoPair();
  assert.equal(await gh.currentPullRequest(work), null);
});
