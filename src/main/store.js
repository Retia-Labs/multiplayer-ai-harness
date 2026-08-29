const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  theme: 'dark',
  model: 'gpt-5.1-codex',
  mode: 'agent', // 'read-only' | 'agent' | 'full-access'
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  recentProjects: []
};

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.settingsPath = path.join(this.dir, 'settings.json');
    this.threadsPath = path.join(this.dir, 'threads.json');
    fs.mkdirSync(this.dir, { recursive: true });
    this.settings = this._readJson(this.settingsPath, DEFAULT_SETTINGS);
    this.threads = this._readJson(this.threadsPath, {});
  }

  _readJson(p, fallback) {
    try {
      return { ...fallback, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    } catch {
      return JSON.parse(JSON.stringify(fallback));
    }
  }

  _writeJson(p, data) {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, p);
  }

  // ----- settings -----
  getSettings() {
    return this.settings;
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this._writeJson(this.settingsPath, this.settings);
    return this.settings;
  }

  addRecentProject(dir) {
    const list = (this.settings.recentProjects || []).filter((d) => d !== dir);
    list.unshift(dir);
    this.setSettings({ recentProjects: list.slice(0, 10) });
  }

  // ----- threads -----
  _saveThreads() {
    this._writeJson(this.threadsPath, this.threads);
  }

  listThreads() {
    return Object.values(this.threads)
      .map(({ id, title, projectDir, createdAt, updatedAt }) => ({ id, title, projectDir, createdAt, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getThread(id) {
    return this.threads[id] || null;
  }

  createThread(projectDir) {
    const id = 't_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    this.threads[id] = {
      id,
      title: 'New thread',
      projectDir,
      createdAt: now,
      updatedAt: now,
      model: this.settings.model,
      mode: this.settings.mode,
      items: []
    };
    this._saveThreads();
    return this.threads[id];
  }

  deleteThread(id) {
    delete this.threads[id];
    this._saveThreads();
    return { ok: true };
  }

  renameThread(id, title) {
    const t = this.threads[id];
    if (t) {
      t.title = title;
      t.updatedAt = Date.now();
      this._saveThreads();
    }
    return t;
  }

  setThreadMeta(id, patch) {
    const t = this.threads[id];
    if (t) {
      Object.assign(t, patch);
      this._saveThreads();
    }
  }

  appendMessage(id, item) {
    const t = this.threads[id];
    if (!t) return;
    t.items.push(item);
    t.updatedAt = Date.now();
    this._saveThreads();
  }
}

module.exports = Store;
