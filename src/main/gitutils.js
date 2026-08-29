const { execFile } = require('child_process');

function run(dir, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

async function currentBranch(dir) {
  const out = await run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return out ? out.trim() : null;
}

async function isDirty(dir) {
  const out = await run(dir, ['status', '--porcelain']);
  return out ? out.trim().length > 0 : false;
}

async function status(dir) {
  const out = await run(dir, ['status', '--porcelain']);
  if (out === null) return null;
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
}

// Working-tree diff (staged + unstaged + untracked files) parsed per file.
async function diff(dir) {
  const raw = await run(dir, ['diff', 'HEAD', '--no-color'], 20000);
  const untrackedOut = await run(dir, ['ls-files', '--others', '--exclude-standard']);
  const files = raw === null ? [] : parseDiff(raw);
  if (untrackedOut) {
    for (const p of untrackedOut.split('\n').filter(Boolean)) {
      const content = await run(dir, ['diff', '--no-color', '--no-index', '/dev/null', p], 20000);
      if (content) {
        const parsed = parseDiff(content);
        for (const f of parsed) {
          f.status = 'added';
          files.push(f);
        }
      }
    }
  }
  return files;
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
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename ')) continue;
    if (line.startsWith('@@')) {
      file.lines.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      file.additions++;
      file.lines.push({ kind: 'add', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      file.deletions++;
      file.lines.push({ kind: 'del', text: line.slice(1) });
    } else {
      file.lines.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  return files;
}

module.exports = { currentBranch, isDirty, status, diff };
