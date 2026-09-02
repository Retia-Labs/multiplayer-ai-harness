const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(dir, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout || '', err: (stderr || (err && err.message)) || '' });
    });
  });
}

async function currentBranch(dir) {
  const r = await run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.out.trim() : null;
}

async function isDirty(dir) {
  const r = await run(dir, ['status', '--porcelain']);
  return r.ok ? r.out.trim().length > 0 : false;
}

async function status(dir) {
  const r = await run(dir, ['status', '--porcelain']);
  if (!r.ok) return null;
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
}

async function listFiles(dir) {
  const r = await run(dir, ['ls-files', '--cached', '--others', '--exclude-standard']);
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).slice(0, 5000);
}

// Working-tree diff (staged + unstaged + untracked files) parsed per file.
async function diff(dir) {
  const raw = await run(dir, ['diff', 'HEAD', '--no-color'], 30000);
  const untracked = await run(dir, ['ls-files', '--others', '--exclude-standard']);
  const files = raw.ok ? parseDiff(raw.out) : [];
  if (untracked.ok) {
    for (const p of untracked.out.split('\n').filter(Boolean)) {
      const content = await run(dir, ['diff', '--no-color', '--no-index', '/dev/null', p], 30000);
      if (content.out) {
        for (const f of parseDiff(content.out)) {
          f.status = 'added';
          f.untracked = true;
          files.push(f);
        }
      }
    }
  }
  return files;
}

// Full raw patch text (tracked changes + untracked as new-file diffs).
async function patchText(dir) {
  const raw = await run(dir, ['diff', 'HEAD', '--no-color'], 30000);
  let text = raw.ok ? raw.out : '';
  const untracked = await run(dir, ['ls-files', '--others', '--exclude-standard']);
  if (untracked.ok) {
    for (const p of untracked.out.split('\n').filter(Boolean)) {
      const content = await run(dir, ['diff', '--no-color', '--no-index', '/dev/null', p], 30000);
      if (content.out) text += content.out;
    }
  }
  return text;
}

async function commitAll(dir, message) {
  const add = await run(dir, ['add', '-A']);
  if (!add.ok) return { ok: false, error: add.err };
  const c = await run(dir, [
    '-c', 'user.name=Codex', '-c', 'user.email=codex@localhost',
    'commit', '-m', message || 'Changes from Codex'
  ]);
  return c.ok ? { ok: true, out: c.out.trim() } : { ok: false, error: c.err || c.out };
}

async function revertFile(dir, file, untracked) {
  if (untracked) {
    try {
      fs.rmSync(path.join(dir, file));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  const r = await run(dir, ['checkout', 'HEAD', '--', file]);
  return r.ok ? { ok: true } : { ok: false, error: r.err };
}

// ----- worktrees -----
async function createWorktree(projectDir, baseDir, threadId) {
  const wtDir = path.join(baseDir, 'worktrees', threadId);
  const branch = 'codex/' + threadId.replace(/^t_/, '').slice(0, 12);
  fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  const r = await run(projectDir, ['worktree', 'add', '-b', branch, wtDir], 30000);
  if (!r.ok) return { ok: false, error: r.err || r.out };
  return { ok: true, dir: wtDir, branch };
}

async function removeWorktree(projectDir, wtDir) {
  await run(projectDir, ['worktree', 'remove', '--force', wtDir], 30000);
  try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch {}
  await run(projectDir, ['worktree', 'prune']);
  return { ok: true };
}

function parseDiff(raw) {
  const files = [];
  let file = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/diff --git a\/(.*?) b\/(.*)$/);
      file = { path: m ? m[2] : line.slice(11), status: 'modified', additions: 0, deletions: 0, lines: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename ') || line.startsWith('Binary files')) continue;
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      file._old = m ? parseInt(m[1], 10) : 0;
      file._new = m ? parseInt(m[2], 10) : 0;
      file.lines.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      file.additions++;
      file.lines.push({ kind: 'add', text: line.slice(1), newLine: file._new++ });
    } else if (line.startsWith('-')) {
      file.deletions++;
      file.lines.push({ kind: 'del', text: line.slice(1), oldLine: file._old++ });
    } else {
      file.lines.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldLine: file._old++, newLine: file._new++ });
    }
  }
  for (const f of files) { delete f._old; delete f._new; }
  return files;
}

module.exports = {
  currentBranch, isDirty, status, diff, listFiles, patchText,
  commitAll, revertFile, createWorktree, removeWorktree
};
