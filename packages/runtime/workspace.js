'use strict';
// Filesystem capability for one operator-authorized workspace. Callers provide only
// relative paths; every component is checked without following symlinks. Writes replace
// the destination atomically so a workspace hard link is not used to modify another file.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_READ_BYTES = 2 * 1024 * 1024;

function refusal(detail) {
  const err = new Error('project_not_authorized: ' + detail);
  err.code = 'project_not_authorized';
  return err;
}

function components(relPath, { allowRoot = false } = {}) {
  if (typeof relPath !== 'string' || relPath.includes('\0') || path.isAbsolute(relPath)) {
    throw refusal('workspace tools require a relative path');
  }
  const parts = relPath.split(/[\\/]+/).filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) throw refusal('path traversal is outside the authorized workspace');
  if (parts.some((part) => part.toLowerCase() === '.git')) {
    throw refusal('Git metadata is outside the workspace capability');
  }
  if (!parts.length && !allowRoot) throw refusal('the workspace root is not a file target');
  return parts;
}

class WorkspaceAccess {
  constructor(root) {
    const resolved = fs.realpathSync(path.resolve(root));
    if (!fs.statSync(resolved).isDirectory()) throw refusal('authorized workspace is not a directory');
    this.root = resolved;
  }

  inspect(relPath, { allowMissing = false, allowRoot = false } = {}) {
    const parts = components(relPath, { allowRoot });
    let current = this.root;
    let missing = false;
    for (const part of parts) {
      current = path.join(current, part);
      if (missing) continue;
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (err) {
        if (err && err.code === 'ENOENT' && allowMissing) { missing = true; continue; }
        throw err;
      }
      if (stat.isSymbolicLink()) throw refusal('symbolic links are outside the workspace capability');
    }
    const relative = path.relative(this.root, current);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw refusal('path is outside the authorized workspace');
    return { path: current, relative: relative || '.', missing };
  }

  ensureParent(relPath) {
    const parts = components(relPath);
    let current = this.root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw refusal('a parent is not an authorized directory');
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
        fs.mkdirSync(current, { mode: 0o755 });
        const created = fs.lstatSync(current);
        if (created.isSymbolicLink() || !created.isDirectory()) throw refusal('a parent is not an authorized directory');
      }
    }
    return this.inspect(relPath, { allowMissing: true });
  }

  readFile(relPath) {
    const target = this.inspect(relPath);
    const stat = fs.lstatSync(target.path);
    if (!stat.isFile()) throw refusal('read target is not a regular file');
    if (stat.size > MAX_READ_BYTES) throw refusal('file is too large for the workspace reader');
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const fd = fs.openSync(target.path, fs.constants.O_RDONLY | noFollow);
    try { return fs.readFileSync(fd, 'utf8'); }
    finally { fs.closeSync(fd); }
  }

  list(relPath = '.') {
    const target = this.inspect(relPath, { allowRoot: true });
    const stat = fs.lstatSync(target.path);
    if (!stat.isDirectory()) throw refusal('list target is not a directory');
    return fs.readdirSync(target.path, { withFileTypes: true }).slice(0, 1000).map((entry) => ({
      name: entry.name,
      type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
    }));
  }

  writeFile(relPath, content) {
    const target = this.ensureParent(relPath);
    let mode = 0o644;
    if (!target.missing) {
      const stat = fs.lstatSync(target.path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw refusal('write target is not a regular workspace file');
      mode = stat.mode & 0o777;
    }
    const parent = path.dirname(target.path);
    const temp = path.join(parent, `.plexus-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temp, content, { encoding: 'utf8', mode, flag: 'wx' });
      if (process.platform === 'win32' && !target.missing) fs.unlinkSync(target.path);
      fs.renameSync(temp, target.path);
    } catch (err) {
      try { fs.unlinkSync(temp); } catch {}
      throw err;
    }
    return target.relative;
  }

  remove(relPath) {
    const target = this.inspect(relPath);
    fs.rmSync(target.path, { recursive: true, force: false });
    return target.relative;
  }
}

module.exports = { WorkspaceAccess };
