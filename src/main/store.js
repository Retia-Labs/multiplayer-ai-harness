const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  theme: 'dark',
  model: 'gpt-5.1-codex-max',
  effort: 'medium', // low | medium | high | xhigh
  mode: 'agent', // 'read-only' | 'agent' | 'full-access'
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  customModels: '',
  notifications: true,
  recentProjects: [],
  customPrompts: [], // [{id, name, prompt}]
  automations: []    // [{id, name, prompt, projectDir, everyMinutes, mode, enabled, lastRun, nextRun}]
};

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

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
      return { ...JSON.parse(JSON.stringify(fallback)), ...JSON.parse(fs.readFileSync(p, 'utf8')) };
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

  // ----- automations -----
  listAutomations() {
    return this.settings.automations || [];
  }

  saveAutomation(auto) {
    const list = this.listAutomations().slice();
    if (!auto.id) auto.id = uid('auto');
    const idx = list.findIndex((a) => a.id === auto.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...auto };
    else list.push(auto);
    this.setSettings({ automations: list });
    return auto;
  }

  deleteAutomation(id) {
    this.setSettings({ automations: this.listAutomations().filter((a) => a.id !== id) });
    return { ok: true };
  }

  // ----- threads -----
  _saveThreads() {
    this._writeJson(this.threadsPath, this.threads);
  }

  listThreads() {
    return Object.values(this.threads)
      .map(({ id, title, projectDir, workDir, branch, worktree, archived, automation, createdAt, updatedAt }) => ({
        id, title, projectDir, workDir, branch, worktree, archived: !!archived, automation: !!automation, createdAt, updatedAt
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getThread(id) {
    return this.threads[id] || null;
  }

  createThread({ projectDir, workDir, branch, worktree, automation, title } = {}) {
    const id = uid('t');
    const now = Date.now();
    this.threads[id] = {
      id,
      title: title || 'New thread',
      projectDir: projectDir || null,
      workDir: workDir || projectDir || null,
      branch: branch || null,
      worktree: !!worktree,
      automation: !!automation,
      archived: false,
      createdAt: now,
      updatedAt: now,
      model: this.settings.model,
      mode: this.settings.mode,
      effort: this.settings.effort,
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
    return t;
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
module.exports.uid = uid;
