/* Quorum desktop clone — renderer logic */
(function () {
  const $ = (sel) => document.querySelector(sel);

  const el = {
    threadList: $('#thread-list'),
    threadSearch: $('#thread-search'),
    newThread: $('#btn-new-thread'),
    archivedSection: $('#archived-section'),
    archivedToggle: $('#archived-toggle'),
    archivedList: $('#archived-list'),
    archivedCount: $('#archived-count'),
    openProject: $('#btn-open-project'),
    openProjectLabel: $('#open-project-label'),
    automationsBtn: $('#btn-automations'),
    settingsBtn: $('#btn-settings'),
    projectName: $('#project-name'),
    projectBranch: $('#project-branch'),
    worktreeBadge: $('#worktree-badge'),
    turnUsage: $('#turn-usage'),
    changesBtn: $('#btn-changes'),
    changesCount: $('#changes-count'),
    homeView: $('#home-view'),
    homeProjectBtn: $('#home-project-btn'),
    homeProjectLabel: $('#home-project-label'),
    homeProjectMenu: $('#home-project-menu'),
    worktreeCheck: $('#worktree-check'),
    composerHostHome: $('#composer-host-home'),
    composerHostThread: $('#composer-host-thread'),
    chatView: $('#chat-view'),
    messages: $('#messages'),
    composer: $('#composer'),
    attachRow: $('#attach-row'),
    attachBtn: $('#btn-attach'),
    input: $('#input'),
    composerPopup: $('#composer-popup'),
    send: $('#btn-send'),
    modelSelect: $('#model-select'),
    effortSelect: $('#effort-select'),
    modeSelect: $('#mode-select'),
    working: $('#working'),
    workingLabel: $('#working-label'),
    stop: $('#btn-stop'),
    diffView: $('#diff-view'),
    diffSummary: $('#diff-summary'),
    diffFileList: $('#diff-file-list'),
    diffPane: $('#diff-pane'),
    commitMsg: $('#commit-msg'),
    commitBtn: $('#btn-commit'),
    copyPatchBtn: $('#btn-copy-patch'),
    pushBtn: $('#btn-push'),
    prBtn: $('#btn-pr'),
    closeDiff: $('#btn-close-diff'),
    codeBtn: $('#btn-code'),
    codeView: $('#code-view'),
    codeTitle: $('#code-title'),
    codeSave: $('#btn-code-save'),
    closeCode: $('#btn-close-code'),
    editorRoot: $('#editor-root'),
    shareBtn: $('#btn-share'),
    shareLabel: $('#share-label'),
    joinBtn: $('#btn-join'),
    presence: $('#presence'),
    roomModal: $('#room-modal'),
    roomTitle: $('#room-title'),
    roomClose: $('#room-close'),
    roomSharePane: $('#room-share-pane'),
    roomJoinPane: $('#room-join-pane'),
    roomCode: $('#room-code'),
    roomCopy: $('#room-copy'),
    roomRelayNote: $('#room-relay-note'),
    roomStop: $('#room-stop'),
    joinCode: $('#join-code'),
    joinRelay: $('#join-relay'),
    joinError: $('#join-error'),
    joinGo: $('#join-go'),
    automationsModal: $('#automations-modal'),
    closeAutomations: $('#btn-close-automations'),
    automationList: $('#automation-list'),
    autoName: $('#auto-name'),
    autoInterval: $('#auto-interval'),
    autoPrompt: $('#auto-prompt'),
    autoMode: $('#auto-mode'),
    addAutomation: $('#btn-add-automation'),
    settingsModal: $('#settings-modal'),
    closeSettings: $('#btn-close-settings'),
    saveSettings: $('#btn-save-settings'),
    settingApiKey: $('#setting-api-key'),
    settingBaseUrl: $('#setting-base-url'),
    settingCustomModels: $('#setting-custom-models'),
    settingTheme: $('#setting-theme'),
    settingNotifications: $('#setting-notifications'),
    promptList: $('#prompt-list'),
    promptName: $('#prompt-name'),
    promptText: $('#prompt-text'),
    addPrompt: $('#btn-add-prompt'),
    toasts: $('#toasts')
  };

  const BASE_MODELS = ['gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1'];
  const BUILTIN_PROMPTS = [
    { name: '/review', prompt: 'Review my current working-tree changes and point out bugs, risks and improvements.' },
    { name: '/explain', prompt: 'Explain how this codebase is structured and how the main pieces fit together.' },
    { name: '/tests', prompt: 'Write tests for the most important untested code in this repo.' },
    { name: '/commit-msg', prompt: 'Look at the current diff and propose a good commit message.' }
  ];

  const state = {
    settings: null,
    project: null,          // {dir,name,branch,dirty}
    threads: [],
    activeThreadId: null,
    activeThread: null,     // full thread record
    running: new Set(),     // threadIds with an in-flight turn
    needsApproval: new Set(),
    ready: new Set(),       // finished while inactive → "Ready" badge
    itemNodes: new Map(),
    attachments: [],
    fileCache: { dir: null, files: [] },
    popup: null,            // {type:'mention'|'slash', items, sel, anchor}
    diffOpen: false,
    diffFiles: [],
    diffSel: 0,
    customPrompts: []
  };

  // ---------------- init ----------------
  async function init() {
    state.settings = await window.quorum.settings.get();
    state.customPrompts = state.settings.customPrompts || [];
    applyTheme();
    buildModelPicker();
    el.modelSelect.value = state.settings.model || BASE_MODELS[0];
    el.effortSelect.value = state.settings.effort || 'medium';
    el.modeSelect.value = state.settings.mode || 'agent';

    const recent = state.settings.recentProjects || [];
    if (recent.length) {
      const p = await window.quorum.project.describe(recent[0]).catch(() => null);
      if (p) setProject(p);
    }
    await refreshThreads();
    const runningIds = await window.quorum.agent.running();
    runningIds.forEach((id) => state.running.add(id));
    showHome();
    bindEvents();
    window.quorum.agent.onEvent(onAgentEvent);
    // Durable events carry what PEOPLE said and did. The live channel only
    // carries what the agent is doing, so a room conversation would otherwise
    // be invisible until a reload.
    window.quorum.session.onEvents(({ threadId, events }) => {
      if (threadId !== state.activeThreadId) return;
      for (const ev of events) {
        if (ev.kind === 'note.posted') renderRoomNote(ev);
        if (ev.kind === 'directive.sent' && ev.actor.startsWith('human:')) renderRoomNote(ev, true);
      }
    });
    window.quorum.agent.onAutomation(({ threadId }) => {
      refreshThreads();
      toast('<b>Automation started</b> — running in a new thread');
      state.running.add(threadId);
      renderThreadList();
    });
  }

  function applyTheme() {
    document.body.dataset.theme = state.settings.theme === 'light' ? 'light' : 'dark';
  }

  function buildModelPicker() {
    const extra = (state.settings.customModels || '').split(',').map((s) => s.trim()).filter(Boolean);
    const models = [...BASE_MODELS, ...extra.filter((m) => !BASE_MODELS.includes(m))];
    el.modelSelect.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      el.modelSelect.appendChild(o);
    }
  }

  function toast(html, ms = 3800) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = html;
    el.toasts.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function notify(title, body) {
    if (!state.settings.notifications) return;
    try { new Notification(title, { body, silent: true }); } catch {}
  }

  // ---------------- views ----------------
  function showHome() {
    state.activeThreadId = null;
    state.activeThread = null;
    closeDiff();
    closeCode();
    el.chatView.classList.add('hidden');
    el.homeView.classList.remove('hidden');
    el.composerHostHome.appendChild(el.composer);
    el.shareBtn.classList.add('hidden');
    el.presence.classList.add('hidden');
    updateTopbar();
    renderThreadList();
    el.input.focus();
  }

  function showChat() {
    el.homeView.classList.add('hidden');
    el.chatView.classList.remove('hidden');
    el.composerHostThread.appendChild(el.composer);
    el.input.focus();
  }

  function updateTopbar() {
    const t = state.activeThread;
    if (t && t.projectDir) {
      el.projectName.textContent = t.projectDir.split('/').pop();
    } else if (state.project) {
      el.projectName.textContent = state.project.name;
    } else {
      el.projectName.textContent = 'No project';
    }
    el.worktreeBadge.classList.toggle('hidden', !(t && t.worktree));
    if (t && t.worktree && t.branch) {
      el.projectBranch.textContent = t.branch;
      el.projectBranch.classList.remove('hidden');
    } else if (state.project && state.project.branch) {
      el.projectBranch.textContent = state.project.branch + (state.project.dirty ? ' •' : '');
      el.projectBranch.classList.remove('hidden');
    } else {
      el.projectBranch.classList.add('hidden');
    }
    refreshChangesBadge();
  }

  // ---------------- project ----------------
  function setProject(p) {
    state.project = p;
    if (p) {
      el.openProjectLabel.textContent = p.name;
      el.homeProjectLabel.textContent = p.name;
    } else {
      el.openProjectLabel.textContent = 'Open project';
      el.homeProjectLabel.textContent = 'Choose a project';
    }
    updateTopbar();
  }

  async function refreshProject() {
    if (!state.project) return;
    const p = await window.quorum.project.describe(state.project.dir).catch(() => null);
    if (p) setProject(p);
  }

  function workDirForActive() {
    const t = state.activeThread;
    if (t) return t.workDir || t.projectDir;
    return state.project ? state.project.dir : null;
  }

  async function refreshChangesBadge() {
    const dir = workDirForActive();
    if (!dir) { el.changesCount.classList.add('hidden'); return; }
    const st = await window.quorum.git.status(dir);
    if (st && st.length) {
      el.changesCount.textContent = st.length;
      el.changesCount.classList.remove('hidden');
    } else {
      el.changesCount.classList.add('hidden');
    }
  }

  async function showProjectMenu() {
    const recent = await window.quorum.project.recent();
    el.homeProjectMenu.innerHTML = '';
    for (const dir of recent) {
      const b = document.createElement('button');
      b.className = 'popup-item';
      b.innerHTML = `<span class="pi-title">${escapeHtml(dir.split('/').pop())}</span><span class="pi-sub">${escapeHtml(dir)}</span>`;
      b.addEventListener('click', async () => {
        el.homeProjectMenu.classList.add('hidden');
        const p = await window.quorum.project.describe(dir);
        setProject(p);
      });
      el.homeProjectMenu.appendChild(b);
    }
    const open = document.createElement('button');
    open.className = 'popup-item';
    open.innerHTML = '<span class="pi-title">Open folder…</span>';
    open.addEventListener('click', async () => {
      el.homeProjectMenu.classList.add('hidden');
      const p = await window.quorum.project.pick();
      if (p) setProject(p);
    });
    el.homeProjectMenu.appendChild(open);
    el.homeProjectMenu.classList.remove('hidden');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------------- threads ----------------
  async function refreshThreads() {
    state.threads = await window.quorum.threads.list();
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

  function threadItemNode(t) {
    const item = document.createElement('div');
    item.className = 'thread-item';
    if (t.id === state.activeThreadId) item.classList.add('active');
    if (state.running.has(t.id)) item.classList.add('running');
    if (state.needsApproval.has(t.id)) item.classList.add('needs-approval');
    if (state.ready.has(t.id)) item.classList.add('ready');

    const status = document.createElement('span');
    status.className = 't-status';
    status.innerHTML = '<span class="t-spin"></span><span class="t-dot"></span>';

    const title = document.createElement('span');
    title.className = 't-title';
    title.textContent = t.title;
    title.title = t.title;

    const review = document.createElement('span');
    review.className = 't-review';
    review.textContent = 'Ready';

    const actions = document.createElement('span');
    actions.className = 't-actions';
    const arch = document.createElement('button');
    arch.className = 't-act';
    arch.title = t.archived ? 'Unarchive' : 'Archive';
    arch.innerHTML = t.archived
      ? '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 5l6 6h-4v6h-4v-6H6z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20.54 5.23 19.15 3.55A1.9 1.9 0 0 0 17.7 3H6.3c-.6 0-1.13.21-1.45.55L3.46 5.23A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.48-.17-.93-.46-1.27M12 17.5 6.5 12H10v-2h4v2h3.5zM5.12 5l.81-1h12l.94 1z"/></svg>';
    arch.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.quorum.threads.archive(t.id, !t.archived);
      if (state.activeThreadId === t.id && !t.archived) showHome();
      refreshThreads();
    });
    const del = document.createElement('button');
    del.className = 't-act';
    del.title = 'Delete thread';
    del.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.quorum.threads.delete(t.id);
      if (state.activeThreadId === t.id) showHome();
      refreshThreads();
    });
    actions.append(arch, del);

    item.append(status, title, review, actions);
    item.addEventListener('click', () => selectThread(t.id));
    item.addEventListener('dblclick', async () => {
      const name = prompt('Rename thread', t.title);
      if (name) { await window.quorum.threads.rename(t.id, name); refreshThreads(); }
    });
    return item;
  }

  function renderThreadList() {
    const q = el.threadSearch.value.trim().toLowerCase();
    const active = state.threads.filter((t) => !t.archived && (!q || t.title.toLowerCase().includes(q)));
    const archived = state.threads.filter((t) => t.archived && (!q || t.title.toLowerCase().includes(q)));

    el.threadList.innerHTML = '';
    if (!active.length) {
      const d = document.createElement('div');
      d.className = 'thread-empty';
      d.textContent = q ? 'No matching threads' : 'No threads yet — start one below';
      el.threadList.appendChild(d);
    } else {
      let lastGroup = null;
      for (const t of active) {
        const g = groupLabel(t.updatedAt);
        if (g !== lastGroup) {
          lastGroup = g;
          const lab = document.createElement('div');
          lab.className = 'thread-group-label';
          lab.textContent = g;
          el.threadList.appendChild(lab);
        }
        el.threadList.appendChild(threadItemNode(t));
      }
    }

    el.archivedSection.classList.toggle('hidden', archived.length === 0);
    el.archivedCount.textContent = archived.length || '';
    el.archivedList.innerHTML = '';
    for (const t of archived) el.archivedList.appendChild(threadItemNode(t));
  }

  async function newThread() {
    showHome();
  }

  async function selectThread(id) {
    // The room chip and presence belong to the thread, so they refresh with it.
    setTimeout(refreshRoomChip, 0);
    state.activeThreadId = id;
    state.ready.delete(id);
    closeDiff();
    closeCode();
    const t = await window.quorum.threads.get(id);
    state.activeThread = t;
    clearMessages();
    renderThreadList();
    if (!t) return;
    if (t.model) { buildModelPicker(); el.modelSelect.value = t.model; }
    if (t.mode) el.modeSelect.value = t.mode;
    if (t.effort) el.effortSelect.value = t.effort;
    if (t.projectDir && (!state.project || state.project.dir !== t.projectDir)) {
      const p = await window.quorum.project.describe(t.projectDir).catch(() => null);
      if (p) setProject(p);
    }
    updateTopbar();
    showChat();
    for (const item of t.items || []) renderItem(item, { done: true });
    setWorkingVisible(state.running.has(id));
    scrollToBottom(true);
  }

  // ---------------- messages ----------------
  function clearMessages() {
    state.itemNodes.clear();
    el.messages.innerHTML = '';
  }

  function scrollToBottom(force) {
    const m = el.messages;
    const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 140;
    if (force || nearBottom) m.scrollTop = m.scrollHeight;
  }

  function msgWrap(cls) {
    const wrap = document.createElement('div');
    wrap.className = 'msg' + (cls ? ' ' + cls : '');
    el.messages.appendChild(wrap);
    return wrap;
  }

  function renderItem(item, { done } = {}) {
    if (item.type === 'message' && item.role === 'user') {
      const wrap = msgWrap('msg-user' + (item.steered ? ' steered' : ''));
      if (item.images && item.images.length) {
        const imgs = document.createElement('div');
        imgs.className = 'bubble-imgs';
        for (const u of item.images) {
          const img = document.createElement('img');
          img.src = u;
          imgs.appendChild(img);
        }
        wrap.appendChild(imgs);
      }
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = item.text;
      wrap.appendChild(b);
    } else if (item.type === 'message') {
      const wrap = msgWrap('msg-assistant');
      const md = document.createElement('div');
      md.className = 'md';
      md.innerHTML = window.renderMarkdown(item.text || '');
      wrap.appendChild(md);
      if (item.id) state.itemNodes.set(item.id, { kind: 'message', wrap, md, text: item.text || '' });
    } else if (item.type === 'reasoning') {
      const wrap = msgWrap('reasoning' + (done ? ' collapsed' : ' thinking'));
      const head = document.createElement('div');
      head.className = 'rsn-head';
      head.textContent = done ? 'Thought about it' : 'Thinking…';
      const body = document.createElement('div');
      body.className = 'rsn-body';
      body.textContent = item.text || '';
      head.addEventListener('click', () => wrap.classList.toggle('collapsed'));
      wrap.append(head, body);
      if (item.id) state.itemNodes.set(item.id, { kind: 'reasoning', wrap, head, body });
    } else if (item.type === 'plan') {
      const wrap = msgWrap();
      const card = document.createElement('div');
      card.className = 'plan-card';
      wrap.appendChild(card);
      fillPlanCard(card, item);
      if (item.id) state.itemNodes.set(item.id, { kind: 'plan', card });
    } else if (item.type === 'command') {
      const wrap = msgWrap();
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
      if (item.id) state.itemNodes.set(item.id, { kind: 'command', card, dot, out });
    } else if (item.type === 'edit') {
      const wrap = msgWrap();
      const card = document.createElement('div');
      card.className = 'edit-card' + (done ? ' collapsed' : '');
      const head = document.createElement('div');
      head.className = 'edit-head';
      head.innerHTML = '<span class="edit-icon"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm4 18H6V4h7v5h5z"/></svg></span>';
      const p = document.createElement('span');
      p.className = 'edit-path mono';
      p.textContent = item.path;
      const badge = document.createElement('span');
      badge.className = 'edit-badge';
      badge.textContent = item.status === 'denied' ? 'denied' : item.status === 'failed' ? 'failed' : item.created ? 'new' : 'edited';
      const stats = document.createElement('span');
      stats.className = 'edit-stats mono';
      stats.innerHTML = `<span class="add">+${item.additions || 0}</span><span class="del">−${item.deletions || 0}</span>`;
      const chev = document.createElement('span');
      chev.className = 'cmd-chevron';
      chev.textContent = '▾';
      head.append(p, badge, stats, chev);
      const diffEl = document.createElement('div');
      diffEl.className = 'edit-diff';
      for (const l of item.lines || []) {
        const row = document.createElement('div');
        row.className = 'diff-line ' + l.kind;
        const mark = document.createElement('span');
        mark.className = 'dl-mark';
        mark.textContent = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '';
        const text = document.createElement('span');
        text.className = 'dl-text';
        text.textContent = l.text;
        row.append(mark, text);
        diffEl.appendChild(row);
      }
      head.addEventListener('click', () => card.classList.toggle('collapsed'));
      card.append(head, diffEl);
      wrap.appendChild(card);
      if (item.id) state.itemNodes.set(item.id, { kind: 'edit', card });
    }
    scrollToBottom();
  }

  function fillPlanCard(card, item) {
    card.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'plan-title';
    title.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M3 5h2v2H3zm4 0h14v2H7zM3 11h2v2H3zm4 0h14v2H7zM3 17h2v2H3zm4 0h14v2H7z"/></svg> Plan' + (item.explanation ? ' — <span style="font-weight:400">' + escapeHtml(item.explanation) + '</span>' : '');
    const steps = document.createElement('div');
    steps.className = 'plan-steps';
    for (const s of item.steps || []) {
      const row = document.createElement('div');
      row.className = 'plan-step ' + (s.status || 'pending');
      const box = document.createElement('span');
      box.className = 'ps-box';
      if (s.status === 'completed') box.textContent = '✓';
      const label = document.createElement('span');
      label.textContent = s.step;
      row.append(box, label);
      steps.appendChild(row);
    }
    card.append(title, steps);
  }

  // ---------------- agent events ----------------
  function onAgentEvent(ev) {
    // Global status bookkeeping first.
    if (ev.kind === 'turn-start') state.running.add(ev.threadId);
    if (ev.kind === 'approval-request') state.needsApproval.add(ev.threadId);
    if (ev.kind === 'turn-done' || ev.kind === 'turn-error') {
      state.running.delete(ev.threadId);
      state.needsApproval.delete(ev.threadId);
      if (ev.threadId !== state.activeThreadId) {
        state.ready.add(ev.threadId);
        const t = state.threads.find((x) => x.id === ev.threadId);
        notify('Quorum', (t ? t.title : 'A thread') + ' is ready for review');
        toast('<b>' + escapeHtml(t ? t.title : 'Thread') + '</b> finished — ready for review');
      }
      refreshThreads();
    } else {
      renderThreadList();
    }

    if (ev.threadId !== state.activeThreadId) {
      if (ev.kind === 'approval-request') {
        const t = state.threads.find((x) => x.id === ev.threadId);
        notify('Quorum needs approval', ev.command || '');
        toast('<b>' + escapeHtml(t ? t.title : 'Thread') + '</b> is waiting for approval');
      }
      return;
    }

    switch (ev.kind) {
      case 'turn-start':
        setWorkingVisible(true);
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
        } else if (ref.kind === 'reasoning' && ev.delta != null) {
          ref.body.textContent += ev.delta;
        }
        scrollToBottom();
        break;
      }
      case 'item-update': {
        const ref = state.itemNodes.get(ev.item.id);
        if (ref && ref.kind === 'plan') fillPlanCard(ref.card, ev.item);
        else if (!ref) renderItem(ev.item);
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
        } else if (ref.kind === 'reasoning') {
          ref.wrap.classList.remove('thinking');
          ref.wrap.classList.add('collapsed');
          ref.head.textContent = 'Thought about it';
        } else if (ref.kind === 'plan') {
          fillPlanCard(ref.card, ev.item);
        }
        scrollToBottom();
        break;
      }
      case 'approval-request':
        renderApproval(ev);
        break;
      case 'turn-done':
        setWorkingVisible(false);
        if (ev.usage) {
          const total = (ev.usage.input || 0) + (ev.usage.output || 0);
          el.turnUsage.textContent = total.toLocaleString() + ' tokens';
          el.turnUsage.classList.remove('hidden');
          const meta = document.createElement('div');
          meta.className = 'turn-meta';
          meta.textContent = `Turn used ${total.toLocaleString()} tokens (${(ev.usage.input || 0).toLocaleString()} in / ${(ev.usage.output || 0).toLocaleString()} out)`;
          el.messages.appendChild(meta);
        }
        refreshProject();
        refreshChangesBadge();
        break;
      case 'turn-error':
        setWorkingVisible(false);
        if (ev.error && ev.error !== 'Cancelled') {
          const d = document.createElement('div');
          d.className = 'turn-error';
          d.textContent = '⚠ ' + ev.error;
          el.messages.appendChild(d);
          scrollToBottom(true);
        }
        refreshProject();
        refreshChangesBadge();
        break;
    }
  }

  function renderApproval(ev) {
    const wrap = msgWrap('approval-card-wrap');
    const card = document.createElement('div');
    card.className = 'approval-card';
    const title = document.createElement('div');
    title.className = 'approval-title';
    title.textContent = ev.action === 'write' ? 'Quorum wants to write a file' : 'Quorum wants to run a command';
    const cmd = document.createElement('div');
    cmd.className = 'approval-cmd mono';
    cmd.textContent = (ev.action === 'write' ? '' : '$ ') + ev.command;
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const approve = document.createElement('button');
    approve.className = 'approve';
    approve.textContent = 'Approve';
    const deny = document.createElement('button');
    deny.className = 'deny';
    deny.textContent = 'Deny';
    const answer = (ok) => {
      window.quorum.agent.approve({ threadId: ev.threadId, callId: ev.callId, approved: ok });
      state.needsApproval.delete(ev.threadId);
      renderThreadList();
      wrap.remove();
    };
    approve.addEventListener('click', () => answer(true));
    deny.addEventListener('click', () => answer(false));
    actions.append(approve, deny);
    card.append(title, cmd, actions);
    wrap.appendChild(card);
    scrollToBottom(true);
  }

  function setWorkingVisible(v) {
    el.working.classList.toggle('hidden', !v);
    el.send.classList.toggle('queue', v);
    el.send.title = v ? 'Queue message into the running turn' : 'Send (Enter)';
  }

  // ---------------- sending ----------------
  async function sendMessage() {
    const text = el.input.value.trim();
    if (!text) return;

    if (!state.activeThreadId) {
      const t = await window.quorum.threads.create({
        projectDir: state.project ? state.project.dir : null,
        worktree: el.worktreeCheck.checked
      });
      state.activeThreadId = t.id;
      state.activeThread = t;
      el.worktreeCheck.checked = false;
      await refreshThreads();
      clearMessages();
      updateTopbar();
      showChat();
    }

    const images = state.attachments.slice();
    state.attachments = [];
    renderAttachRow();
    el.input.value = '';
    autosize();
    hidePopup();

    const isRunning = state.running.has(state.activeThreadId);
    renderItem({ role: 'user', type: 'message', text, images: images.map((i) => i.dataUrl), steered: isRunning });
    scrollToBottom(true);

    const model = el.modelSelect.value;
    const mode = el.modeSelect.value;
    const effort = el.effortSelect.value;
    window.quorum.settings.set({ model, mode, effort });
    try {
      await window.quorum.agent.send({ threadId: state.activeThreadId, text, model, mode, effort, images });
    } catch (err) {
      const d = document.createElement('div');
      d.className = 'turn-error';
      d.textContent = '⚠ ' + (err && err.message ? err.message : err);
      el.messages.appendChild(d);
    }
    refreshThreads();
  }

  // ---------------- attachments ----------------
  function renderAttachRow() {
    el.attachRow.innerHTML = '';
    el.attachRow.classList.toggle('hidden', state.attachments.length === 0);
    state.attachments.forEach((a, i) => {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      const img = document.createElement('img');
      img.src = a.dataUrl;
      const name = document.createElement('span');
      name.textContent = a.name;
      const x = document.createElement('button');
      x.textContent = '×';
      x.addEventListener('click', () => {
        state.attachments.splice(i, 1);
        renderAttachRow();
      });
      chip.append(img, name, x);
      el.attachRow.appendChild(chip);
    });
  }

  // ---------------- composer popups (@ files, / prompts) ----------------
  async function ensureFileCache() {
    const dir = workDirForActive();
    if (!dir) return [];
    if (state.fileCache.dir !== dir) {
      state.fileCache = { dir, files: await window.quorum.project.files(dir) };
    }
    return state.fileCache.files;
  }

  function currentToken() {
    const pos = el.input.selectionStart;
    const before = el.input.value.slice(0, pos);
    const m = before.match(/(^|\s)(@[\w./-]*)$/);
    if (m) return { type: 'mention', token: m[2], start: pos - m[2].length, end: pos };
    if (/^\/[\w-]*$/.test(before) && el.input.value.trim() === before.trim()) {
      return { type: 'slash', token: before.trim(), start: before.length - before.trim().length, end: pos };
    }
    return null;
  }

  async function updatePopup() {
    const tok = currentToken();
    if (!tok) { hidePopup(); return; }
    let items = [];
    if (tok.type === 'mention') {
      const q = tok.token.slice(1).toLowerCase();
      const files = await ensureFileCache();
      items = files
        .filter((f) => f.toLowerCase().includes(q))
        .slice(0, 12)
        .map((f) => ({ title: f.split('/').pop(), sub: f, insert: f }));
      if (!items.length) { hidePopup(); return; }
    } else {
      const q = tok.token.toLowerCase();
      const all = [...BUILTIN_PROMPTS, ...state.customPrompts.map((p) => ({ name: p.name.startsWith('/') ? p.name : '/' + p.name, prompt: p.prompt }))];
      items = all
        .filter((p) => p.name.toLowerCase().startsWith(q))
        .slice(0, 10)
        .map((p) => ({ title: p.name, sub: p.prompt, replaceAll: p.prompt }));
      if (!items.length) { hidePopup(); return; }
    }
    state.popup = { type: tok.type, items, sel: 0, tok };
    renderPopup();
  }

  function renderPopup() {
    const p = state.popup;
    if (!p) return;
    el.composerPopup.innerHTML = '';
    p.items.forEach((it, i) => {
      const b = document.createElement('button');
      b.className = 'popup-item' + (i === p.sel ? ' sel' : '');
      b.innerHTML = `<span class="pi-title">${escapeHtml(it.title)}</span>` + (it.sub ? `<span class="pi-sub">${escapeHtml(it.sub)}</span>` : '');
      b.addEventListener('mousedown', (e) => { e.preventDefault(); choosePopup(i); });
      el.composerPopup.appendChild(b);
    });
    el.composerPopup.classList.remove('hidden');
  }

  function choosePopup(i) {
    const p = state.popup;
    if (!p) return;
    const it = p.items[i];
    if (it.replaceAll != null) {
      el.input.value = it.replaceAll;
    } else {
      const v = el.input.value;
      el.input.value = v.slice(0, p.tok.start) + it.insert + ' ' + v.slice(p.tok.end);
    }
    hidePopup();
    el.input.focus();
    autosize();
  }

  function hidePopup() {
    state.popup = null;
    el.composerPopup.classList.add('hidden');
  }

  // ---------------- diff review panel ----------------
  async function openDiff() {
    const dir = workDirForActive();
    if (!dir) return;
    state.diffOpen = true;
    el.homeView.classList.add('hidden');
    el.chatView.classList.add('hidden');
    el.diffView.classList.remove('hidden');
    el.changesBtn.classList.add('active');
    el.diffPane.innerHTML = '<div class="diff-empty">Loading…</div>';
    refreshGitButtons();
    state.diffFiles = (await window.quorum.git.diff(dir)) || [];
    state.diffSel = 0;
    renderDiffPanel();
  }

  /* ---------- GitHub ----------
     Push and pull-request run through the git and gh the user already has
     configured. If gh is missing, the PR button says so rather than failing
     when pressed - an offer the app cannot honour is worse than no offer. */

  async function refreshGitButtons() {
    const caps = state.githubCaps || (state.githubCaps = await window.quorum.github.capabilities());
    el.pushBtn.classList.toggle('hidden', !caps.git);
    el.prBtn.classList.toggle('hidden', !caps.git);
    if (!caps.canOpenPr) {
      el.prBtn.disabled = true;
      el.prBtn.title = caps.gh
        ? 'Run "gh auth login" to open pull requests from here'
        : 'Install the GitHub CLI (gh) to open pull requests from here';
    } else {
      el.prBtn.disabled = false;
      el.prBtn.title = 'Open a pull request for this branch';
    }
  }

  async function doPush() {
    if (!state.activeThreadId) return;
    el.pushBtn.disabled = true;
    el.pushBtn.textContent = 'Pushing…';
    try {
      const res = await window.quorum.github.push(state.activeThreadId);
      toast('<b>Pushed</b> ' + escapeHtml(res.branch) + ' to origin');
    } catch (err) {
      toast('<b>Push failed</b> — ' + escapeHtml(String(err.message || err).replace(/^Error: /, '')), 6000);
    } finally {
      el.pushBtn.disabled = false;
      el.pushBtn.textContent = 'Push';
    }
  }

  async function doOpenPr() {
    if (!state.activeThreadId) return;
    const existing = await window.quorum.github.currentPr(state.activeThreadId).catch(() => null);
    if (existing && existing.url) {
      toast('<b>Already open</b> — PR #' + existing.number + ' for this branch');
      return;
    }
    const t = state.activeThread;
    const title = window.prompt('Pull request title', (t && t.title) || 'Changes from Quorum');
    if (!title) return;
    el.prBtn.disabled = true;
    el.prBtn.textContent = 'Opening…';
    try {
      const res = await window.quorum.github.openPr(state.activeThreadId, { title });
      toast('<b>Pull request opened</b><br>' + escapeHtml(res.url), 8000);
    } catch (err) {
      toast('<b>Could not open a PR</b> — ' + escapeHtml(String(err.message || err).replace(/^Error: /, '')), 7000);
    } finally {
      el.prBtn.disabled = false;
      el.prBtn.textContent = 'Open PR';
    }
  }

  /* ---------- Share / join ----------
     Sharing hands out a code to a run this machine owns. Joining subscribes to
     one somebody else owns. The difference matters and the UI keeps it visible:
     a guest is taking part in a run, not driving it. */

  /**
   * A message from a person in the room.
   *
   * Rendered distinctly from your own messages and from the agent's, because
   * "who said this" is the first thing you need to know in a room and the last
   * thing you should have to work out from context.
   */
  function renderRoomNote(ev, isDirective) {
    const who = ev.actor.startsWith('human:') ? ev.actor.slice(6) : 'system';
    if (who === (state.settings.displayName || '') && !isDirective) return;
    const seen = state.roomNotes || (state.roomNotes = new Set());
    if (seen.has(ev.id)) return;
    seen.add(ev.id);

    const row = document.createElement('div');
    row.className = 'msg msg-room' + (who === 'system' ? ' is-system' : '');
    row.innerHTML =
      '<div class="room-who">' + escapeHtml(who) + (isDirective ? ' steered the run' : '') + '</div>' +
      '<div class="bubble">' + escapeHtml(ev.payload.text || '') + '</div>';
    el.messages.appendChild(row);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  async function refreshRoomChip() {
    if (!state.activeThreadId) {
      el.shareBtn.classList.add('hidden');
      el.presence.classList.add('hidden');
      return;
    }
    el.shareBtn.classList.remove('hidden');
    const info = await window.quorum.room.info(state.activeThreadId).catch(() => null);
    state.room = info;
    if (info && info.joined) {
      el.shareLabel.textContent = 'In ' + info.code;
      el.shareBtn.classList.add('active');
    } else if (info && info.code) {
      el.shareLabel.textContent = info.code;
      el.shareBtn.classList.add('active');
    } else {
      el.shareLabel.textContent = 'Share';
      el.shareBtn.classList.remove('active');
    }
  }

  function renderPresence(present) {
    const others = (present || []).filter((p) => p.name !== (state.settings.displayName || ''));
    if (!others.length) {
      el.presence.classList.add('hidden');
      el.presence.innerHTML = '';
      return;
    }
    el.presence.classList.remove('hidden');
    el.presence.innerHTML = others
      .map((p) => {
        const initials = p.name.slice(0, 2).toUpperCase();
        const where = p.viewing ? ' · ' + p.viewing : '';
        return '<span class="who" title="' + escapeHtml(p.name + where) + '">' + escapeHtml(initials) + '</span>';
      })
      .join('');
  }

  async function openShare() {
    if (!state.activeThreadId) return;
    const info = state.room;
    if (info && info.joined) {
      // Already a guest here. Sharing again would be nonsense - you are not the
      // one hosting this.
      showRoomModal({
        title: 'You are in ' + info.code,
        code: info.code,
        note: 'Hosted by someone else on ' + info.relay + '. Leave from the thread menu.',
        canStop: false
      });
      return;
    }
    if (info && info.code) {
      showRoomModal({ title: 'Sharing this run', code: info.code, note: 'Relay: ' + info.relay, canStop: true });
      return;
    }
    showRoomModal({ title: 'Share this run', code: 'opening…', note: '', canStop: true });
    try {
      const shared = await window.quorum.room.share(state.activeThreadId);
      el.roomCode.textContent = shared.code;
      el.roomRelayNote.textContent = 'Relay: ' + (shared.joinUrl || '').replace(/\/r\/.*$/, '');
      refreshRoomChip();
    } catch (err) {
      el.roomCode.textContent = '—';
      el.roomRelayNote.textContent = String(err.message || err);
    }
  }

  function showRoomModal({ title, code, note, canStop }) {
    el.roomTitle.textContent = title;
    el.roomCode.textContent = code;
    el.roomRelayNote.textContent = note || '';
    el.roomStop.classList.toggle('hidden', !canStop);
    el.roomSharePane.classList.remove('hidden');
    el.roomJoinPane.classList.add('hidden');
    el.roomModal.classList.remove('hidden');
  }

  function openJoin() {
    el.roomTitle.textContent = 'Join a session';
    el.roomSharePane.classList.add('hidden');
    el.roomJoinPane.classList.remove('hidden');
    el.joinError.classList.add('hidden');
    el.joinRelay.value = state.settings.relayUrl || 'http://127.0.0.1:7788';
    el.roomModal.classList.remove('hidden');
    el.joinCode.focus();
  }

  async function doJoin() {
    const code = el.joinCode.value.trim();
    const relay = el.joinRelay.value.trim();
    if (!code) return;
    el.joinGo.disabled = true;
    el.joinGo.textContent = 'Joining…';
    el.joinError.classList.add('hidden');
    try {
      const thread = await window.quorum.room.join(code, relay);
      await window.quorum.settings.set({ relayUrl: relay });
      state.settings.relayUrl = relay;
      el.roomModal.classList.add('hidden');
      await refreshThreads();
      await selectThread(thread.id);
      toast('<b>Joined ' + escapeHtml(code.toUpperCase()) + '</b> — catching up on the run');
    } catch (err) {
      el.joinError.textContent = String(err.message || err).replace(/^Error: /, '');
      el.joinError.classList.remove('hidden');
    } finally {
      el.joinGo.disabled = false;
      el.joinGo.textContent = 'Join';
    }
  }

  /* ---------- Code (editor) ----------
     The editor reads the same workspace the agent is working in - the worktree
     when the thread has one - so what a person opens is literally what the run
     is changing, not a copy of it. */
  let editor = null;

  function ensureEditor() {
    if (editor) return editor;
    editor = window.QuorumEditor.create({
      root: el.editorRoot,
      api: window.quorum,
      getThreadId: () => state.activeThreadId,
      onDirty: (has) => {
        el.codeSave.classList.toggle('primary', has);
        el.codeSave.disabled = !has;
        el.codeSave.textContent = has ? 'Save' : 'Saved';
      }
    });
    return editor;
  }

  async function openCode() {
    if (!state.activeThreadId) return;
    if (state.diffOpen) closeDiff();
    state.codeOpen = true;
    el.homeView.classList.add('hidden');
    el.chatView.classList.add('hidden');
    el.codeView.classList.remove('hidden');
    el.codeBtn.classList.add('active');
    const t = await window.quorum.threads.get(state.activeThreadId);
    const dir = (t && (t.workDir || t.projectDir)) || '';
    // Split on both separators: these paths are absolute and on Windows they
    // arrive with backslashes, so a forward-slash-only split returns the whole
    // path and the header shows an unreadable temp directory.
    const name = dir.split(/[\\/]/).filter(Boolean).pop() || 'Workspace';
    el.codeTitle.textContent = t && t.branch ? name + '  ·  ' + t.branch : name;
    el.codeTitle.title = dir;
    el.codeSave.disabled = true;
    el.codeSave.textContent = 'Saved';
    await ensureEditor().refresh();
  }

  function closeCode() {
    if (!state.codeOpen) return;
    state.codeOpen = false;
    el.codeView.classList.add('hidden');
    el.codeBtn.classList.remove('active');
    if (state.activeThreadId) el.chatView.classList.remove('hidden');
    else el.homeView.classList.remove('hidden');
  }

  function closeDiff() {
    if (!state.diffOpen) return;
    state.diffOpen = false;
    el.diffView.classList.add('hidden');
    el.changesBtn.classList.remove('active');
    if (state.activeThreadId) el.chatView.classList.remove('hidden');
    else el.homeView.classList.remove('hidden');
  }

  function renderDiffPanel() {
    const files = state.diffFiles;
    const adds = files.reduce((n, f) => n + f.additions, 0);
    const dels = files.reduce((n, f) => n + f.deletions, 0);
    el.diffSummary.textContent = files.length
      ? `${files.length} file${files.length === 1 ? '' : 's'} changed  +${adds} −${dels}`
      : 'No changes';

    el.diffFileList.innerHTML = '';
    files.forEach((f, i) => {
      const b = document.createElement('button');
      b.className = 'dfl-item' + (i === state.diffSel ? ' active' : '');
      const letter = f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M';
      b.innerHTML =
        `<span class="dfl-letter ${letter}">${letter}</span>` +
        `<span class="dfl-path mono" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>` +
        `<span class="dfl-stats mono"><span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span></span>`;
      b.addEventListener('click', () => { state.diffSel = i; renderDiffPanel(); });
      el.diffFileList.appendChild(b);
    });

    if (!files.length) {
      el.diffPane.innerHTML = '<div class="diff-empty">Working tree is clean ✨</div>';
      return;
    }
    const f = files[Math.min(state.diffSel, files.length - 1)];
    el.diffPane.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'diff-pane-head';
    const pathEl = document.createElement('span');
    pathEl.className = 'diff-pane-path mono';
    pathEl.textContent = f.path;
    const revert = document.createElement('button');
    revert.className = 'mini-btn danger';
    revert.textContent = f.untracked ? 'Delete file' : 'Revert file';
    revert.addEventListener('click', async () => {
      if (!confirm((f.untracked ? 'Delete ' : 'Discard changes to ') + f.path + '?')) return;
      const dir = workDirForActive();
      const r = await window.quorum.git.revertFile(dir, f.path, !!f.untracked);
      if (r.ok) {
        toast('<b>' + escapeHtml(f.path) + '</b> ' + (f.untracked ? 'deleted' : 'reverted'));
        state.diffFiles = (await window.quorum.git.diff(dir)) || [];
        state.diffSel = 0;
        renderDiffPanel();
        refreshChangesBadge();
      } else toast('⚠ ' + escapeHtml(r.error || 'Revert failed'));
    });
    head.append(pathEl, revert);

    const table = document.createElement('table');
    table.className = 'diff-table';
    const maxLines = 800;
    for (const l of f.lines.slice(0, maxLines)) {
      const tr = document.createElement('tr');
      tr.className = l.kind;
      if (l.kind === 'hunk') {
        const td = document.createElement('td');
        td.colSpan = 4;
        td.textContent = l.text;
        tr.appendChild(td);
      } else {
        const oldN = document.createElement('td');
        oldN.className = 'dt-num';
        oldN.textContent = l.oldLine != null ? l.oldLine : '';
        const newN = document.createElement('td');
        newN.className = 'dt-num';
        newN.textContent = l.newLine != null ? l.newLine : '';
        const mark = document.createElement('td');
        mark.className = 'dt-mark';
        mark.textContent = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '';
        const text = document.createElement('td');
        text.className = 'dt-text';
        text.textContent = l.text;
        tr.append(oldN, newN, mark, text);
      }
      table.appendChild(tr);
    }
    if (f.lines.length > maxLines) {
      const tr = document.createElement('tr');
      tr.className = 'hunk';
      const td = document.createElement('td');
      td.colSpan = 4;
      td.textContent = `… ${f.lines.length - maxLines} more lines`;
      tr.appendChild(td);
      table.appendChild(tr);
    }
    el.diffPane.append(head, table);
  }

  async function doCommit() {
    const dir = workDirForActive();
    if (!dir || !state.diffFiles.length) return;
    const msg = el.commitMsg.value.trim() || 'Changes from Quorum';
    const r = await window.quorum.git.commit(dir, msg);
    if (r.ok) {
      toast('<b>Committed</b> — ' + escapeHtml(msg));
      el.commitMsg.value = '';
      state.diffFiles = (await window.quorum.git.diff(dir)) || [];
      state.diffSel = 0;
      renderDiffPanel();
      refreshProject();
      refreshChangesBadge();
    } else toast('⚠ Commit failed: ' + escapeHtml(r.error || ''));
  }

  // ---------------- automations ----------------
  async function openAutomations() {
    await renderAutomations();
    el.automationsModal.classList.remove('hidden');
  }

  async function renderAutomations() {
    const autos = await window.quorum.automations.list();
    el.automationList.innerHTML = '';
    if (!autos.length) {
      const d = document.createElement('div');
      d.className = 'modal-desc';
      d.textContent = 'No automations yet.';
      el.automationList.appendChild(d);
    }
    for (const a of autos) {
      const row = document.createElement('div');
      row.className = 'automation-row';
      const main = document.createElement('div');
      main.className = 'ar-main';
      const name = document.createElement('div');
      name.className = 'ar-name';
      name.innerHTML = escapeHtml(a.name) + (a.enabled ? '' : ' <span class="paused">paused</span>');
      const sub = document.createElement('div');
      sub.className = 'ar-sub';
      const ivl = a.everyMinutes >= 10080 ? 'weekly' : a.everyMinutes >= 1440 ? 'daily' : a.everyMinutes >= 60 ? `every ${Math.round(a.everyMinutes / 60)}h` : `every ${a.everyMinutes}m`;
      sub.textContent = `${ivl} · ${a.mode || 'agent'} · ${a.prompt}`;
      main.append(name, sub);

      const runNow = document.createElement('button');
      runNow.className = 'mini-btn';
      runNow.textContent = 'Run now';
      runNow.addEventListener('click', async () => {
        await window.quorum.automations.run(a.id);
        el.automationsModal.classList.add('hidden');
      });
      const tgl = document.createElement('button');
      tgl.className = 'mini-btn';
      tgl.textContent = a.enabled ? 'Pause' : 'Resume';
      tgl.addEventListener('click', async () => {
        await window.quorum.automations.save({ id: a.id, enabled: !a.enabled });
        renderAutomations();
      });
      const x = document.createElement('button');
      x.className = 'row-x';
      x.textContent = '×';
      x.addEventListener('click', async () => {
        await window.quorum.automations.delete(a.id);
        renderAutomations();
      });
      row.append(main, runNow, tgl, x);
      el.automationList.appendChild(row);
    }
  }

  async function addAutomation() {
    const name = el.autoName.value.trim();
    const promptText = el.autoPrompt.value.trim();
    if (!name || !promptText) { toast('⚠ Automation needs a name and a prompt'); return; }
    await window.quorum.automations.save({
      name,
      prompt: promptText,
      everyMinutes: parseInt(el.autoInterval.value, 10),
      mode: el.autoMode.value,
      projectDir: state.project ? state.project.dir : null,
      enabled: true,
      lastRun: Date.now() // first run happens after one interval
    });
    el.autoName.value = '';
    el.autoPrompt.value = '';
    renderAutomations();
  }

  // ---------------- settings ----------------
  function openSettings() {
    el.settingApiKey.value = state.settings.openaiApiKey || '';
    el.settingBaseUrl.value = state.settings.openaiBaseUrl || 'https://api.openai.com/v1';
    el.settingCustomModels.value = state.settings.customModels || '';
    el.settingTheme.value = state.settings.theme || 'dark';
    el.settingNotifications.checked = state.settings.notifications !== false;
    renderPromptList();
    el.settingsModal.classList.remove('hidden');
  }

  function renderPromptList() {
    el.promptList.innerHTML = '';
    state.customPrompts.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'prompt-row';
      const name = document.createElement('span');
      name.className = 'pr-name';
      name.textContent = p.name.startsWith('/') ? p.name : '/' + p.name;
      const text = document.createElement('span');
      text.className = 'pr-text';
      text.textContent = p.prompt;
      const x = document.createElement('button');
      x.className = 'row-x';
      x.textContent = '×';
      x.addEventListener('click', () => {
        state.customPrompts.splice(i, 1);
        renderPromptList();
      });
      row.append(name, text, x);
      el.promptList.appendChild(row);
    });
  }

  async function saveSettings() {
    state.settings = await window.quorum.settings.set({
      openaiApiKey: el.settingApiKey.value.trim(),
      openaiBaseUrl: el.settingBaseUrl.value.trim() || 'https://api.openai.com/v1',
      customModels: el.settingCustomModels.value.trim(),
      theme: el.settingTheme.value,
      notifications: el.settingNotifications.checked,
      customPrompts: state.customPrompts
    });
    applyTheme();
    buildModelPicker();
    el.settingsModal.classList.add('hidden');
    toast('Settings saved');
  }

  // ---------------- misc UI ----------------
  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 200) + 'px';
  }

  function bindEvents() {
    el.newThread.addEventListener('click', newThread);
    el.threadSearch.addEventListener('input', renderThreadList);
    el.archivedToggle.addEventListener('click', () => {
      el.archivedSection.classList.toggle('open');
      el.archivedList.classList.toggle('hidden');
    });
    el.openProject.addEventListener('click', async () => {
      const p = await window.quorum.project.pick();
      if (p) setProject(p);
    });
    el.homeProjectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.homeProjectMenu.classList.contains('hidden')) showProjectMenu();
      else el.homeProjectMenu.classList.add('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!el.homeProjectMenu.contains(e.target) && e.target !== el.homeProjectBtn) {
        el.homeProjectMenu.classList.add('hidden');
      }
    });
    document.querySelectorAll('.suggestion').forEach((b) => {
      b.addEventListener('click', () => {
        el.input.value = b.dataset.prompt;
        autosize();
        sendMessage();
      });
    });

    el.automationsBtn.addEventListener('click', openAutomations);
    el.closeAutomations.addEventListener('click', () => el.automationsModal.classList.add('hidden'));
    el.automationsModal.addEventListener('click', (e) => {
      if (e.target === el.automationsModal) el.automationsModal.classList.add('hidden');
    });
    el.addAutomation.addEventListener('click', addAutomation);

    el.settingsBtn.addEventListener('click', openSettings);
    el.closeSettings.addEventListener('click', () => el.settingsModal.classList.add('hidden'));
    el.saveSettings.addEventListener('click', saveSettings);
    el.settingsModal.addEventListener('click', (e) => {
      if (e.target === el.settingsModal) el.settingsModal.classList.add('hidden');
    });
    el.addPrompt.addEventListener('click', () => {
      const name = el.promptName.value.trim().replace(/^\//, '');
      const promptText = el.promptText.value.trim();
      if (!name || !promptText) return;
      state.customPrompts.push({ name: '/' + name, prompt: promptText });
      el.promptName.value = '';
      el.promptText.value = '';
      renderPromptList();
    });

    el.attachBtn.addEventListener('click', async () => {
      const picked = await window.quorum.attach.pick();
      state.attachments.push(...picked);
      renderAttachRow();
    });

    el.send.addEventListener('click', sendMessage);
    el.stop.addEventListener('click', () => {
      if (state.activeThreadId) window.quorum.agent.cancel(state.activeThreadId);
    });
    el.input.addEventListener('input', () => { autosize(); updatePopup(); });
    el.input.addEventListener('keydown', (e) => {
      if (state.popup) {
        if (e.key === 'ArrowDown') { e.preventDefault(); state.popup.sel = (state.popup.sel + 1) % state.popup.items.length; renderPopup(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); state.popup.sel = (state.popup.sel - 1 + state.popup.items.length) % state.popup.items.length; renderPopup(); return; }
        if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); choosePopup(state.popup.sel); return; }
        if (e.key === 'Escape') { hidePopup(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    el.input.addEventListener('blur', () => setTimeout(hidePopup, 150));

    /* ---------- Share / join ---------- */
    el.pushBtn.addEventListener('click', doPush);
    el.prBtn.addEventListener('click', doOpenPr);
    el.shareBtn.addEventListener('click', openShare);
    el.joinBtn.addEventListener('click', openJoin);
    el.roomClose.addEventListener('click', () => el.roomModal.classList.add('hidden'));
    el.roomModal.addEventListener('click', (ev) => {
      if (ev.target === el.roomModal) el.roomModal.classList.add('hidden');
    });
    el.roomCopy.addEventListener('click', () => {
      navigator.clipboard.writeText(el.roomCode.textContent.trim());
      el.roomCopy.textContent = 'Copied';
      setTimeout(() => (el.roomCopy.textContent = 'Copy'), 1400);
    });
    el.roomStop.addEventListener('click', async () => {
      if (!state.activeThreadId) return;
      await window.quorum.room.unshare(state.activeThreadId);
      el.roomModal.classList.add('hidden');
      refreshRoomChip();
    });
    el.joinGo.addEventListener('click', doJoin);
    el.joinCode.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doJoin(); });

    window.quorum.session.onPresence(({ threadId, present }) => {
      if (threadId !== state.activeThreadId) return;
      renderPresence(present);
    });
    window.quorum.room.onClosed(({ threadId, reason }) => {
      if (threadId === state.activeThreadId) toast('The room closed: ' + reason);
      refreshRoomChip();
    });

    el.codeBtn.addEventListener('click', () => (state.codeOpen ? closeCode() : openCode()));
    el.closeCode.addEventListener('click', closeCode);
    el.codeSave.addEventListener('click', () => editor && editor.save());
    el.changesBtn.addEventListener('click', () => (state.diffOpen ? closeDiff() : openDiff()));
    el.closeDiff.addEventListener('click', closeDiff);
    el.commitBtn.addEventListener('click', doCommit);
    el.commitMsg.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCommit(); });
    el.copyPatchBtn.addEventListener('click', async () => {
      const dir = workDirForActive();
      if (!dir) return;
      const r = await window.quorum.git.copyPatch(dir);
      toast(r.bytes ? '<b>Patch copied</b> — ' + (r.bytes / 1024).toFixed(1) + ' KB' : 'Nothing to copy');
    });

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newThread();
      }
      if (e.key === 'Escape') {
        el.settingsModal.classList.add('hidden');
        el.automationsModal.classList.add('hidden');
        if (state.diffOpen) closeDiff();
      }
    });
  }

  init();
})();
