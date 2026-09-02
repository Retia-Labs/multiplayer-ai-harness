/**
 * Reading and writing files inside a thread's workspace.
 *
 * Every path that arrives here came from the renderer, which means it came from
 * a place a person could type into. `safeResolve` is therefore the security
 * boundary of the editor, not a nicety: without it, opening a file called
 * ../../../.ssh/id_rsa works exactly as well as opening src/index.js.
 *
 * Kept free of Electron imports so it can be tested directly.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

/**
 * What a file looked like when we handed it to the editor.
 *
 * Content, not mtime. Filesystem timestamp resolution is coarse enough that an
 * agent edit landing in the same tick as the read is invisible to an mtime
 * comparison - which is precisely the case a conflict check exists to catch.
 */
const contentHash = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Files we will not offer to open, because opening them helps nobody. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', '__pycache__']);

const TEXT_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.scss',
  '.html', '.htm', '.xml', '.yml', '.yaml', '.toml', '.ini', '.env', '.sh', '.bash',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.php',
  '.sql', '.graphql', '.svg', '.vue', '.svelte', '.lock', '.gitignore', '.prisma'
]);

/** 1 MB. Past this an editor is the wrong tool and the renderer will choke. */
const MAX_BYTES = 1024 * 1024;

function isTextFile(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  // Extensionless files that are conventionally text (Makefile, LICENSE, Dockerfile).
  return ext === '' && /^[A-Za-z][A-Za-z.-]*$/.test(path.basename(rel));
}

/**
 * Resolve a workspace-relative path, refusing anything that escapes.
 *
 * Both sides are resolved before comparing, because on Windows the same
 * directory has several spellings (short names, differing case, a trailing
 * separator) and comparing the strings people typed would let some of them
 * through.
 */
function safeResolve(root, rel) {
  if (typeof rel !== 'string' || !rel.length) throw new Error('Path required');
  if (rel.includes('\0')) throw new Error('Invalid path');
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  const inside = abs === base || abs.startsWith(base + path.sep);
  if (!inside) throw new Error('Path escapes the workspace: ' + rel);
  return abs;
}

/**
 * The file tree, as a flat list of workspace-relative paths.
 *
 * Flat rather than nested because the renderer groups it anyway, and a flat
 * list is far easier to filter as someone types.
 */
function tree(root, { limit = 8000 } = {}) {
  const out = [];
  const base = path.resolve(root);

  const walk = (dir) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Directories first, then files, each alphabetically - the order every
    // file tree a developer has ever used puts them in.
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      return ad - bd || a.name.localeCompare(b.name);
    });
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.') && e.name !== '.gitignore' && e.name !== '.env.example') continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(base, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        out.push({ path: rel, dir: true });
        walk(abs);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          continue;
        }
        out.push({ path: rel, dir: false, size, text: isTextFile(rel) && size <= MAX_BYTES });
      }
    }
  };

  walk(base);
  return out;
}

function readFile(root, rel) {
  const abs = safeResolve(root, rel);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error('Not a file: ' + rel);
  if (stat.size > MAX_BYTES) {
    return { path: rel, tooLarge: true, size: stat.size, content: '' };
  }
  const buf = fs.readFileSync(abs);
  // A NUL byte in the first few KB is the cheap, reliable binary test. Handing
  // binary to a text editor produces a mess that is then saveable, which is
  // how an editor corrupts an image.
  if (buf.slice(0, 8000).includes(0)) {
    return { path: rel, binary: true, size: stat.size, content: '' };
  }
  const content = buf.toString('utf8');
  return {
    path: rel,
    content,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    hash: contentHash(content)
  };
}

/**
 * Write a file, refusing if it changed underneath us.
 *
 * The editor is not the only writer here - the agent is editing the same tree
 * at the same time. Saving over its work without noticing is the single most
 * annoying thing a multiplayer editor can do, so a stale write is reported
 * rather than performed.
 */
function writeFile(root, rel, content, { expectedHash = null } = {}) {
  const abs = safeResolve(root, rel);
  let current = null;
  try {
    current = fs.readFileSync(abs, 'utf8');
  } catch {
    current = null; // new file
  }
  // Only a caller that told us what it started from gets conflict protection.
  // A null expectedHash is an explicit "write it anyway", which is what the
  // editor sends once a person has chosen to overwrite.
  if (current !== null && expectedHash !== null && contentHash(current) !== expectedHash) {
    return { ok: false, stale: true, hash: contentHash(current) };
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  const after = fs.statSync(abs);
  return {
    ok: true,
    created: current === null,
    hash: contentHash(content),
    mtimeMs: after.mtimeMs,
    size: after.size
  };
}

/** Line counts for the artifact.changed event a save produces. */
function diffCounts(before, after) {
  if (before === null) return { added: after ? after.split('\n').length : 0, removed: 0 };
  const b = before.split('\n');
  const a = after.split('\n');
  const bSet = new Map();
  for (const line of b) bSet.set(line, (bSet.get(line) || 0) + 1);
  let added = 0;
  for (const line of a) {
    const n = bSet.get(line) || 0;
    if (n > 0) bSet.set(line, n - 1);
    else added += 1;
  }
  let removed = 0;
  for (const n of bSet.values()) removed += n;
  return { added, removed };
}

/** Files git knows about, used to rank the tree so real source sorts first. */
function tracked(root) {
  return new Promise((resolve) => {
    execFile('git', ['ls-files'], { cwd: root, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
    });
  });
}

module.exports = { safeResolve, tree, readFile, writeFile, diffCounts, tracked, isTextFile, contentHash, MAX_BYTES };
