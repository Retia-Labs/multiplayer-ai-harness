/**
 * GitHub, via the tools a developer already has.
 *
 * This shells out to `git` and to the `gh` CLI rather than talking to the API
 * directly, for one reason that matters more than elegance: authentication.
 * Anyone who would use this already has `gh auth login` done, or has a git
 * credential helper set up, and asking them to paste a personal access token
 * into a desktop app - which would then have to store it - is both worse
 * security and worse manners.
 *
 * Where `gh` is missing we degrade honestly: cloning and pushing still work
 * through plain git, and opening a pull request reports that it needs `gh`
 * rather than silently doing nothing.
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...opts },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: (stdout || '').trim(),
          stderr: (stderr || '').trim()
        });
      }
    );
  });
}

/** What tooling is actually available, so the UI can offer only what works. */
async function capabilities() {
  const [git, gh] = await Promise.all([run('git', ['--version']), run('gh', ['--version'])]);
  let authed = false;
  let login = null;
  if (gh.ok) {
    const status = await run('gh', ['auth', 'status']);
    authed = status.ok;
    const who = await run('gh', ['api', 'user', '-q', '.login']);
    if (who.ok) login = who.stdout;
  }
  return {
    git: git.ok,
    gh: gh.ok,
    authenticated: authed,
    login,
    // Without gh we can still clone and push; only PR creation is lost.
    canOpenPr: gh.ok && authed
  };
}

/**
 * Normalise whatever someone pastes into something git can clone.
 *
 * People paste browser URLs, `owner/repo`, and SSH remotes interchangeably, and
 * refusing any of them is a pointless bit of friction.
 */
function normalizeRepo(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('A repository is required');
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return { url: 'https://github.com/' + raw + '.git', slug: raw };
  const https = raw.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i);
  if (https) return { url: 'https://github.com/' + https[1] + '/' + https[2] + '.git', slug: https[1] + '/' + https[2] };
  const ssh = raw.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (ssh) return { url: raw, slug: ssh[1] + '/' + ssh[2] };
  if (/^https?:\/\//.test(raw)) return { url: raw, slug: null }; // some other host, fine
  if (/^(?:ssh|git|file):\/\//.test(raw)) return { url: raw, slug: null };
  // A path on this machine. Git clones from one perfectly well, and it is how
  // a bare repo on a shared drive - or a test - is used.
  if (path.isAbsolute(raw) || raw.startsWith('.')) {
    return { url: raw, slug: null, local: true };
  }
  throw new Error('That does not look like a repository: ' + raw);
}

/** Where this workspace came from, if anywhere. */
async function repoInfo(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const [remote, branch, upstream] = await Promise.all([
    run('git', ['remote', 'get-url', 'origin'], { cwd: dir }),
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }),
    run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: dir })
  ]);
  if (!branch.ok) return null;
  let slug = null;
  if (remote.ok) {
    try {
      slug = normalizeRepo(remote.stdout).slug;
    } catch {
      slug = null;
    }
  }
  return {
    remote: remote.ok ? remote.stdout : null,
    slug,
    branch: branch.stdout,
    upstream: upstream.ok ? upstream.stdout : null,
    pushed: upstream.ok
  };
}

/**
 * Clone a repository so this machine has the code.
 *
 * This is how somebody who joined a run gets a workspace of their own: the room
 * carries which repository and branch the run is on, and the joiner clones it
 * rather than being handed files over the wire. Git is already extremely good
 * at moving source code between machines; rebuilding that badly inside a chat
 * protocol would be the wrong instinct.
 */
async function clone({ repo, intoParent, name, branch }) {
  // Every other failure here comes back as a result, so an unparseable
  // repository should too - a caller that has to handle one style of failure
  // for a bad URL and another for a bad network is a caller that handles
  // neither properly.
  let parsed;
  try {
    parsed = normalizeRepo(repo);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  const { url, slug } = parsed;
  const folder = name || (slug ? slug.split('/')[1] : path.basename(String(url).replace(/\.git$/, '')) || 'repo');
  const target = path.join(intoParent, folder);

  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    // Never clone over somebody's existing folder.
    return { ok: false, error: 'A folder called ' + folder + ' is already there.', dir: target };
  }
  fs.mkdirSync(intoParent, { recursive: true });

  const args = ['clone', '--progress'];
  if (branch) args.push('--branch', branch);
  args.push(url, target);

  const res = await run('git', args, { cwd: intoParent });
  if (!res.ok) {
    return { ok: false, error: firstUsefulLine(res.stderr) || 'Clone failed', dir: target };
  }
  return { ok: true, dir: target, slug, url };
}

/** Push the current branch, setting upstream the first time. */
async function push(dir, { branch } = {}) {
  const info = await repoInfo(dir);
  if (!info) return { ok: false, error: 'Not a git repository' };
  const target = branch || info.branch;
  if (target === 'HEAD') return { ok: false, error: 'This checkout is detached; make a branch first' };

  const res = await run('git', ['push', '--set-upstream', 'origin', target], { cwd: dir });
  if (!res.ok) return { ok: false, error: firstUsefulLine(res.stderr) || 'Push failed' };
  return { ok: true, branch: target, output: firstUsefulLine(res.stderr) };
}

/**
 * Open a pull request for the work in this session.
 *
 * The body names the session deliberately. A run that produced this branch has
 * a hash-chained record of who asked for what and who approved each risky step,
 * and a reviewer who knows that record exists can ask for it.
 */
async function openPullRequest(dir, { title, body, base, draft = false, sessionId } = {}) {
  const caps = await capabilities();
  if (!caps.gh) return { ok: false, error: 'The GitHub CLI (gh) is not installed.' };
  if (!caps.authenticated) return { ok: false, error: 'Run `gh auth login` first.' };

  const info = await repoInfo(dir);
  if (!info) return { ok: false, error: 'Not a git repository' };
  if (!info.pushed) {
    const pushed = await push(dir);
    if (!pushed.ok) return pushed;
  }

  const fullBody =
    (body || '') +
    (sessionId ? '\n\n---\nProduced in Quorum session `' + sessionId + '`.' : '');

  const args = ['pr', 'create', '--title', title || info.branch, '--body', fullBody || 'Opened from Quorum.'];
  if (base) args.push('--base', base);
  if (draft) args.push('--draft');

  const res = await run('gh', args, { cwd: dir });
  if (!res.ok) {
    const why = firstUsefulLine(res.stderr) || 'Could not open the pull request';
    // gh says this plainly and it is worth passing through rather than dressing up.
    return { ok: false, error: why };
  }
  const url = (res.stdout.match(/https:\/\/\S+/) || [])[0] || res.stdout;
  return { ok: true, url };
}

/** Existing PR for this branch, if there is one. */
async function currentPullRequest(dir) {
  const caps = await capabilities();
  if (!caps.canOpenPr) return null;
  const res = await run('gh', ['pr', 'view', '--json', 'url,number,state,title'], { cwd: dir });
  if (!res.ok) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

/** git and gh are chatty on stderr; surface the line a person can act on. */
function firstUsefulLine(text) {
  if (!text) return '';
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^(remote:|Enumerating|Counting|Compressing|Writing|Total|Receiving|Resolving|Updating)/i.test(l));
  return lines.find((l) => /error|fatal|denied|not found|forbidden|already exists/i.test(l)) || lines[0] || '';
}

module.exports = { capabilities, normalizeRepo, repoInfo, clone, push, openPullRequest, currentPullRequest };
