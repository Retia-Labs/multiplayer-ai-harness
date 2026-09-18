'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// The operator selects one immutable release directory. Requests never select a
// filesystem path or an external download destination.
class DesktopDownload {
  constructor(directory) {
    if (!directory) return;
    const root = fs.realpathSync(directory);
    const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
    const artifact = release.artifacts?.[0];
    if (release.platform !== 'darwin' || release.arch !== 'arm64' ||
        !/^\d+\.\d+\.\d+-alpha\.\d+$/.test(release.version) ||
        release.notarization !== 'not-performed' || release.signing !== 'no-verified-publisher' ||
        !/^[a-f0-9]{40}$/.test(release.commit) || release.artifacts?.length !== 1 ||
        artifact?.file !== `Plexus-${release.version}-mac-arm64-unnotarized.dmg` ||
        !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error('invalid_desktop_release');
    }
    const file = path.join(root, artifact.file);
    if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) throw new Error('invalid_desktop_artifact');
    const bytes = fs.readFileSync(file);
    if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      throw new Error('desktop_artifact_checksum_mismatch');
    }
    this.file = file;
    this.metadata = { available: true, version: release.version, platform: release.platform, arch: release.arch,
      signing: release.signing, notarization: release.notarization, commit: release.commit,
      file: artifact.file, bytes: artifact.bytes, sha256: artifact.sha256, url: '/api/desktop-download' };
  }

  handle(req, res, pathname, account) {
    res.setHeader('Cache-Control', 'private, no-store');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); return json(405, { error: 'method_not_allowed' }); }
    if (!account) return json(401, { error: 'unauthenticated' });
    if (pathname === '/api/desktop-release') return json(200, this.metadata || { available: false });
    if (!this.file) return json(404, { error: 'desktop_release_unavailable' });
    const stream = fs.createReadStream(this.file);
    stream.on('error', () => { if (!res.headersSent) json(503, { error: 'desktop_download_unavailable' }); else res.destroy(); });
    stream.on('open', () => {
      res.writeHead(200, { 'Content-Type': 'application/x-apple-diskimage', 'Content-Length': this.metadata.bytes,
        'Content-Disposition': `attachment; filename="${this.metadata.file}"`, 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') { stream.destroy(); res.end(); } else stream.pipe(res);
    });
    res.on('close', () => stream.destroy());
  }
}
module.exports = { DesktopDownload };
