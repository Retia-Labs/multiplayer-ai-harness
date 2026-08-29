/* Codex desktop clone — renderer logic */
(function () {
  const $ = (sel) => document.querySelector(sel);

  const el = {
    threadList: $('#thread-list'),
    threadSearch: $('#thread-search'),
    newThread: $('#btn-new-thread'),
    openProject: $('#btn-open-project'),
    openProjectLabel: $('#open-project-label'),
    settingsBtn: $('#btn-settings'),
    projectName: $('#project-name'),
    projectBranch: $('#project-branch'),
    changesBtn: $('#btn-changes'),
    changesCount: $('#changes-count'),
    chatView: $('#chat-view'),
    messages: $('#messages'),
    emptyState: $('#empty-state'),
    input: $('#input'),
    send: $('#btn-send'),
    modelSelect: $('#model-select'),
    modeSelect: $('#mode-select'),
    working: $('#working'),
    workingLabel: $('#working-label'),
    stop: $('#btn-stop'),
    diffView: $('#diff-view'),
    diffSummary: $('#diff-summary'),
    diffFiles: $('#diff-files'),
    closeDiff: $('#btn-close-diff'),
    settingsModal: $('#settings-modal'),
    closeSettings: $('#btn-close-settings'),
    saveSettings: $('#btn-save-settings'),
    settingApiKey: $('#setting-api-key'),
    settingBaseUrl: $('#setting-base-url'),
    settingTheme: $('#setting-theme')
  };

  const state = {
    settings: null,
    project: null,        // {dir,name,branch,dirty}
    threads: [],          // summaries
    activeThreadId: null,
    running: false,
    itemNodes: new Map(), // itemId -> DOM refs
    diffOpen: false
  };

  // ---------------- init ----------------
  async function init() {
    state.settings = await window.codex.settings.get();
    applyTheme();
    el.modelSelect.value = state.settings.model || 'gpt-5.1-codex';
    el.modeSelect.value = state.settings.mode || 'agent';

    const recent = state.settings.recentProjects || [];
    if (recent.length) {
      const p = await window.codex.project.describe(recent[0]);
      setProject(p);
    }
    await refreshThreads();
    if (state.threads.length) selectThread(state.threads[0].id);
    bindEvents();
    window.codex.agent.onEvent(onAgentEvent);
  }

  function applyTheme() {
    document.body.dataset.theme = state.settings.theme === 'light' ? 'light' : 'dark';
  }

  // ---------------- project ----------------
  function setProject(p) {
    state.project = p;
    if (p) {
      el.projectName.textContent = p.name;
      el.openProjectLabel.textContent = p.name;
      if (p.branch) {
        el.projectBranch.textContent = p.branch + (p.dirty ? ' •' : '');
        el.projectBranch.classList.remove('hidden');
      } else {
        el.projectBranch.classList.add('hidden');
      }
    } else {
      el.projectName.textContent = 'No project';
      el.openProjectLabel.textContent = 'Open project';
      el.projectBranch.classList.add('hidden');
    }
    refreshChangesBadge();
  }

  async function refreshProject() {
    if (!state.project) return;
    setProject(await window.codex.project.describe(state.project.dir));
  }

  async function refreshChangesBadge() {
    if (!state.project) { el.changesCount.classList.add('hidden'); return; }
    const st = await window.codex.git.status(state.project.dir);
    if (st && st.length) {
      el.changesCount.textContent = st.length;
      el.changesCount.classList.remove('hidden');
    } else {
      el.changesCount.classList.add('hidden');
    }
  }

  // ---------------- threads ----------------
  async function refreshThreads() {
    state.threads = await window.codex.threads.list();
    renderThreadList();
  }

  function groupLabel(ts) {
    const d = new Date(ts);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yest = new Date(today.getTime() - 86400000);
    const week = new Date(today.getTime() - 6 * 86400000);
    if (d >= today) return 'Today';
    if (d >= yest) return 'Yesterday';
    if (d >= week) return 'Previous 7 days';
    return 'Older';
  }

  function renderThreadList() {
    const q = el.threadSearch.value.trim().toLowerCase();
    el.threadList.innerHTML = '';
    const filtered = state.threads.filter((t) => !q || t.title.toLowerCase().includes(q));
    if (!filtered.length) {
      const d = document.createElement('div');
      d.className = 'thread-empty';
      d.textContent = q ? 'No matching threads' : 'No threads yet — start one with +';
      el.threadList.appendChild(d);
      return;
    }
    let lastGroup = null;
    for (const t of filtered) {
      const g = groupLabel(t.updatedAt);
      if (g !== lastGroup) {
        lastGroup = g;
        const lab = document.createElement('div');
        lab.className = 'thread-group-label';
        lab.textContent = g;
        el.threadList.appendChild(lab);
      }
      const item = document.createElement('div');
      item.className = 'thread-item' + (t.id === state.activeThreadId ? ' active' : '');
      const title = document.createElement('span');
      title.className = 't-title';
      title.textContent = t.title;
      const del = document.createElement('button');
      del.className = 't-del';
      del.title = 'Delete thread';
      del.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.codex.threads.delete(t.id);
        if (state.activeThreadId === t.id) { state.activeThreadId = null; clearMessages(); }
        refreshThreads();
      });
      item.appendChild(title);
      item.appendChild(del);
      item.addEventListener('click', () => selectThread(t.id));
      el.threadList.appendChild(item);
    }
  }

  async function newThread() {
    const t = await window.codex.threads.create(state.project ? state.project.dir : null);
    await refreshThreads();
    selectThread(t.id);
    el.input.focus();
  }

  async function selectThread(id) {
    state.activeThreadId = id;
    renderThreadList();
    closeDiff();
    const t = await window.codex.threads.get(id);
    clearMessages();
    if (!t) return;
    if (t.model) el.modelSelect.value = t.model;
    if (t.mode) el.modeSelect.value = t.mode;
    if (t.projectDir && (!state.project || state.project.dir !== t.projectDir)) {
      setProject(await window.codex.project.describe(t.projectDir));
    }
    for (const item of t.items || []) renderItem(item, { done: true });
    setEmptyVisible(!(t.items || []).length);
    scrollToBottom(true);
  }

  // ---------------- messages ----------------
  function clearMessages() {
    state.itemNodes.clear();
    el.messages.querySelectorAll('.msg, .turn-error, .approval-card-wrap').forEach((n) => n.remove());
    setEmptyVisible(true);
  }

  function setEmptyVisible(v) {
    el.emptyState.classList.toggle('hidden', !v);
  }

  function scrollToBottom(force) {
    const m = el.messages;
    const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 120;
    if (force || nearBottom) m.scrollTop = m.scrollHeight;
  }

  function renderItem(item, { done } = {}) {
    setEmptyVisible(false);
    if (item.type === 'message' && item.role === 'user') {
      const wrap = document.createElement('div');
      wrap.className = 'msg msg-user';
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = item.text;
      wrap.appendChild(b);
      el.messages.appendChild(wrap);
    } else if (item.type === 'message') {
      const wrap = document.createElement('div');
      wrap.className = 'msg msg-assistant';
      const md = document.createElement('div');
      md.className = 'md';
      md.innerHTML = window.renderMarkdown(item.text || '');
      wrap.appendChild(md);
      el.messages.appendChild(wrap);
      if (item.id) state.itemNodes.set(item.id, { kind: 'message', wrap, md, text: item.text || '' });
    } else if (item.type === 'command') {
      const wrap = document.createElement('div');
      wrap.className = 'msg';
      const card = document.createElement('div');
      card.className = 'cmd-card' + (done && item.status !== 'failed' ? ' collapsed' : '');
      const head = document.createElement('div');
      head.className = 'cmd-head';
      const dot = document.createElement('span');
      dot.className = 'cmd-status ' + (item.status || 'running');
      const title = document.createElement('span');
      title.className = 'cmd-title mono';
      title.innerHTML = '<b>$</b> ';
      title.appendChild(document.createTextNode(item.command));
      const chev = document.createElement('span');
      chev.className = 'cmd-chevron';
      chev.textContent = '▾';
      head.append(dot, title, chev);
      const out = document.createElement('div');
      out.className = 'cmd-output mono';
      out.textContent = item.output || '';
      head.addEventListener('click', () => card.classList.toggle('collapsed'));
      card.append(head, out);
      wrap.appendChild(card);
      el.messages.appendChild(wrap);
      if (item.id) state.itemNodes.set(item.id, { kind: 'command', card, dot, out });
    }
    scrollToBottom();
  }

  // ---------------- agent events ----------------
  function onAgentEvent(ev) {
    if (ev.threadId !== state.activeThreadId) {
      if (ev.kind === 'turn-done' || ev.kind === 'turn-error') refreshThreads();
      return;
    }
    switch (ev.kind) {
      case 'turn-start':
        setRunning(true);
        break;
      case 'item-start':
        renderItem(ev.item);
        break;
      case 'item-delta': {
        const ref = state.itemNodes.get(ev.id);
        if (!ref) break;
        if (ref.kind === 'message' && ev.delta != null) {
          ref.text += ev.delta;
          ref.md.innerHTML = window.renderMarkdown(ref.text);
        } else if (ref.kind === 'command' && ev.outputDelta != null) {
          ref.out.textContent += ev.outputDelta;
        }
        scrollToBottom();
        break;
      }
      case 'item-done': {
        const ref = state.itemNodes.get(ev.item.id);
        if (!ref) { renderItem(ev.item, { done: true }); break; }
        if (ref.kind === 'message') {
          ref.text = ev.item.text || '';
          ref.md.innerHTML = window.renderMarkdown(ref.text);
        } else if (ref.kind === 'command') {
          ref.dot.className = 'cmd-status ' + (ev.item.status || 'done');
          ref.out.textContent = ev.item.output || '';
          if (ev.item.status === 'done') ref.card.classList.add('collapsed');
        }
        scrollToBottom();
        break;
      }
      case 'approval-request':
        renderApproval(ev);
        break;
      case 'turn-done':
        setRunning(false);
        refreshThreads();
        refreshProject();
        break;
      case 'turn-error':
        setRunning(false);
        if (ev.error && ev.error !== 'Cancelled') {
          const d = document.createElement('div');
          d.className = 'turn-error';
          d.textContent = '⚠ ' + ev.error;
          el.messages.appendChild(d);
          scrollToBottom(true);
        }
        refreshThreads();
        refreshProject();
        break;
    }
  }

  function renderApproval(ev) {
    const wrap = document.createElement('div');
    wrap.className = 'msg approval-card-wrap';
    const card = document.createElement('div');
    card.className = 'approval-card';
    const title = document.createElement('div');
    title.className = 'approval-title';
    title.textContent = 'Codex wants to run a command';
    const cmd = document.createElement('div');
    cmd.className = 'approval-cmd mono';
    cmd.textContent = '$ ' + ev.command;
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const approve = document.createElement('button');
    approve.className = 'approve';
    approve.textContent = 'Approve';
    const deny = document.createElement('button');
    deny.className = 'deny';
    deny.textContent = 'Deny';
    const answer = (ok) => {
      window.codex.agent.approve({ threadId: ev.threadId, callId: ev.callId, approved: ok });
      wrap.remove();
    };
    approve.addEventListener('click', () => answer(true));
    deny.addEventListener('click', () => answer(false));
    actions.append(approve, deny);
    card.append(title, cmd, actions);
    wrap.appendChild(card);
    el.messages.appendChild(wrap);
    scrollToBottom(true);
  }

  function setRunning(v) {
    state.running = v;
    el.working.classList.toggle('hidden', !v);
    el.send.disabled = v;
  }

  // ---------------- sending ----------------
  async function sendMessage() {
    const text = el.input.value.trim();
    if (!text || state.running) return;
    if (!state.activeThreadId) {
      const t = await window.codex.threads.create(state.project ? state.project.dir : null);
      state.activeThreadId = t.id;
      await refreshThreads();
      renderThreadList();
      clearMessages();
    }
    el.input.value = '';
    autosize();
    renderItem({ role: 'user', type: 'message', text });
    scrollToBottom(true);
    const model = el.modelSelect.value;
    const mode = el.modeSelect.value;
    window.codex.settings.set({ model, mode });
    try {
      await window.codex.agent.send({ threadId: state.activeThreadId, text, model, mode });
    } catch (err) {
      const d = document.createElement('div');
      d.className = 'turn-error';
      d.textContent = '⚠ ' + (err && err.message ? err.message : err);
      el.messages.appendChild(d);
    }
    refreshThreads();
  }

  // ---------------- diff panel ----------------
  async function openDiff() {
    if (!state.project) return;
    state.diffOpen = true;
    el.chatView.classList.add('hidden');
    el.diffView.classList.remove('hidden');
    el.changesBtn.classList.add('active');
    el.diffFiles.innerHTML = '<div class="diff-empty">Loading…</div>';
    const files = await window.codex.git.diff(state.project.dir);
    renderDiff(files || []);
  }

  function closeDiff() {
    state.diffOpen = false;
    el.diffView.classList.add('hidden');
    el.chatView.classList.remove('hidden');
    el.changesBtn.classList.remove('active');
  }

  function renderDiff(files) {
    el.diffFiles.innerHTML = '';
    const adds = files.reduce((n, f) => n + f.additions, 0);
    const dels = files.reduce((n, f) => n + f.deletions, 0);
    el.diffSummary.textContent = files.length
      ? `${files.length} file${files.length === 1 ? '' : 's'} changed, +${adds} −${dels}`
      : 'No changes';
    if (!files.length) {
      el.diffFiles.innerHTML = '<div class="diff-empty">Working tree is clean ✨</div>';
      return;
    }
    for (const f of files) {
      const card = document.createElement('div');
      card.className = 'diff-file';
      const head = document.createElement('div');
      head.className = 'diff-file-head';
      const p = document.createElement('span');
      p.className = 'diff-file-path mono';
      p.textContent = f.path;
      const status = document.createElement('span');
      status.className = 'diff-file-status';
      status.textContent = f.status;
      const add = document.createElement('span');
      add.className = 'diff-stat-add';
      add.textContent = '+' + f.additions;
      const del = document.createElement('span');
      del.className = 'diff-stat-del';
      del.textContent = '−' + f.deletions;
      head.append(p, status, add, del);
      head.addEventListener('click', () => card.classList.toggle('collapsed'));
      const lines = document.createElement('div');
      lines.className = 'diff-lines mono';
      const maxLines = 400;
      f.lines.slice(0, maxLines).forEach((l) => {
        const row = document.createElement('div');
        row.className = 'diff-line ' + l.kind;
        const mark = document.createElement('span');
        mark.className = 'dl-mark';
        mark.textContent = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '';
        const text = document.createElement('span');
        text.className = 'dl-text';
        text.textContent = l.kind === 'hunk' ? l.text : l.text;
        row.append(mark, text);
        lines.appendChild(row);
      });
      if (f.lines.length > maxLines) {
        const more = document.createElement('div');
        more.className = 'diff-line hunk';
        more.textContent = `… ${f.lines.length - maxLines} more lines`;
        lines.appendChild(more);
      }
      card.append(head, lines);
      el.diffFiles.appendChild(card);
    }
  }

  // ---------------- settings ----------------
  function openSettings() {
    el.settingApiKey.value = state.settings.openaiApiKey || '';
    el.settingBaseUrl.value = state.settings.openaiBaseUrl || 'https://api.openai.com/v1';
    el.settingTheme.value = state.settings.theme || 'dark';
    el.settingsModal.classList.remove('hidden');
  }

  async function saveSettings() {
    state.settings = await window.codex.settings.set({
      openaiApiKey: el.settingApiKey.value.trim(),
      openaiBaseUrl: el.settingBaseUrl.value.trim() || 'https://api.openai.com/v1',
      theme: el.settingTheme.value
    });
    applyTheme();
    el.settingsModal.classList.add('hidden');
  }

  // ---------------- misc UI ----------------
  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 180) + 'px';
  }

  function bindEvents() {
    el.newThread.addEventListener('click', newThread);
    el.threadSearch.addEventListener('input', renderThreadList);
    el.openProject.addEventListener('click', async () => {
      const p = await window.codex.project.pick();
      if (p) setProject(p);
    });
    el.settingsBtn.addEventListener('click', openSettings);
    el.closeSettings.addEventListener('click', () => el.settingsModal.classList.add('hidden'));
    el.saveSettings.addEventListener('click', saveSettings);
    el.settingsModal.addEventListener('click', (e) => {
      if (e.target === el.settingsModal) el.settingsModal.classList.add('hidden');
    });
    el.send.addEventListener('click', sendMessage);
    el.stop.addEventListener('click', () => {
      if (state.activeThreadId) window.codex.agent.cancel(state.activeThreadId);
    });
    el.input.addEventListener('input', autosize);
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    el.changesBtn.addEventListener('click', () => (state.diffOpen ? closeDiff() : openDiff()));
    el.closeDiff.addEventListener('click', closeDiff);
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newThread();
      }
      if (e.key === 'Escape') {
        el.settingsModal.classList.add('hidden');
        if (state.diffOpen) closeDiff();
      }
    });
  }

  init();
})();
