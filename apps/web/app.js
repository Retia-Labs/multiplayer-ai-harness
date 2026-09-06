/* Plexus web client — talks to the hub over WebSocket; identical UI for browser and desktop shell. */
(function () {
  const $ = (s) => document.querySelector(s);
  const el = {
    login: $('#login'), loginForm: $('#login-form'), loginName: $('#login-name'), loginOrg: $('#login-org'), loginHub: $('#login-hub'),
    app: $('#app'), threadList: $('#thread-list'), threadSearch: $('#thread-search'), newThread: $('#btn-new-thread'), navFleet: $('#nav-fleet'),
    me: $('#me'), settingsBtn: $('#btn-settings'),
    topbarTitle: $('#topbar-title'), topbarBranch: $('#topbar-branch'), topbarWorktree: $('#topbar-worktree'), topbarRuntime: $('#topbar-runtime'),
    presence: $('#presence'), changesBtn: $('#btn-changes'), assignBtn: $('#btn-assign'), assignLabel: $('#assign-label'), auditBtn: $('#btn-audit'),
    activityPanel: $('#activity-panel'),
    assignModal: $('#assign-modal'), closeAssign: $('#btn-close-assign'), assignUser: $('#assign-user'), assignNote: $('#assign-note'), doAssign: $('#btn-do-assign'), unassign: $('#btn-unassign'),
    fleetView: $('#fleet-view'), fleetRuntime: $('#fleet-runtime'), fleetProject: $('#fleet-project'), addProject: $('#btn-add-project'), fleetWorktree: $('#fleet-worktree'),
    composerHostHome: $('#composer-host-home'), runtimeCards: $('#runtime-cards'), attentionList: $('#attention-list'),
    threadView: $('#thread-view'), messages: $('#messages'), working: $('#working'), workingLabel: $('#working-label'), stop: $('#btn-stop'), composerHostThread: $('#composer-host-thread'),
    composer: $('#composer'), input: $('#input'), send: $('#btn-send'), providerSelect: $('#provider-select'), modelSelect: $('#model-select'), effortSelect: $('#effort-select'), presetSelect: $('#preset-select'),
    diffView: $('#diff-view'), diffSummary: $('#diff-summary'), diffFileList: $('#diff-file-list'), diffPane: $('#diff-pane'), commitMsg: $('#commit-msg'), commitBtn: $('#btn-commit'), copyPatchBtn: $('#btn-copy-patch'), closeDiff: $('#btn-close-diff'),
    settingsModal: $('#settings-modal'), closeSettings: $('#btn-close-settings'), settingTheme: $('#setting-theme'), settingNotifications: $('#setting-notifications'), settingsConn: $('#settings-conn'), logout: $('#btn-logout'),
    toasts: $('#toasts')
  };

  const HUB_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  const state = {
    ws: null, me: null, org: null, connected: false,
    threads: new Map(), runtimes: [],
    activeThreadId: null, activeThread: null, subscribedId: null,
    nodes: new Map(),     // itemId -> refs
    plans: new Map(),     // turnId -> plan card
    approvals: new Map(), // requestId -> card wrap
    viewers: [],
    users: [],
    activity: { threads: [], overlaps: [] },
    pending: new Map(),   // command id -> {resolve,reject}
    diffOpen: false, diffFiles: [], diffSel: 0,
    prefs: loadPrefs()
  };

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem('harness.prefs') || '{}'); } catch { return {}; }
  }
  function savePrefs() { try { localStorage.setItem('harness.prefs', JSON.stringify(state.prefs)); } catch {} }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function initials(name) { return (name || '?').split(/[\s._-]+/).map((p) => p[0]).join('').slice(0, 2); }
  function avatar(who, cls = '') {
    const a = document.createElement('span');
    a.className = 'avatar ' + cls;
    a.style.background = (who && who.color) || '#666';
    a.textContent = initials(who && who.name);
    a.title = who && who.name || '';
    return a;
  }
  function toast(html, { action, onAction, ms = 5000 } = {}) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = '<span>' + html + '</span>';
    if (action) {
      const b = document.createElement('button'); b.textContent = action;
      b.addEventListener('click', () => { onAction(); t.remove(); });
      t.appendChild(b);
    }
    el.toasts.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }
  function notify(title, body) {
    if (state.prefs.notifications === false) return;
    try {
      if (Notification.permission === 'granted') new Notification(title, { body, silent: true });
      else if (Notification.permission !== 'denied') Notification.requestPermission();
    } catch {}
  }
  function applyTheme() { document.body.dataset.theme = state.prefs.theme === 'light' ? 'light' : 'dark'; }

  // ================= connection =================
  function connect({ name, org, token }) {
    const ws = new WebSocket(HUB_URL);
    state.ws = ws;
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'client', name, org, token })));
    ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); });
    ws.addEventListener('close', () => {
      state.connected = false;
      if (state.me) {
        toast('Disconnected from hub — reconnecting…');
        setTimeout(() => connect({ token: state.me.token, org: state.org }), 1500);
      } else {
        el.loginHub.textContent = 'Could not reach hub at ' + HUB_URL;
      }
    });
  }

  function send(msg) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg)); }

  function command(threadId, command, runtimeId) {
    const id = 'c_' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      state.pending.set(id, { resolve, reject });
      send({ type: 'command', id, threadId, runtimeId, command });
      setTimeout(() => { if (state.pending.has(id)) { state.pending.delete(id); reject(new Error('command timed out')); } }, 30000);
    });
  }

  function onMessage(m) {
    switch (m.type) {
      case 'welcome':
        state.me = m.user; state.org = m.org; state.connected = true;
        try { localStorage.setItem('harness.session', JSON.stringify({ token: m.user.token, org: m.org, name: m.user.name })); } catch {}
        el.login.classList.add('hidden'); el.app.classList.remove('hidden');
        el.me.innerHTML = ''; el.me.append(avatar(state.me, 'sm'), document.createTextNode(state.me.name + ' · ' + state.org));
        send({ type: 'threads.list' }); send({ type: 'runtimes.list' }); send({ type: 'users.list' }); send({ type: 'workspace.activity' });
        if (state.subscribedId) send({ type: 'thread.subscribe', threadId: state.subscribedId, afterSeq: state.lastSeq || 0 });
        break;
      case 'threads':
        state.threads = new Map(m.threads.map((t) => [t.id, t]));
        renderThreadList(); renderAttention();
        break;
      case 'runtimes':
        state.runtimes = m.runtimes;
        renderRuntimes();
        break;
      case 'thread.updated': onThreadUpdated(m.thread); break;
      case 'users': state.users = m.users; if (!el.assignModal.classList.contains('hidden')) fillAssignUsers(); break;
      case 'workspace.activity': {
        const prevOverlaps = state.activity.overlaps.map((o) => o.projectKey + '::' + o.path);
        state.activity = { threads: m.threads || [], overlaps: m.overlaps || [] };
        for (const o of state.activity.overlaps) {
          const key = o.projectKey + '::' + o.path;
          if (!prevOverlaps.includes(key) && o.severity === 'collision') toast('<b>Collision:</b> ' + esc(o.path) + ' is being changed by ' + esc(o.threads.map((t) => (t.by && t.by.name) || '?').join(' and ')), { ms: 7000 });
        }
        renderActivity();
        break;
      }
      case 'thread.deleted':
        state.threads.delete(m.threadId);
        if (state.activeThreadId === m.threadId) showFleet();
        renderThreadList(); renderAttention();
        break;
      case 'thread.snapshot':
        if (m.thread.id !== state.subscribedId) break;
        state.activeThread = m.thread; state.threads.set(m.thread.id, m.thread);
        clearMessages();
        for (const ev of m.events) applyEvent(ev, { replay: true });
        state.lastSeq = m.events.length ? m.events[m.events.length - 1].seq : 0;
        updateTopbar(); updateWorking(); scrollToBottom(true);
        break;
      case 'event':
        if (m.threadId !== state.subscribedId) break;
        if (m.seq <= (state.lastSeq || 0)) break;
        state.lastSeq = m.seq;
        applyEvent(m, { replay: false });
        break;
      case 'presence':
        if (m.threadId === state.subscribedId) { state.viewers = m.viewers; renderPresence(); }
        break;
      case 'command.result': {
        const p = state.pending.get(m.id);
        if (p) { state.pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || 'command failed')); }
        break;
      }
      case 'error': toast('⚠ ' + esc(m.message)); break;
    }
  }

  function onThreadUpdated(t) {
    const prev = state.threads.get(t.id);
    state.threads.set(t.id, t);
    if (state.activeThreadId === t.id) { state.activeThread = t; updateTopbar(); updateWorking(); }
    renderThreadList(); renderAttention();
    // Cross-thread awareness: approvals and completions on threads I'm not looking at.
    const flags = (t.status && t.status.activeFlags) || [];
    const prevFlags = (prev && prev.status && prev.status.activeFlags) || [];
    if (flags.includes('waitingOnApproval') && !prevFlags.includes('waitingOnApproval') && t.id !== state.activeThreadId) {
      notify('Approval needed', (t.name || 'A thread') + ': ' + ((t.pendingApproval && t.pendingApproval.command) || 'file change'));
      toast('<b>' + esc(t.name) + '</b> needs approval', { action: 'Open', onAction: () => selectThread(t.id) });
    }
    if (t.assignee && state.me && t.assignee.userId === state.me.id && (!prev || !prev.assignee || prev.assignee.userId !== state.me.id)) {
      notify('Thread handed to you', t.name + (t.handoffNote ? ' — ' + t.handoffNote : ''));
      toast('<b>' + esc(t.name) + '</b> was handed off to you' + (t.handoffNote ? ' — ' + esc(t.handoffNote) : ''), { action: 'Open', onAction: () => selectThread(t.id) });
    }
    if (prev && prev.status && prev.status.type === 'active' && t.status && t.status.type !== 'active' && t.id !== state.activeThreadId && prev.lastTurnBy) {
      toast('<b>' + esc(t.name) + '</b> finished — ready for review', { action: 'Open', onAction: () => selectThread(t.id) });
      notify('Thread ready', t.name);
    }
  }

  // ================= fleet =================
  function selectedRuntime() { return state.runtimes.find((r) => r.id === el.fleetRuntime.value) || state.runtimes.find((r) => r.online) || state.runtimes[0]; }

  function renderRuntimes() {
    const prev = el.fleetRuntime.value;
    el.fleetRuntime.innerHTML = '';
    for (const r of state.runtimes) {
      const o = document.createElement('option'); o.value = r.id; o.textContent = (r.online ? '● ' : '○ ') + r.name; o.disabled = !r.online;
      el.fleetRuntime.appendChild(o);
    }
    if (!state.runtimes.length) { const o = document.createElement('option'); o.textContent = 'No runtimes online'; el.fleetRuntime.appendChild(o); }
    const online = state.runtimes.find((r) => r.id === prev && r.online) || state.runtimes.find((r) => r.online);
    if (online) el.fleetRuntime.value = online.id;
    renderProjects(); renderProviderPicker();
    el.addProject.classList.toggle('hidden', !online);

    el.runtimeCards.innerHTML = '';
    if (!state.runtimes.length) { el.runtimeCards.innerHTML = '<div class="attention-empty">No runtimes yet. Start one: <code>node packages/runtime --hub ' + esc(HUB_URL) + ' --name you --project /path/to/repo</code></div>'; }
    for (const r of state.runtimes) {
      const c = document.createElement('div'); c.className = 'runtime-card';
      const head = document.createElement('div'); head.className = 'rc-head';
      head.innerHTML = '<span class="rc-dot ' + (r.online ? 'online' : '') + '"></span>' + esc(r.name) + (r.ownerName ? ' <span class="rc-sub">· ' + esc(r.ownerName) + '</span>' : '');
      const sub = document.createElement('div'); sub.className = 'rc-sub';
      const running = [...state.threads.values()].filter((t) => t.runtimeId === r.id && t.status && t.status.type === 'active').length;
      sub.textContent = (r.projects || []).map((p) => p.name).join(', ') || 'no projects registered';
      sub.textContent += running ? ' · ' + running + ' running' : '';
      const tags = document.createElement('div'); tags.className = 'rc-tags';
      for (const p of r.providers || []) { const t = document.createElement('span'); t.className = 'rc-tag' + (p.configured ? ' on' : ''); t.textContent = p.id; t.title = p.configured ? 'configured' : 'no key'; tags.appendChild(t); }
      for (const x of r.executors || []) if (x.id !== 'local') { const t = document.createElement('span'); t.className = 'rc-tag' + (x.available ? ' on' : ''); t.textContent = x.id; t.title = x.available ? 'available' : 'CLI not installed'; tags.appendChild(t); }
      c.append(head, sub, tags);
      el.runtimeCards.appendChild(c);
    }
  }

  function renderProjects() {
    const r = selectedRuntime();
    el.fleetProject.innerHTML = '';
    for (const p of (r && r.projects) || []) { const o = document.createElement('option'); o.value = p.dir; o.textContent = p.name + (p.branch ? ' · ' + p.branch : ''); el.fleetProject.appendChild(o); }
    if (!el.fleetProject.options.length) { const o = document.createElement('option'); o.value = ''; o.textContent = 'No project registered'; el.fleetProject.appendChild(o); }
  }

  function renderProviderPicker(thread) {
    const r = thread ? state.runtimes.find((x) => x.id === thread.runtimeId) : selectedRuntime();
    const providers = (r && r.providers) || [{ id: 'demo', label: 'Demo agent', configured: true, models: ['demo-agent'] }];
    const want = (thread && thread.settings && thread.settings.provider) || el.providerSelect.value || 'demo';
    el.providerSelect.innerHTML = '';
    for (const p of providers) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label + (p.configured ? '' : ' (no key)'); o.disabled = !p.configured; el.providerSelect.appendChild(o); }
    el.providerSelect.value = providers.some((p) => p.id === want && p.configured) ? want : (providers.find((p) => p.configured) || providers[0]).id;
    renderModelPicker(providers, thread);
  }

  function renderModelPicker(providers, thread) {
    const p = providers.find((x) => x.id === el.providerSelect.value) || providers[0];
    const want = (thread && thread.settings && thread.settings.model) || el.modelSelect.value;
    el.modelSelect.innerHTML = '';
    for (const m of (p && p.models) || []) { const o = document.createElement('option'); o.value = m; o.textContent = m; el.modelSelect.appendChild(o); }
    if (want && [...el.modelSelect.options].some((o) => o.value === want)) el.modelSelect.value = want;
  }

  function renderAttention() {
    const items = [...state.threads.values()].filter((t) => t.status && (t.status.activeFlags || []).includes('waitingOnApproval'));
    el.attentionList.innerHTML = '';
    if (!items.length) { el.attentionList.innerHTML = '<div class="attention-empty">Nothing waiting on a human right now.</div>'; return; }
    for (const t of items) {
      const row = document.createElement('div'); row.className = 'attention-item';
      const main = document.createElement('div'); main.className = 'ai-main';
      main.innerHTML = '<div class="ai-title">' + esc(t.name) + '</div><div class="ai-cmd mono">' + esc((t.pendingApproval && (t.pendingApproval.command || (t.pendingApproval.changes || []).map((c) => c.path).join(', '))) || '') + '</div>';
      const approve = document.createElement('button'); approve.className = 'mini-btn primary'; approve.textContent = 'Approve';
      approve.addEventListener('click', () => command(t.id, { method: 'approval/resolve', requestId: t.pendingApproval.requestId, decision: 'accept' }).catch((e) => toast('⚠ ' + esc(e.message))));
      const decline = document.createElement('button'); decline.className = 'mini-btn danger'; decline.textContent = 'Decline';
      decline.addEventListener('click', () => command(t.id, { method: 'approval/resolve', requestId: t.pendingApproval.requestId, decision: 'decline' }).catch((e) => toast('⚠ ' + esc(e.message))));
      const open = document.createElement('button'); open.className = 'mini-btn'; open.textContent = 'Open';
      open.addEventListener('click', () => selectThread(t.id));
      row.append(main, approve, decline, open);
      el.attentionList.appendChild(row);
    }
  }

  function renderActivity() {
    const { threads, overlaps } = state.activity;
    el.activityPanel.innerHTML = '';
    if (!threads.length) { el.activityPanel.innerHTML = '<div class="activity-empty">No agents have touched files in the last 30 minutes.</div>'; return; }
    for (const o of overlaps) {
      const row = document.createElement('div'); row.className = 'overlap-item ' + o.severity;
      const path = document.createElement('span'); path.className = 'ov-path'; path.textContent = o.path;
      const who = document.createElement('span'); who.className = 'ov-who';
      who.append(document.createTextNode('changed by '));
      o.threads.forEach((t, i) => { if (i) who.append(document.createTextNode(' and ')); who.append(avatar(t.by || { name: '?' }, 'sm'), document.createTextNode((t.by && t.by.name) || '?' + (t.worktree ? ' (worktree ' + t.branch + ')' : ''))); });
      const sev = document.createElement('span'); sev.className = 'ov-sev'; sev.textContent = o.severity === 'collision' ? 'collision' : 'merge risk';
      row.append(path, who, sev);
      el.activityPanel.appendChild(row);
    }
    for (const t of threads) {
      const row = document.createElement('div'); row.className = 'activity-row';
      const live = document.createElement('span'); live.className = 'ar-live' + (t.active ? ' on' : '');
      const title = document.createElement('span'); title.className = 'ar-title'; title.textContent = t.name;
      const files = document.createElement('span'); files.className = 'ar-files'; files.textContent = t.files.map((f) => f.path).join('  ') || (t.active ? 'running, no file changes yet' : '');
      const branch = document.createElement('span'); branch.className = 'chip mono'; branch.textContent = (t.worktree ? '⎇ ' : '') + (t.branch || '');
      row.append(live, avatar(t.by || { name: '?' }, 'sm'), title, files, branch);
      row.addEventListener('click', () => selectThread(t.threadId));
      el.activityPanel.appendChild(row);
    }
  }

  // ================= views =================
  function showFleet() {
    if (state.subscribedId) send({ type: 'thread.unsubscribe', threadId: state.subscribedId });
    state.activeThreadId = null; state.activeThread = null; state.subscribedId = null; state.viewers = [];
    closeDiff();
    el.threadView.classList.add('hidden'); el.fleetView.classList.remove('hidden');
    el.composerHostHome.appendChild(el.composer); el.composer.classList.remove('hidden');
    el.navFleet.classList.add('active');
    renderProviderPicker(); updateTopbar(); renderPresence(); renderThreadList();
    el.input.focus();
  }

  function selectThread(id) {
    if (state.subscribedId && state.subscribedId !== id) send({ type: 'thread.unsubscribe', threadId: state.subscribedId });
    state.activeThreadId = id; state.subscribedId = id; state.lastSeq = 0;
    state.activeThread = state.threads.get(id) || null;
    closeDiff();
    el.fleetView.classList.add('hidden'); el.threadView.classList.remove('hidden');
    el.composerHostThread.appendChild(el.composer); el.composer.classList.remove('hidden');
    el.navFleet.classList.remove('active');
    clearMessages();
    renderProviderPicker(state.activeThread);
    if (state.activeThread && state.activeThread.settings) {
      const s = state.activeThread.settings;
      if (s.effort) el.effortSelect.value = s.effort;
      el.presetSelect.value = presetFor(s);
    }
    send({ type: 'thread.subscribe', threadId: id });
    updateTopbar(); renderThreadList();
    el.input.focus();
  }

  function presetFor(s) {
    if (s.sandboxPolicy === 'read-only') return 'read-only';
    if (s.sandboxPolicy === 'danger-full-access') return 'full-access';
    if (s.approvalPolicy === 'untrusted') return 'agent-untrusted';
    return 'agent';
  }

  function updateTopbar() {
    const t = state.activeThread;
    if (!t) {
      el.topbarTitle.textContent = 'Fleet'; el.topbarBranch.classList.add('hidden'); el.topbarWorktree.classList.add('hidden'); el.topbarRuntime.classList.add('hidden'); el.changesBtn.classList.add('hidden'); el.assignBtn.classList.add('hidden'); el.auditBtn.classList.add('hidden');
      return;
    }
    el.assignBtn.classList.remove('hidden'); el.auditBtn.classList.remove('hidden');
    el.assignLabel.innerHTML = '';
    if (t.assignee) { el.assignLabel.append(avatar(t.assignee, 'sm'), document.createTextNode(' ' + t.assignee.name)); el.assignLabel.parentElement.title = 'Assigned to ' + t.assignee.name + (t.handoffNote ? ' — ' + t.handoffNote : ''); }
    else el.assignLabel.textContent = 'Hand off';
    el.topbarTitle.textContent = t.name;
    el.topbarBranch.textContent = t.branch || ''; el.topbarBranch.classList.toggle('hidden', !t.branch);
    el.topbarWorktree.classList.toggle('hidden', !t.worktree);
    el.topbarRuntime.textContent = t.runtimeName || t.runtimeId; el.topbarRuntime.classList.remove('hidden');
    el.changesBtn.classList.toggle('hidden', !t.cwd);
  }

  function renderPresence() {
    el.presence.innerHTML = '';
    if (!state.activeThreadId) return;
    for (const v of state.viewers) el.presence.appendChild(avatar(v));
    if (state.viewers.length > 1) { const l = document.createElement('span'); l.className = 'presence-label'; l.textContent = state.viewers.length + ' watching'; el.presence.appendChild(l); }
  }

  function updateWorking() {
    const t = state.activeThread;
    const active = !!(t && t.status && t.status.type === 'active');
    el.working.classList.toggle('hidden', !active);
    el.send.classList.toggle('steer', active);
    el.send.title = active ? 'Steer the running turn' : 'Send';
    el.workingLabel.textContent = active && (t.status.activeFlags || []).includes('waitingOnApproval') ? 'Waiting for approval…' : 'Working…';
  }

  // ================= sidebar =================
  function groupLabel(ts) {
    const d = new Date(ts), today = new Date(); today.setHours(0, 0, 0, 0);
    if (d >= today) return 'Today';
    if (d >= new Date(today.getTime() - 86400000)) return 'Yesterday';
    if (d >= new Date(today.getTime() - 6 * 86400000)) return 'Previous 7 days';
    return 'Older';
  }

  function renderThreadList() {
    const q = el.threadSearch.value.trim().toLowerCase();
    const list = [...state.threads.values()].filter((t) => !q || (t.name || '').toLowerCase().includes(q)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    el.threadList.innerHTML = '';
    if (!list.length) { el.threadList.innerHTML = '<div class="thread-empty">' + (q ? 'No matching threads' : 'No threads in this org yet') + '</div>'; return; }
    let last = null;
    for (const t of list) {
      const g = groupLabel(t.updatedAt || t.createdAt);
      if (g !== last) { last = g; const l = document.createElement('div'); l.className = 'thread-group-label'; l.textContent = g; el.threadList.appendChild(l); }
      const item = document.createElement('div'); item.className = 'thread-item' + (t.id === state.activeThreadId ? ' active' : '');
      const status = document.createElement('span'); status.className = 't-status';
      const flags = (t.status && t.status.activeFlags) || [];
      if (flags.includes('waitingOnApproval')) status.innerHTML = '<span class="t-dot"></span>';
      else if (t.status && t.status.type === 'active') status.innerHTML = '<span class="t-spin"></span>';
      const av = avatar(t.createdBy || { name: '?' }, 'sm');
      const title = document.createElement('span'); title.className = 't-title';
      title.textContent = t.name || 'New thread';
      const sub = document.createElement('span'); sub.className = 't-sub';
      sub.textContent = (t.assignee && state.me && t.assignee.userId === state.me.id ? '→ assigned to you · ' : '') + (t.cwd ? t.cwd.split('/').pop() : '') + (t.runtimeName ? ' · ' + t.runtimeName : '');
      title.appendChild(sub);
      const del = document.createElement('button'); del.className = 't-del'; del.title = 'Delete thread';
      del.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>';
      del.addEventListener('click', (e) => { e.stopPropagation(); if (confirm('Delete thread "' + t.name + '"?')) send({ type: 'thread.delete', threadId: t.id }); });
      if (t.assignee) { const asg = avatar(t.assignee, 'sm'); asg.classList.add('t-assignee'); asg.title = 'Assigned to ' + t.assignee.name; item.append(status, av, title, asg, del); }
      else item.append(status, av, title, del);
      item.addEventListener('click', () => selectThread(t.id));
      el.threadList.appendChild(item);
    }
  }

  // ================= event rendering =================
  function clearMessages() { state.nodes.clear(); state.plans.clear(); state.approvals.clear(); el.messages.innerHTML = ''; }
  function scrollToBottom(force) { const m = el.messages; if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTop = m.scrollHeight; }
  function msgWrap(cls) { const w = document.createElement('div'); w.className = 'msg' + (cls ? ' ' + cls : ''); el.messages.appendChild(w); return w; }

  function applyEvent(ev, { replay }) {
    switch (ev.method) {
      case 'turn/started': {
        const d = document.createElement('div'); d.className = 'turn-divider';
        d.append(avatar(ev.by || { name: '?' }, 'sm'), document.createTextNode((ev.by ? ev.by.name : 'someone') + ' started a turn · ' + (ev.provider || '') + (ev.model ? ' / ' + ev.model : '')));
        el.messages.appendChild(d);
        break;
      }
      case 'item/started': renderItem(ev.item, { done: false, replay }); break;
      case 'item/completed': {
        const ref = state.nodes.get(ev.item.id);
        if (!ref) { renderItem(ev.item, { done: true, replay }); break; }
        finalizeItem(ref, ev.item);
        break;
      }
      case 'item/agentMessage/delta': { const r = state.nodes.get(ev.itemId); if (r && r.kind === 'agentMessage') { r.text += ev.delta; r.md.innerHTML = window.renderMarkdown(r.text); } break; }
      case 'item/reasoning/textDelta': { const r = state.nodes.get(ev.itemId); if (r && r.kind === 'reasoning') r.body.textContent += ev.delta; break; }
      case 'item/commandExecution/outputDelta': { const r = state.nodes.get(ev.itemId); if (r && r.kind === 'commandExecution') r.out.textContent += ev.delta; break; }
      case 'turn/plan/updated': renderPlan(ev); break;
      case 'item/commandExecution/requestApproval': case 'item/fileChange/requestApproval': renderApproval(ev); break;
      case 'serverRequest/resolved': resolveApprovalCard(ev); break;
      case 'turn/completed': {
        if (ev.usage) { const m = document.createElement('div'); m.className = 'turn-meta'; const total = (ev.usage.input || 0) + (ev.usage.output || 0); m.textContent = `Turn ${ev.status} · ${total.toLocaleString()} tokens`; el.messages.appendChild(m); }
        else if (ev.status !== 'completed') { const m = document.createElement('div'); m.className = ev.status === 'failed' ? 'turn-error' : 'turn-meta'; m.textContent = ev.status === 'failed' ? '⚠ ' + ((ev.error && ev.error.message) || 'turn failed') : 'Turn ' + ev.status; el.messages.appendChild(m); }
        for (const [, w] of state.approvals) w.remove(); state.approvals.clear();
        if (!replay && state.diffOpen) openDiff();
        break;
      }
      case 'thread/name/updated': if (state.activeThread) { state.activeThread.name = ev.name; updateTopbar(); } break;
      case 'thread/assignee/updated': {
        const d = document.createElement('div'); d.className = 'handoff-note';
        const hn = document.createElement('span'); hn.className = 'hn';
        hn.append(avatar(ev.by || { name: '?' }, 'sm'), document.createTextNode(((ev.by && ev.by.name) || 'someone') + (ev.assignee ? ' handed this thread to ' : ' cleared the assignee')));
        if (ev.assignee) hn.append(avatar(ev.assignee, 'sm'), document.createTextNode(ev.assignee.name));
        if (ev.note) hn.append(document.createTextNode(' — “' + ev.note + '”'));
        d.appendChild(hn); el.messages.appendChild(d);
        if (state.activeThread) { state.activeThread.assignee = ev.assignee || null; state.activeThread.handoffNote = ev.note || null; updateTopbar(); }
        break;
      }
      case 'error': { const d = document.createElement('div'); d.className = 'turn-error'; d.textContent = '⚠ ' + ev.message; el.messages.appendChild(d); break; }
    }
    scrollToBottom(!replay);
  }

  function renderItem(item, { done, replay }) {
    if (item.type === 'userMessage') {
      const wrap = msgWrap('msg-user' + (item.delivery === 'steer' ? ' steer' : ''));
      wrap.style.setProperty('--by-color', (item.by && item.by.color) || 'transparent');
      const by = document.createElement('div'); by.className = 'by';
      by.append(avatar(item.by || { name: '?' }, 'sm'), document.createTextNode((item.by ? item.by.name : '') + (item.delivery === 'steer' ? ' · steered' : '')));
      if (item.images && item.images.length) { const imgs = document.createElement('div'); imgs.className = 'bubble-imgs'; for (const u of item.images) { const i = document.createElement('img'); i.src = u; imgs.appendChild(i); } wrap.appendChild(imgs); }
      const b = document.createElement('div'); b.className = 'bubble'; b.textContent = item.text;
      wrap.append(by, b);
      state.nodes.set(item.id, { kind: 'userMessage', wrap });
    } else if (item.type === 'agentMessage') {
      const wrap = msgWrap('msg-assistant');
      const md = document.createElement('div'); md.className = 'md'; md.innerHTML = window.renderMarkdown(item.text || '');
      wrap.appendChild(md);
      state.nodes.set(item.id, { kind: 'agentMessage', wrap, md, text: item.text || '' });
    } else if (item.type === 'reasoning') {
      const wrap = msgWrap('reasoning' + (done ? ' collapsed' : ' thinking'));
      const head = document.createElement('div'); head.className = 'rsn-head'; head.textContent = done ? 'Thought about it' : 'Thinking…';
      const body = document.createElement('div'); body.className = 'rsn-body'; body.textContent = item.text || '';
      head.addEventListener('click', () => wrap.classList.toggle('collapsed'));
      wrap.append(head, body);
      state.nodes.set(item.id, { kind: 'reasoning', wrap, head, body });
    } else if (item.type === 'commandExecution') {
      const wrap = msgWrap();
      const card = document.createElement('div'); card.className = 'cmd-card' + (done && item.status === 'completed' ? ' collapsed' : '');
      const head = document.createElement('div'); head.className = 'cmd-head';
      const dot = document.createElement('span'); dot.className = 'cmd-status ' + (item.status || 'inProgress');
      const title = document.createElement('span'); title.className = 'cmd-title mono'; title.innerHTML = '<b>$</b> '; title.appendChild(document.createTextNode(item.command));
      const ex = document.createElement('span'); ex.className = 'cmd-exec'; ex.textContent = item.executor || 'local';
      const chev = document.createElement('span'); chev.className = 'cmd-chevron'; chev.textContent = '▾';
      head.append(dot, title, ex, chev);
      const out = document.createElement('div'); out.className = 'cmd-output mono'; out.textContent = item.aggregatedOutput || '';
      head.addEventListener('click', () => card.classList.toggle('collapsed'));
      card.append(head, out); wrap.appendChild(card);
      state.nodes.set(item.id, { kind: 'commandExecution', card, dot, out });
    } else if (item.type === 'fileChange') {
      const wrap = msgWrap();
      const card = document.createElement('div'); card.className = 'edit-card' + (done ? ' collapsed' : '');
      for (const c of item.changes || []) {
        const head = document.createElement('div'); head.className = 'edit-head';
        const p = document.createElement('span'); p.className = 'edit-path mono'; p.textContent = c.path;
        const badge = document.createElement('span'); badge.className = 'edit-badge'; badge.textContent = item.status === 'declined' ? 'declined' : item.status === 'failed' ? 'failed' : c.kind === 'add' ? 'new' : c.kind === 'delete' ? 'deleted' : 'edited';
        const stats = document.createElement('span'); stats.className = 'edit-stats mono'; stats.innerHTML = '<span class="add">+' + (c.additions || 0) + '</span><span class="del">−' + (c.deletions || 0) + '</span>';
        const chev = document.createElement('span'); chev.className = 'cmd-chevron'; chev.textContent = '▾';
        head.append(p, badge, stats, chev);
        const diff = document.createElement('div'); diff.className = 'edit-diff';
        for (const l of c.lines || []) { const row = document.createElement('div'); row.className = 'diff-line ' + l.kind; row.innerHTML = '<span class="dl-mark">' + (l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '') + '</span>'; const t = document.createElement('span'); t.className = 'dl-text'; t.textContent = l.text; row.appendChild(t); diff.appendChild(row); }
        head.addEventListener('click', () => card.classList.toggle('collapsed'));
        card.append(head, diff);
      }
      wrap.appendChild(card);
      state.nodes.set(item.id, { kind: 'fileChange', card, badges: [...card.querySelectorAll('.edit-badge')] });
    }
  }

  function finalizeItem(ref, item) {
    if (ref.kind === 'agentMessage') { ref.text = item.text || ''; ref.md.innerHTML = window.renderMarkdown(ref.text); }
    else if (ref.kind === 'reasoning') { ref.wrap.classList.remove('thinking'); ref.wrap.classList.add('collapsed'); ref.head.textContent = 'Thought about it'; ref.body.textContent = item.text || ref.body.textContent; }
    else if (ref.kind === 'commandExecution') { ref.dot.className = 'cmd-status ' + item.status; ref.out.textContent = item.aggregatedOutput || ''; if (item.status === 'completed') ref.card.classList.add('collapsed'); }
    else if (ref.kind === 'fileChange') { for (const b of ref.badges) if (item.status === 'declined' || item.status === 'failed') b.textContent = item.status; if (item.status === 'completed') ref.card.classList.add('collapsed'); }
  }

  function renderPlan(ev) {
    let card = state.plans.get(ev.turnId);
    if (!card) { const wrap = msgWrap(); card = document.createElement('div'); card.className = 'plan-card'; wrap.appendChild(card); state.plans.set(ev.turnId, card); }
    card.innerHTML = '<div class="plan-title">Plan' + (ev.explanation ? ' — <span>' + esc(ev.explanation) + '</span>' : '') + '</div>';
    const steps = document.createElement('div'); steps.className = 'plan-steps';
    for (const s of ev.plan || []) { const row = document.createElement('div'); row.className = 'plan-step ' + (s.status || 'pending'); row.innerHTML = '<span class="ps-box">' + (s.status === 'completed' ? '✓' : '') + '</span>'; const l = document.createElement('span'); l.textContent = s.step; row.appendChild(l); steps.appendChild(row); }
    card.appendChild(steps);
  }

  function renderApproval(ev) {
    const wrap = msgWrap('approval-wrap');
    const card = document.createElement('div'); card.className = 'approval-card' + (ev.collision ? ' collision' : '');
    const isFile = ev.method === 'item/fileChange/requestApproval';
    card.innerHTML = '<div class="approval-title">' + (ev.collision ? 'Collision — another agent changed this file' : isFile ? 'Agent wants to write outside the workspace' : 'Agent wants to run a command') + '</div>' +
      (ev.reason ? '<div class="approval-reason">' + esc(ev.reason) + '</div>' : '');
    if (ev.collision) { const c = document.createElement('div'); c.className = 'approval-collision'; c.append(avatar(ev.collision.by || { name: '?' }, 'sm'), document.createTextNode('Open “' + ev.collision.name + '” to coordinate, or approve to overwrite.')); card.appendChild(c); }
    const cmd = document.createElement('div'); cmd.className = 'approval-cmd mono';
    cmd.textContent = isFile ? (ev.changes || []).map((c) => c.kind + ' ' + c.path).join('\n') : '$ ' + ev.command;
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    const mk = (label, decision, cls) => { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.dataset.decision = decision; b.addEventListener('click', () => command(state.activeThreadId, { method: 'approval/resolve', requestId: ev.requestId, decision }).catch((e) => toast('⚠ ' + esc(e.message)))); return b; };
    actions.append(mk('Approve', 'accept', 'approve'), mk('Approve for session', 'acceptForSession', 'secondary'), mk('Decline', 'decline', 'secondary'), mk('Cancel turn', 'cancel', 'secondary'));
    card.append(cmd, actions); wrap.appendChild(card);
    state.approvals.set(ev.requestId, wrap);
  }

  function resolveApprovalCard(ev) {
    const wrap = state.approvals.get(ev.requestId);
    state.approvals.delete(ev.requestId);
    const chip = document.createElement('div');
    chip.className = 'msg';
    const inner = document.createElement('span'); inner.className = 'resolved-chip' + (ev.decision === 'accept' || ev.decision === 'acceptForSession' ? '' : ' decline');
    inner.append(avatar(ev.by || { name: '?' }, 'sm'), document.createTextNode((ev.by ? ev.by.name : 'someone') + ' ' + ({ accept: 'approved', acceptForSession: 'approved for the session', decline: 'declined', cancel: 'cancelled the turn' }[ev.decision] || ev.decision)));
    chip.appendChild(inner);
    if (wrap) wrap.replaceWith(chip); else el.messages.appendChild(chip);
  }

  // ================= sending =================
  async function sendMessage() {
    const text = el.input.value.trim();
    if (!text) return;
    const settings = { provider: el.providerSelect.value, model: el.modelSelect.value, effort: el.effortSelect.value, preset: el.presetSelect.value };
    try {
      if (!state.activeThreadId) {
        const r = selectedRuntime();
        if (!r || !r.online) { toast('⚠ No runtime online to run this thread'); return; }
        const cwd = el.fleetProject.value;
        if (!cwd) { toast('⚠ Register a project on the runtime first'); return; }
        const { thread } = await command(null, { method: 'thread/start', cwd, worktree: el.fleetWorktree.checked, settings }, r.id);
        el.fleetWorktree.checked = false;
        state.threads.set(thread.id, thread);
        selectThread(thread.id);
        el.input.value = ''; autosize();
        await command(thread.id, { method: 'turn/start', input: [{ type: 'text', text }], settings });
        return;
      }
      const t = state.activeThread;
      el.input.value = ''; autosize();
      if (t && t.status && t.status.type === 'active' && t.activeTurnId) {
        await command(t.id, { method: 'turn/steer', input: [{ type: 'text', text }], expectedTurnId: t.activeTurnId });
      } else {
        await command(t.id, { method: 'turn/start', input: [{ type: 'text', text }], settings });
      }
    } catch (e) { toast('⚠ ' + esc(e.message)); }
  }

  function autosize() { el.input.style.height = 'auto'; el.input.style.height = Math.min(el.input.scrollHeight, 200) + 'px'; }

  // ================= diff =================
  async function openDiff() {
    const t = state.activeThread; if (!t) return;
    state.diffOpen = true;
    el.threadView.classList.add('hidden'); el.diffView.classList.remove('hidden'); el.changesBtn.classList.add('active');
    el.diffPane.innerHTML = '<div class="diff-empty">Loading…</div>';
    try { const r = await command(t.id, { method: 'git/diff' }); state.diffFiles = r.files || []; } catch (e) { state.diffFiles = []; toast('⚠ ' + esc(e.message)); }
    state.diffSel = Math.min(state.diffSel, Math.max(state.diffFiles.length - 1, 0));
    renderDiff();
  }
  function closeDiff() {
    if (!state.diffOpen) return;
    state.diffOpen = false; el.diffView.classList.add('hidden'); el.changesBtn.classList.remove('active');
    if (state.activeThreadId) el.threadView.classList.remove('hidden'); else el.fleetView.classList.remove('hidden');
  }
  function renderDiff() {
    const files = state.diffFiles;
    const adds = files.reduce((n, f) => n + f.additions, 0), dels = files.reduce((n, f) => n + f.deletions, 0);
    el.diffSummary.textContent = files.length ? `${files.length} file${files.length === 1 ? '' : 's'} changed  +${adds} −${dels}` : 'No changes';
    el.diffFileList.innerHTML = '';
    files.forEach((f, i) => {
      const b = document.createElement('button'); b.className = 'dfl-item' + (i === state.diffSel ? ' active' : '');
      const letter = f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M';
      b.innerHTML = '<span class="dfl-letter ' + letter + '">' + letter + '</span><span class="dfl-path mono">' + esc(f.path) + '</span><span class="dfl-stats mono"><span class="add">+' + f.additions + '</span><span class="del">−' + f.deletions + '</span></span>';
      b.addEventListener('click', () => { state.diffSel = i; renderDiff(); });
      el.diffFileList.appendChild(b);
    });
    if (!files.length) { el.diffPane.innerHTML = '<div class="diff-empty">Working tree is clean ✨</div>'; return; }
    const f = files[state.diffSel];
    el.diffPane.innerHTML = '';
    const head = document.createElement('div'); head.className = 'diff-pane-head';
    const p = document.createElement('span'); p.className = 'diff-pane-path mono'; p.textContent = f.path;
    const revert = document.createElement('button'); revert.className = 'mini-btn danger'; revert.textContent = f.untracked ? 'Delete file' : 'Revert file';
    revert.addEventListener('click', async () => {
      if (!confirm((f.untracked ? 'Delete ' : 'Discard changes to ') + f.path + '?')) return;
      try { await command(state.activeThreadId, { method: 'git/revertFile', path: f.path, untracked: !!f.untracked }); toast('<b>' + esc(f.path) + '</b> ' + (f.untracked ? 'deleted' : 'reverted')); openDiff(); } catch (e) { toast('⚠ ' + esc(e.message)); }
    });
    head.append(p, revert);
    const table = document.createElement('table'); table.className = 'diff-table';
    for (const l of f.lines.slice(0, 800)) {
      const tr = document.createElement('tr'); tr.className = l.kind;
      if (l.kind === 'hunk') { const td = document.createElement('td'); td.colSpan = 4; td.textContent = l.text; tr.appendChild(td); }
      else {
        for (const [cls, val] of [['dt-num', l.oldLine], ['dt-num', l.newLine], ['dt-mark', l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''], ['dt-text', l.text]]) { const td = document.createElement('td'); td.className = cls; td.textContent = val == null ? '' : val; tr.appendChild(td); }
      }
      table.appendChild(tr);
    }
    el.diffPane.append(head, table);
  }

  function fillAssignUsers() {
    const cur = el.assignUser.value;
    el.assignUser.innerHTML = '';
    for (const u of state.users) { const o = document.createElement('option'); o.value = u.id; o.textContent = u.name + (state.me && u.id === state.me.id ? ' (me)' : ''); el.assignUser.appendChild(o); }
    const want = cur || (state.activeThread && state.activeThread.assignee && state.activeThread.assignee.userId);
    if (want && [...el.assignUser.options].some((o) => o.value === want)) el.assignUser.value = want;
  }

  // ================= events =================
  function bind() {
    el.loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = el.loginName.value.trim(); if (!name) return;
      connect({ name, org: el.loginOrg.value.trim() || 'local' });
    });
    el.newThread.addEventListener('click', showFleet);
    el.navFleet.addEventListener('click', showFleet);
    el.threadSearch.addEventListener('input', renderThreadList);
    el.fleetRuntime.addEventListener('change', () => { renderProjects(); renderProviderPicker(); });
    el.providerSelect.addEventListener('change', () => {
      const r = state.activeThread ? state.runtimes.find((x) => x.id === state.activeThread.runtimeId) : selectedRuntime();
      renderModelPicker((r && r.providers) || []);
      if (r && el.providerSelect.value !== 'demo') command(null, { method: 'model/list', provider: el.providerSelect.value }, r.id).then((res) => { if (res.models && res.models.length) { const cur = el.modelSelect.value; el.modelSelect.innerHTML = ''; for (const m of res.models) { const o = document.createElement('option'); o.value = m; o.textContent = m; el.modelSelect.appendChild(o); } if (res.models.includes(cur)) el.modelSelect.value = cur; } }).catch(() => {});
    });
    el.addProject.addEventListener('click', async () => {
      const r = selectedRuntime(); if (!r) return;
      let dir = null;
      if (window.harnessDesktop && window.harnessDesktop.pickFolder) dir = await window.harnessDesktop.pickFolder();
      else dir = prompt('Absolute path of a folder on runtime "' + r.name + '":');
      if (!dir) return;
      try { await command(null, { method: 'project/add', dir }, r.id); toast('Project registered'); } catch (e) { toast('⚠ ' + esc(e.message)); }
    });
    document.querySelectorAll('.suggestion').forEach((b) => b.addEventListener('click', () => { el.input.value = b.dataset.prompt; autosize(); sendMessage(); }));
    el.send.addEventListener('click', sendMessage);
    el.input.addEventListener('input', autosize);
    el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    el.stop.addEventListener('click', () => { const t = state.activeThread; if (t && t.activeTurnId) command(t.id, { method: 'turn/interrupt', turnId: t.activeTurnId }).catch(() => {}); });
    el.assignBtn.addEventListener('click', () => {
      send({ type: 'users.list' });
      fillAssignUsers();
      el.assignNote.value = '';
      el.assignModal.classList.remove('hidden');
    });
    el.closeAssign.addEventListener('click', () => el.assignModal.classList.add('hidden'));
    el.assignModal.addEventListener('click', (e) => { if (e.target === el.assignModal) el.assignModal.classList.add('hidden'); });
    el.doAssign.addEventListener('click', async () => {
      const u = state.users.find((x) => x.id === el.assignUser.value); if (!u) return;
      try { await command(state.activeThreadId, { method: 'thread/assign', assignee: { userId: u.id, name: u.name, color: u.color }, note: el.assignNote.value.trim() }); el.assignModal.classList.add('hidden'); toast('Handed off to <b>' + esc(u.name) + '</b>'); } catch (e) { toast('⚠ ' + esc(e.message)); }
    });
    el.unassign.addEventListener('click', async () => {
      try { await command(state.activeThreadId, { method: 'thread/assign', assignee: null }); el.assignModal.classList.add('hidden'); } catch (e) { toast('⚠ ' + esc(e.message)); }
    });
    el.auditBtn.addEventListener('click', async () => {
      const t = state.activeThread; if (!t) return;
      try {
        const r = await fetch('/api/threads/' + t.id + '/events?limit=500'); const j = await r.json();
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), thread: j.thread, events: j.events }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'audit-' + t.id + '.json'; document.body.appendChild(a); a.click(); a.remove();
        toast('<b>Audit log exported</b> — ' + j.events.length + ' events');
      } catch (e) { toast('⚠ ' + esc(e.message)); }
    });
    el.changesBtn.addEventListener('click', () => (state.diffOpen ? closeDiff() : openDiff()));
    el.closeDiff.addEventListener('click', closeDiff);
    el.commitBtn.addEventListener('click', async () => {
      const msg = el.commitMsg.value.trim() || 'Changes from harness';
      try { const r = await command(state.activeThreadId, { method: 'git/commit', message: msg }); if (r.ok) { toast('<b>Committed</b> — ' + esc(msg)); el.commitMsg.value = ''; openDiff(); } else toast('⚠ ' + esc(r.error || 'commit failed')); } catch (e) { toast('⚠ ' + esc(e.message)); }
    });
    el.commitMsg.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.commitBtn.click(); });
    el.copyPatchBtn.addEventListener('click', async () => {
      try { const r = await command(state.activeThreadId, { method: 'git/patch' }); await navigator.clipboard.writeText(r.patch || ''); toast('<b>Patch copied</b> — ' + ((r.patch || '').length / 1024).toFixed(1) + ' KB'); } catch (e) { toast('⚠ ' + esc(e.message)); }
    });
    el.settingsBtn.addEventListener('click', () => {
      el.settingTheme.value = state.prefs.theme || 'dark'; el.settingNotifications.checked = state.prefs.notifications !== false;
      el.settingsConn.textContent = HUB_URL + ' · org ' + state.org + ' · ' + (state.me ? state.me.name : '');
      el.settingsModal.classList.remove('hidden');
    });
    el.closeSettings.addEventListener('click', () => el.settingsModal.classList.add('hidden'));
    el.settingsModal.addEventListener('click', (e) => { if (e.target === el.settingsModal) el.settingsModal.classList.add('hidden'); });
    el.settingTheme.addEventListener('change', () => { state.prefs.theme = el.settingTheme.value; savePrefs(); applyTheme(); });
    el.settingNotifications.addEventListener('change', () => { state.prefs.notifications = el.settingNotifications.checked; savePrefs(); });
    el.logout.addEventListener('click', () => { try { localStorage.removeItem('harness.session'); } catch {} location.reload(); });
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); showFleet(); }
      if (e.key === 'Escape') { el.settingsModal.classList.add('hidden'); el.assignModal.classList.add('hidden'); if (state.diffOpen) closeDiff(); }
    });
  }

  // ================= boot =================
  applyTheme();
  bind();
  el.loginHub.textContent = 'hub: ' + HUB_URL;
  const params = new URLSearchParams(location.search);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('harness.session') || 'null'); } catch {}
  if (params.get('name')) connect({ name: params.get('name'), org: params.get('org') || 'local' });
  else if (saved && saved.token) connect({ token: saved.token, org: saved.org });
  else el.loginName.focus();
  // initial view
  el.composerHostHome.appendChild(el.composer);
  el.composer.classList.remove('hidden');
})();
