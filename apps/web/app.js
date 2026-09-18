/* Plexus web client — talks to the hub over WebSocket; identical UI for browser and desktop shell. */
(function () {
  const $ = (s) => document.querySelector(s);
  const el = {
    login: $('#login'), loginForm: $('#login-form'), loginName: $('#login-name'), loginOrg: $('#login-org'), loginHub: $('#login-hub'),
    app: $('#app'), threadList: $('#thread-list'), threadSearch: $('#thread-search'), newThread: $('#btn-new-thread'), navFleet: $('#nav-fleet'),
    me: $('#me'), settingsBtn: $('#btn-settings'),
    topbarTitle: $('#topbar-title'), topbarBranch: $('#topbar-branch'), topbarWorktree: $('#topbar-worktree'), topbarRuntime: $('#topbar-runtime'),
    presence: $('#presence'), changesBtn: $('#btn-changes'), assignBtn: $('#btn-assign'), assignLabel: $('#assign-label'), auditBtn: $('#btn-audit'), catchupBtn: $('#btn-catchup'), catchupView: $('#catchup-view'),
    inboxBtn: $('#btn-inbox'), inboxView: $('#inbox-view'), inboxCount: $('#inbox-count'),
    recoveryBtn: $('#btn-recovery'), recoveryView: $('#recovery-view'),
    activityPanel: $('#activity-panel'),
    assignModal: $('#assign-modal'), closeAssign: $('#btn-close-assign'), assignUser: $('#assign-user'), assignNote: $('#assign-note'), doAssign: $('#btn-do-assign'), unassign: $('#btn-unassign'),
    fleetView: $('#fleet-view'), fleetRuntime: $('#fleet-runtime'), fleetProject: $('#fleet-project'), addProject: $('#btn-add-project'), fleetWorktree: $('#fleet-worktree'),
    composerHostHome: $('#composer-host-home'), runtimeCards: $('#runtime-cards'), attentionList: $('#attention-list'),
    threadView: $('#thread-view'), messages: $('#messages'), working: $('#working'), workingLabel: $('#working-label'), stop: $('#btn-stop'), composerHostThread: $('#composer-host-thread'),
    composer: $('#composer'), input: $('#input'), send: $('#btn-send'), providerSelect: $('#provider-select'), modelSelect: $('#model-select'), effortSelect: $('#effort-select'), presetSelect: $('#preset-select'),
    diffView: $('#diff-view'), diffSummary: $('#diff-summary'), diffFileList: $('#diff-file-list'), diffPane: $('#diff-pane'), commitMsg: $('#commit-msg'), commitBtn: $('#btn-commit'), copyPatchBtn: $('#btn-copy-patch'), closeDiff: $('#btn-close-diff'),
    teamGate: $('#team-gate'), teamGateWho: $('#team-gate-who'), teamGateAccountId: $('#team-gate-account-id'), copyGateAccountId: $('#btn-copy-gate-account-id'), teamName: $('#team-name'),
    createTeam: $('#btn-create-team'), joinCode: $('#join-code'), joinTeam: $('#btn-join-team'),
    gateError: $('#gate-error'), enrollment: $('#enrollment-badge'),
    inviteBtn: $('#btn-invite'), inviteeUserId: $('#invitee-user-id'), inviteRow: $('#invite-row'), inviteCode: $('#invite-code'), inviteExpiry: $('#invite-expiry'), teamAdminNotice: $('#team-admin-notice'), teamMembers: $('#team-members'),
    pairCode: $('#pair-code'), pairBtn: $('#btn-pair-host'),
    settingsModal: $('#settings-modal'), closeSettings: $('#btn-close-settings'), settingTheme: $('#setting-theme'), settingNotifications: $('#setting-notifications'), settingsAccountId: $('#settings-account-id'), copyAccountId: $('#btn-copy-account-id'), settingsConn: $('#settings-conn'), logout: $('#btn-logout'),
    toasts: $('#toasts')
  };

  const HUB_URL = window.harnessDesktop?.hubUrl ? window.harnessDesktop.hubUrl.replace(/^http/, 'ws') : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  // Every one of these is a distinct refusal from the hub; collapsing them into one
  // message would hide which boundary actually stopped you.
  const FRIENDLY = {
    unauthenticated: 'You are not signed in.',
    not_a_member: 'You are not a member of that team.',
    owner_role_required: 'Only the team owner can do that.',
    unknown_team: 'That team does not exist.',
    unknown_thread: 'That thread does not exist.',
    unknown_runtime: 'That execution host does not exist.',
    foreign_runtime: 'That execution host belongs to another team.',
    runtime_unpaired: 'That execution host is not paired with a team yet.',
    runtime_authentication_failed: 'That execution host could not prove its saved identity. Pair it again from the host.',
    foreign_thread: 'That thread belongs to a different team or execution host.',
    invitation_invalid: 'That invitation code is not valid.',
    invitation_expired: 'That invitation has expired. Ask for a new one.',
    invitation_already_accepted: 'That invitation has already been used.',
    invitation_revoked: 'That invitation was revoked.',
    invitation_recipient_mismatch: 'That invitation was addressed to a different account.',
    already_a_member: 'That account is already a member of this team.',
    unknown_user: 'No account has that ID. Ask your teammate to copy it from Settings.',
    pairing_code_invalid: 'That pairing code is not valid. Check the code shown on the machine.',
    pairing_code_expired: 'That pairing code expired. Restart the host to get a new one.',
    project_not_authorized: 'That folder has not been shared on this host.',
    project_add_is_host_local: 'A folder has to be shared on the machine itself, not from here.',
    provider_not_isolated: 'That provider cannot guarantee project-only execution on this host.',
    project_operation_unavailable: 'That project action is unavailable because the host cannot verify its project boundary.',
    policy_escalation_refused: 'That host does not allow this much access.',
    not_a_delegated_approver: 'You have not been delegated approval authority for this team.',
    command_already_in_progress: 'That action is already running.',
    command_id_conflict: 'That action ID was already used for a different command.',
    command_outcome_unknown: 'The host restarted after accepting that action, so its outcome is unknown.'
  };
  const state = {
    authMode: null, signingOut: false, ws: null, me: null, teams: [], teamId: null, membership: null, connected: false,
    threads: new Map(), runtimes: [],
    activeThreadId: null, activeThread: null, subscribedId: null,
    nodes: new Map(),     // itemId -> refs
    plans: new Map(),     // turnId -> plan card
    approvals: new Map(), // requestId -> card wrap
    approvers: new Set(), // user ids with delegated action-approval authority
    viewers: [],
    users: [],
    activity: { threads: [], overlaps: [] },
    pending: new Map(),   // command id -> {resolve,reject}
    diffOpen: false, diffFiles: [], diffSel: 0,
    encrypted: null,          // the endpoint this browser holds; null until it opens
    encryptedIdentity: null,  // its own keys, for somebody to compare out loud
    encryptedState: null,     // what the team's enrolment says about it
    encryptedTasks: [],       // tasks this account may fetch (not necessarily read)
    catchup: null, catchupSnapshot: null, catchupTaskId: null,
    catchupExplain: null, catchupHostPrompt: null, setupHostPrompt: null,
    inbox: [], inboxOpen: false,
    recoveryOpen: false, recoveryState: null, recoveryDrill: null,
    ownerRecoveryDrill: null, ownerRecoveryReceipt: null, ownerRecoveryPreview: null,
    // Set from the address bar before anything is connected, acted on once an endpoint exists.
    linkedTaskId: (/^\/t\/([A-Za-z0-9_-]{1,80})$/.exec(location.pathname) || [])[1] || null,
    localRuntimeId: null,
    encryptedTitles: new Map(), encryptedSnapshots: new Map(), encryptedReceipts: new Map(),
    encryptedTab: 'review', encryptedProjects: [], localEncryptedSetup: null, draftTarget: null, accessOpen: false, projectAccess: null,
    prefs: loadPrefs()
  };

  // Only opaque encrypted IDs are remembered. Names, prompts and local paths stay
  // in authenticated history, never in the plaintext navigation preference.
  function rememberWorkspace() {
    if (!state.me || !state.teamId) return;
    const runtime = selectedRuntime();
    if (runtime?.taskProtocol !== 'encrypted-v1') return;
    try { sessionStorage.setItem('plexus.workspace.' + state.me.id + '.' + state.teamId,
      JSON.stringify({ runtimeId: runtime.id, projectId: el.fleetProject.value, taskId: activeEncryptedTask()?.id || null })); } catch {}
  }
  function restoreWorkspace() {
    if (state.workspaceRestored === state.teamId || !state.encrypted || !state.runtimes.length) return;
    state.workspaceRestored = state.teamId;
    let held;
    try { held = JSON.parse(sessionStorage.getItem('plexus.workspace.' + state.me.id + '.' + state.teamId)); } catch {}
    if (!held || state.activeThreadId || state.linkedTaskId) return;
    const project = state.encryptedProjects.find(p => p.id === held.projectId && p.runtimeId === held.runtimeId);
    if (!project) return;
    el.fleetRuntime.value = project.runtimeId; renderProjects(); el.fleetProject.value = project.id;
    renderProviderPicker(); renderThreadList();
    if (state.encryptedTasks.some(t => t.id === held.taskId && t.projectId === project.id && t.runtimeId === project.runtimeId)) {
      selectEncryptedTask(held.taskId).catch(showEncryptedError);
    }
  }
  function workspaceProjects() {
    return state.runtimes.flatMap(runtime => (runtime.taskProtocol === 'encrypted-v1'
      ? state.encryptedProjects.filter(p => p.runtimeId === runtime.id) : runtime.projects || [])
      .map(project => ({ ...project, id: project.id || project.dir, runtimeId: runtime.id, runtime })));
  }
  function selectedProject() {
    return workspaceProjects().find(p => p.runtimeId === selectedRuntime()?.id && p.id === el.fleetProject.value);
  }
  function inSelectedProject(task) {
    const project = selectedProject();
    if (!project) return true;
    return task.runtimeId === project.runtimeId && (task.projectId === project.id || (!task.projectId && task.cwd === project.dir));
  }
  function taskState(task) {
    const snapshot = state.encryptedSnapshots.get(task.id);
    if (snapshot?.outcome) return snapshot.outcome;
    if (snapshot?.approvals?.some(a => isPendingApproval(snapshot, a))) return 'Awaiting approval';
    if (snapshot?.turn) return ({ completed: 'Ready for review', failed: 'Failed', running: 'Running', interrupted: 'Interrupted' })[snapshot.turn] || snapshot.turn;
    if (task.status?.activeFlags?.includes('waitingOnApproval')) return 'Awaiting approval';
    if (task.status) return ({ active: 'Running', idle: 'Ready for review' })[task.status.type] || task.status.type;
    return 'Open to read history';
  }
  function renderProjectWorkspace() {
    const rail = $('#project-list'), feed = $('#project-task-feed');
    if (!rail || !feed) return;
    const project = selectedProject(), runtime = selectedRuntime();
    const signature = JSON.stringify([workspaceProjects().map(p => [p.id, p.runtimeId, p.name, p.runtime.online]), project?.id, runtime?.id]);
    if (rail.dataset.signature !== signature) {
      rail.dataset.signature = signature; rail.replaceChildren();
      for (const p of workspaceProjects()) {
        const button = uiButton(p.name || 'Shared project', 'select-project', () => {
          el.fleetRuntime.value = p.runtimeId; renderProjects(); el.fleetProject.value = p.id;
          showFleet(); renderEncryptedSetup(); rememberWorkspace();
        });
        button.className = 'project-nav'; button.dataset.projectId = p.id; button.dataset.runtimeId = p.runtimeId;
        button.setAttribute('aria-current', p.id === project?.id && p.runtimeId === runtime?.id ? 'page' : 'false');
        button.append(uiNode('span', 'small', p.runtime.online ? p.runtime.name : p.runtime.name + ' · Offline'));
        rail.append(button);
      }
      if (!rail.children.length) rail.append(uiNode('p', 'small rail-empty', 'Share a folder on your execution host to begin.'));
    }
    if (!state.activeThreadId && !state.accessOpen && !state.inboxOpen && !state.recoveryOpen) el.topbarTitle.textContent = project?.name || 'Workspace';
    $('#workspace-title').textContent = project?.name || 'Make room for the next idea.';
    $('#workspace-eyebrow').textContent = project ? 'Project workspace' : 'Your shared workspace';
    $('#workspace-description').textContent = project
      ? 'Start something new, or pick up where your team left off.' : 'Connect your machine and choose the project you want to work on.';
    const tasks = [...state.encryptedTasks, ...state.threads.values()].filter(inSelectedProject);
    const feedSignature = JSON.stringify([project?.id, runtime?.id, state.connected, tasks.map(t => [t.id, state.encryptedTitles.get(t.id), t.name, taskState(t), state.encryptedSnapshots.get(t.id)?.responsible, t.assignee, t.creatorUserId, state.runtimes.find(r => r.id === t.runtimeId)?.online])]);
    if (feed.dataset.signature !== feedSignature) {
      feed.dataset.signature = feedSignature; feed.replaceChildren();
      feed.append(uiNode('h2', null, 'Shared work'));
      if (!tasks.length) feed.append(uiNode('p', 'workspace-empty', project
        ? 'No tasks here yet. Describe the first change below.' : 'Your tasks will appear here once a project is connected.'));
      for (const task of tasks) {
        const snapshot = state.encryptedSnapshots.get(task.id), host = state.runtimes.find(r => r.id === task.runtimeId);
        const row = uiButton(state.encryptedTitles.get(task.id) || task.name || 'Encrypted task', 'open-project-task', () => selectThread(task.id));
        row.className = 'project-task'; row.dataset.taskId = task.id;
        const responsible = snapshot?.responsible || task.assignee?.userId || task.creatorUserId || task.createdBy?.id;
        row.append(uiNode('span', 'project-task-status', (snapshot ? 'Last read · ' : '') + taskState(task)), uiNode('span', 'small',
          'Responsible: ' + (nameFor(responsible) || task.assignee?.name || task.createdBy?.name || 'Not recorded') +
          ' · Host: ' + (host?.name || 'Unavailable') + (host?.online && state.connected ? ' · Connected' : ' · Offline; execution may be unknown')));
        feed.append(row);
      }
    }
    renderSetupProgress();
  }
  function openWorkspaceSetup(target) {
    showFleet(); $('#workspace-setup').open = true;
    const node = (target && document.querySelector(target)) || $('#workspace-setup');
    node?.scrollIntoView({ block: 'center' });
    if (node?.matches('input,button,select')) node.focus();
  }
  function renderSetupProgress() {
    const root = $('#setup-progress'); if (!root) return;
    const runtime = selectedRuntime(), project = selectedProject(), desktop = window.harnessDesktop;
    const connected = !!(runtime?.online && state.connected);
    const verified = runtime?.taskProtocol !== 'encrypted-v1' || !!(state.encryptedState?.state === 'verified' && state.encrypted?.confirmedHost(runtime?.id));
    const codex = runtime?.providers?.find(p => p.id === 'codex-cli');
    const steps = [
      ['Team', !!state.teamId, 'Your private team is ready.', '#btn-access'],
      ['Execution host', connected && verified, !connected ? 'Connect the machine that will run your tasks.' : 'Verify this machine before sharing work.', !connected ? '#pair-code' : state.localEncryptedSetup && !state.localEncryptedSetup.authority ? '[data-action="authorize-encrypted-host"]' : '[data-action="show-host-fingerprint"]'],
      ['Project', !!project, 'Choose a folder on the execution machine.', '#btn-add-project'],
      ['Codex', !!codex?.configured, 'Connect the provider account on the execution machine.', '[data-action="configure-local-codex"]']
    ];
    const signature = JSON.stringify([steps, !!desktop, state.localCodexStatus, runtime?.id]);
    if (root.dataset.signature === signature) return;
    root.dataset.signature = signature; root.replaceChildren();
    const ready = steps.every(s => s[1]);
    root.append(uiNode('h2', null, ready ? 'Ready for your first task' : 'Set up your workspace'));
    const list = uiNode('ol', 'setup-steps');
    steps.forEach(([label, done, hint, target], index) => {
      const item = uiNode('li', done ? 'ready' : 'pending');
      item.append(uiNode('span', 'setup-step-number', done ? '✓' : String(index + 1)), uiNode('span', null, label), uiNode('span', 'small', done ? 'Ready' : 'Needs setup'));
      if (!done) item.append(uiButton('Set up ' + label.toLowerCase(), 'setup-step-' + index, () => openWorkspaceSetup(target)));
      item.title = done ? label + ' is ready' : hint; list.append(item);
    });
    root.append(list);
    if (!ready && !desktop?.configureCodex) root.append(uiNode('p', 'small', 'Using a browser? Ask the execution-host owner to connect their folder and Codex account in the desktop app. You can join shared tasks after your device is verified.'));
    if (!connected) root.append(uiNode('p', 'ew-error', 'Execution host unavailable. Open Plexus on that machine; reconnecting will not resend a task.'));
  }

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

  // ================= teams, invitations and host pairing =================
  function showTeamGate() {
    el.app.classList.add('hidden');
    el.teamGate.classList.remove('hidden');
    el.teamGateWho.textContent = state.me ? `Signed in as ${state.me.name}` : '';
    el.teamGateAccountId.value = state.me ? state.me.id : '';
  }

  async function copyAccountId(input, label = 'Account ID') {
    if (!input.value) return;
    try { await navigator.clipboard.writeText(input.value); toast(label + ' copied.'); }
    catch { input.select(); toast(label + ' selected. Copy it from the field.'); }
  }

  // On the desktop the host is this very machine, so offer its code rather than making
  // someone hunt for it. In a browser the field stays empty on purpose.
  async function offerLocalHost() {
    try {
      if (!window.harnessDesktop || !window.harnessDesktop.pairingCode) return;
      const [code, runtimeId] = await Promise.all([
        window.harnessDesktop.pairingCode(),
        window.harnessDesktop.runtimeId ? window.harnessDesktop.runtimeId() : null
      ]);
      state.localRuntimeId = runtimeId || null;
      if (code && !el.pairCode.value) {
        el.pairCode.value = code;
        el.pairCode.title = 'The code for this machine, shown by the desktop app.';
      }
      updateAddProjectAvailability();
    } catch {}
  }

  function enterTeam() {
    state.approvers = new Set();
    state.users = [];
    renderMembers();
    el.teamGate.classList.add('hidden');
    el.app.classList.remove('hidden');
    const team = state.teams.find((t) => t.id === state.teamId);
    state.membership = state.membership || (team && { role: team.role, enrollment: team.enrollment });
    el.me.innerHTML = '';
    el.me.append(avatar(state.me, 'sm'), document.createTextNode(state.me.name + ' · ' + (team ? team.name : 'team')));
    renderEnrollment();
    bootEncrypted();
    offerLocalHost();
    send({ type: 'team/approver/list', teamId: state.teamId });
    send({ type: 'threads.list' }); send({ type: 'runtimes.list' }); send({ type: 'users.list' }); send({ type: 'workspace.activity' });
    if (state.subscribedId) send({ type: 'thread.subscribe', threadId: state.subscribedId, afterSeq: state.lastSeq || 0 });
  }

  // Being in the team is not the same as being able to read task content, and the badge says
  // which of the two this browser has. The states are the enrolment's own, not a summary of
  // them: announced is not verified, and a device nobody has confirmed can read nothing.
  function renderEnrollment() {
    const enrolment = state.encryptedState;
    if (!enrolment) {
      el.enrollment.classList.remove('hidden');
      el.enrollment.textContent = 'Encryption starting';
      el.enrollment.title = 'This browser is opening its encrypted endpoint.';
      return;
    }
    const verified = enrolment.state === 'verified';
    el.enrollment.classList.toggle('hidden', verified);
    el.enrollment.textContent = ['announced', 'pending'].includes(enrolment.state) ? 'Awaiting confirmation'
      : enrolment.state === 'revoked' ? 'Endpoint revoked' : 'Encryption pending';
    el.enrollment.title = [
      'Device ' + enrolment.device + (enrolment.fingerprint ? ' · ' + enrolment.fingerprint : ''),
      verified ? 'Confirmed by ' + (enrolment.confirmedBy || 'a verified teammate') + '.'
        : 'A teammate whose endpoint is already verified has to confirm this fingerprint before it can read task content.',
      enrolment.durable ? '' : 'This browser has no persistent key store, so this identity ends with the tab.'
    ].filter(Boolean).join('\n');
  }

  // ---- the encrypted endpoint this browser holds ----
  //
  // It opens, publishes its keys and announces itself, and then waits. Nothing here decides
  // that it may read anything: that is a person confirming a fingerprint, which is #8's
  // ceremony and is deliberately not something a client can do for itself.
  async function bootEncrypted() {
    if (!window.PlexusEncrypted || !state.me || !state.teamId) return;
    if (state.encrypted) { await refreshEncrypted(); return; }
    try {
      const client = new window.PlexusEncrypted.EncryptedClient({
        token: state.me.token, userId: state.me.id, teamId: state.teamId
      });
      state.encryptedIdentity = await client.open();
      state.encrypted = client;
      await client.announce();
      await refreshEncrypted();
    } catch (error) {
      // A browser that cannot hold an endpoint still works for everything unencrypted, so
      // this reports rather than blocks - but it does report.
      state.encryptedState = { state: 'unavailable', device: null, durable: false };
      await pilot.poll(); pilot.failure('endpoint', error.code);
      renderEnrollment();
      toast('⚠ Encrypted endpoint unavailable: ' + esc(error.message || String(error)));
    }
  }

  async function refreshEncrypted() {
    if (!state.encrypted) return;
    try { const authority = await state.encrypted.answerChallenges?.(); state.authorityNeeded = authority?.pending === 'authority_confirmation_required'; }
    catch (error) { if (error.code !== 'membership_authority_required') throw error; state.authorityNeeded = true; }
    if (state.authorityNeeded) state.authorityEndpoints = await state.encrypted.authorityEndpoints();
    const enrolment = await state.encrypted.enrolmentState({ hosts: state.runtimes });
    state.encryptedState = { ...enrolment, fingerprint: state.encryptedIdentity && state.encryptedIdentity.fingerprint };
    pilot.clear('endpoint');
    for (const deletion of enrolment.deletions || []) {
      const ids = deletion.action === 'task.delete' ? [deletion.taskId] : deletion.tasks.map(task => task.id);
      for (const id of ids) {
        state.encryptedSnapshots.delete(id); state.encryptedTitles.delete(id);
        for (const [commandId, receipt] of state.encryptedReceipts) if (receipt.taskId === id) state.encryptedReceipts.delete(commandId);
        if (state.activeThreadId === id) { state.activeThreadId = null; state.catchup = null; state.catchupSnapshot = null; el.input.value = ''; state.draftTarget = null; showFleet(); }
      }
    }
    try { state.encryptedTasks = await state.encrypted.list(); } catch { state.encryptedTasks = []; }
    // A private link names a task and nothing else. Everything that decides whether its
    // holder may read it has already happened by the time this runs: they signed in, the
    // relay served this list only because they are on the team, and the catch-up screen
    // still refuses to decrypt anything until this device has been confirmed.
    if (state.linkedTaskId && !state.catchupOpen) {
      const wanted = state.encryptedTasks.find((task) => task.id === state.linkedTaskId);
      state.activeThreadId = state.linkedTaskId;
      state.linkedTaskId = null;
      if (wanted) await selectEncryptedTask(wanted.id);
      else {
        // Whether that id exists is not something this screen should answer either way.
        state.catchupExplain = 'This link points at a task this account cannot open. '
          + 'That is the same answer whether it does not exist, belongs to another team, or has not been shared with you.';
        openCatchup();
      }
    }
    renderEnrollment(); renderMembers();
    // The inbox is only meaningful once this device can read something, so it is refreshed
    // with the enrolment rather than on a timer that would spin while it can read nothing.
    if (enrolment.state === 'verified') {
      try { state.inbox = await state.encrypted.inbox(); } catch { state.inbox = []; }
    } else state.inbox = [];
    renderThreadList();
    await refreshEncryptedSetup();
    await pilot.poll();
    renderAccess();
    renderInbox();
    renderRecovery();
  }

  function showInvite(invitation) {
    pilot.invite(invitation.code).catch(() => {});
    const mins = Math.round((invitation.expiresAt - Date.now()) / 60000);
    const targetName = invitation.targetName || invitation.inviteeName || (invitation.invitee && invitation.invitee.name) || (invitation.target && invitation.target.name);
    el.inviteCode.value = invitation.code;
    el.inviteeUserId.value = '';
    el.inviteExpiry.textContent = (targetName ? `For ${targetName} · ` : '') + `expires in ${mins >= 60 ? Math.round(mins / 60) + ' h' : mins + ' min'}. One use.`;
    el.inviteRow.classList.remove('hidden');
  }

  function renderMembers() {
    el.teamMembers.innerHTML = '';
    const owner = state.membership && state.membership.role === 'owner';
    el.inviteeUserId.disabled = !owner;
    el.inviteBtn.disabled = !owner;
    el.pairCode.disabled = !owner;
    el.pairBtn.disabled = !owner;
    el.teamAdminNotice.classList.toggle('hidden', !!owner);
    for (const member of state.users) {
      const row = document.createElement('div');
      row.className = 'team-admin-row';
      row.dataset.memberId = member.userId;
      const name = document.createElement('span');
      name.textContent = member.name + (state.me && member.userId === state.me.id ? ' (you)' : '');
      const role = document.createElement('span');
      role.className = 'small';
      const verified = state.encryptedState?.endpoints?.filter(endpoint => endpoint.userId === member.userId && endpoint.state === 'verified').length;
      role.textContent = member.role + ' · ' + (verified ? verified + ' verified device' + (verified === 1 ? '' : 's') : 'device verification pending');
      row.append(avatar(member, 'sm'), name, role);
      if (owner && member.role !== 'owner') {
        const remove = document.createElement('button');
        remove.className = 'mini-btn danger';
        remove.dataset.action = 'remove-member';
        remove.dataset.userId = member.userId;
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', 'Remove ' + member.name + ' from the team');
        row.appendChild(remove);
      }
      el.teamMembers.appendChild(row);
    }
  }

  // ================= connection =================
  function connect({ name, token }) {
    const ws = new WebSocket(HUB_URL);
    state.ws = ws;
    // A token is an account; a name only ever mints a new one. Always prefer the token, or
    // every reload would create another stranger with the same display name.
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'client', name: token ? undefined : name, token })));
    ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); });
    ws.addEventListener('close', (event) => {
      if (state.signingOut) return;
      if (state.authMode === 'github' && event.code === 4001) { location.reload(); return; }
      state.connected = false;
      if (activeEncryptedTask()) renderEncryptedWorkspace();
      if (state.me) {
        toast('Disconnected from hub — reconnecting…');
        setTimeout(() => connect({ token: state.me.token }), 1500);
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
        state.me = m.user;
        if (state.authMode === 'github') {
          $('#gate-account-help').textContent = 'Ask your team owner to invite ' + m.user.verifiedEmail + ', then paste their invitation below.';
          el.teamGateAccountId.parentElement.classList.add('hidden');
        }
        state.teams = m.teams || []; state.teamId = m.teamId; state.connected = true;
        if (state.authMode === 'local') {
          try { localStorage.setItem('harness.session', JSON.stringify({ token: m.user.token, name: m.user.name })); } catch {}
        }
        el.login.classList.add('hidden');
        // An account with no team is the normal first-run state, not an error.
        if (!state.teamId) { showTeamGate(); break; }
        enterTeam();
        break;
      case 'team':
        state.teamId = m.team.id;
        state.membership = m.membership;
        state.approvers = new Set();
        if (!state.teams.some((t) => t.id === m.team.id)) state.teams.push({ ...m.team, role: m.membership.role });
        enterTeam();
        break;
      case 'teams': state.teams = m.teams; break;
      case 'invitation':
        showInvite(m.invitation);
        break;
      case 'runtime.paired':
        toast('Execution host paired with this team.');
        send({ type: 'runtimes.list' });
        break;
      case 'removed':
        toast('You were removed from this team.');
        state.teamId = null; state.membership = null; state.approvers = new Set(); state.users = []; state.threads = new Map(); renderMembers(); renderThreadList();
        showTeamGate();
        break;
      case 'threads':
        state.threads = new Map(m.threads.map((t) => [t.id, t]));
        renderThreadList(); renderAttention();
        break;
      case 'runtimes':
        state.runtimes = m.runtimes;
        renderRuntimes();
        refreshEncryptedSetup().catch(() => {});
        if (activeEncryptedTask()) renderEncryptedWorkspace();
        if (window.harnessDesktop && !state.localRuntimeId) offerLocalHost();
        break;
      case 'approvers':
        if (m.teamId !== state.teamId) break;
        state.approvers = new Set((m.approvers || []).map((a) => a.userId));
        renderAttention();
        refreshApprovalActions();
        break;
      case 'thread.updated': onThreadUpdated(m.thread); break;
      case 'users': state.users = m.users; renderMembers(); renderEncryptedWorkspace(); if (!el.assignModal.classList.contains('hidden')) fillAssignUsers(); break;
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
      case 'ok': break;
      case 'error': {
        const text = FRIENDLY[m.code] || m.message;
        const pending = m.ref && state.pending.get(m.ref);
        if (pending) {
          state.pending.delete(m.ref);
          pending.reject(new Error(text || m.code || 'command failed'));
          break;
        }
        if (!el.teamGate.classList.contains('hidden')) {
          el.gateError.textContent = text;
          el.gateError.classList.remove('hidden');
        } else toast('⚠ ' + esc(text));
        break;
      }
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

  function updateAddProjectAvailability() {
    const runtime = selectedRuntime();
    const desktop = !!window.harnessDesktop;
    const local = !!(desktop && state.localRuntimeId && runtime && runtime.online && runtime.id === state.localRuntimeId);
    el.addProject.classList.toggle('hidden', !(runtime && runtime.online));
    el.addProject.disabled = !local;
    if (local) el.addProject.title = 'Share a folder with this local execution host';
    else if (!desktop) el.addProject.title = 'Open Plexus on the desktop that owns this execution host to share a folder';
    else if (!state.localRuntimeId) el.addProject.title = 'The local execution host is still starting';
    else el.addProject.title = 'Select this desktop’s local execution host to share a folder';
  }

  function renderRuntimes() {
    const prev = el.fleetRuntime.value;
    el.fleetRuntime.innerHTML = '';
    for (const r of state.runtimes) {
      const o = document.createElement('option'); o.value = r.id; o.textContent = (r.online ? '● ' : '○ ') + r.name; o.disabled = !r.online;
      el.fleetRuntime.appendChild(o);
    }
    if (!state.runtimes.length) { const o = document.createElement('option'); o.textContent = 'No runtimes online'; el.fleetRuntime.appendChild(o); }
    // A restart must not retarget a draft to another machine that happens to be online.
    const selected = state.runtimes.find((r) => r.id === prev) || state.runtimes.find((r) => r.online);
    if (selected) el.fleetRuntime.value = selected.id;
    renderProjects(); renderProviderPicker();
    updateAddProjectAvailability();

    el.runtimeCards.innerHTML = '';
    if (!state.runtimes.length) { el.runtimeCards.innerHTML = '<div class="attention-empty">Open Plexus on the machine that will run your tasks, then pair its execution host with this team.</div>'; }
    for (const r of state.runtimes) {
      const c = document.createElement('div'); c.className = 'runtime-card';
      const head = document.createElement('div'); head.className = 'rc-head';
      head.innerHTML = '<span class="rc-dot ' + (r.online ? 'online' : '') + '"></span>' + esc(r.name) + (r.ownerName ? ' <span class="rc-sub">· ' + esc(r.ownerName) + '</span>' : '');
      const sub = document.createElement('div'); sub.className = 'rc-sub';
      const running = [...state.threads.values()].filter((t) => t.runtimeId === r.id && t.status && t.status.type === 'active').length;
      sub.textContent = r.taskProtocol === 'encrypted-v1' ? (r.encryptedProjects?.length || 0) + ' shared project(s)' : (r.projects || []).map((p) => p.name).join(', ') || 'no projects registered';
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
    const old = el.fleetProject.dataset.runtimeId === r?.id ? el.fleetProject.value : '';
    el.fleetProject.dataset.runtimeId = r?.id || '';
    el.fleetProject.innerHTML = '';
    for (const p of (r && r.taskProtocol === 'encrypted-v1' ? (state.encryptedProjects.filter(p => p.runtimeId === r.id)) : (r && r.projects) || [])) { const o = document.createElement('option'); o.value = p.id || p.dir; o.textContent = (p.name || 'Shared project ' + (p.id || '').slice(-6)) + (p.branch ? ' · ' + p.branch : ''); el.fleetProject.appendChild(o); }
    if (!el.fleetProject.options.length) { const o = document.createElement('option'); o.value = ''; o.textContent = 'No shared project'; el.fleetProject.appendChild(o); }
    if ([...el.fleetProject.options].some(o => o.value === old)) el.fleetProject.value = old;
    renderProjectWorkspace();
  }

  function renderProviderPicker(thread) {
    const r = thread ? state.runtimes.find((x) => x.id === thread.runtimeId) : selectedRuntime();
    if (!state.activeThreadId) el.send.disabled = !r?.online || !state.connected;
    el.fleetWorktree.closest('label').classList.toggle('hidden', r?.taskProtocol === 'encrypted-v1');
    const providers = r?.providers || [];
    const want = (thread && thread.settings && thread.settings.provider) || el.providerSelect.value || 'demo';
    el.providerSelect.innerHTML = '';
    for (const p of providers) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label + (p.configured ? '' : ' (no key)'); o.disabled = !p.configured; el.providerSelect.appendChild(o); }
    if (!providers.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'Connect an execution host'; el.providerSelect.appendChild(option); }
    el.providerSelect.disabled = !providers.some(p => p.configured);
    if (!state.activeThreadId && el.providerSelect.disabled) el.send.disabled = true;
    el.providerSelect.value = providers.some((p) => p.id === want && p.configured) ? want : (providers.find((p) => p.configured) || providers[0])?.id || '';
    renderModelPicker(providers, thread);
    renderPresetPicker(r, thread);
  }

  function renderPresetPicker(runtime, thread) {
    const labels = { 'read-only': 'Read Only', 'agent-untrusted': 'Agent (ask for everything)', agent: 'Agent', 'full-access': 'Workspace Auto' };
    const advertised = runtime && Array.isArray(runtime.presets) ? runtime.presets : [];
    const settingsPreset = thread && thread.settings && (thread.settings.preset || presetFor(thread.settings));
    const want = advertised.includes(settingsPreset)
      ? settingsPreset
      : advertised.includes(runtime && runtime.defaultPreset)
        ? runtime.defaultPreset
        : advertised[0];
    el.presetSelect.innerHTML = '';
    for (const preset of advertised) {
      const option = document.createElement('option');
      option.value = preset;
      option.textContent = labels[preset] || preset;
      el.presetSelect.appendChild(option);
    }
    if (!advertised.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No access preset available';
      el.presetSelect.appendChild(option);
    }
    el.presetSelect.disabled = !advertised.length;
    if (want) el.presetSelect.value = want;
  }

  function renderModelPicker(providers, thread) {
    const p = providers.find((x) => x.id === el.providerSelect.value) || providers[0];
    const want = (thread && thread.settings && thread.settings.model) || el.modelSelect.value;
    el.modelSelect.innerHTML = '';
    for (const m of (p && p.models) || []) { const o = document.createElement('option'); o.value = m; o.textContent = m; el.modelSelect.appendChild(o); }
    el.modelSelect.disabled = !p?.configured || !el.modelSelect.options.length;
    if (!el.modelSelect.options.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'No model available'; el.modelSelect.appendChild(option); }
    if (want && [...el.modelSelect.options].some((o) => o.value === want)) el.modelSelect.value = want;
  }

  function renderAttention() {
    const items = [...state.threads.values()].filter((t) => t.status && (t.status.activeFlags || []).includes('waitingOnApproval'));
    el.attentionList.innerHTML = '';
    if (!items.length) { el.attentionList.innerHTML = '<div class="attention-empty">Nothing waiting on a human right now.</div>'; return; }
    for (const t of items) {
      const supported = supportedApprovalDecisions(t.pendingApproval || {});
      const row = document.createElement('div'); row.className = 'attention-item';
      const main = document.createElement('div'); main.className = 'ai-main';
      main.innerHTML = '<div class="ai-title">' + esc(t.name) + '</div><div class="ai-cmd mono">' + esc((t.pendingApproval && (t.pendingApproval.command || (t.pendingApproval.changes || []).map((c) => c.path).join(', '))) || '') + '</div>';
      const open = document.createElement('button'); open.className = 'mini-btn'; open.textContent = 'Open';
      open.addEventListener('click', () => selectThread(t.id));
      row.appendChild(main);
      if (canApprove()) {
        if (supported.has('accept')) {
          const approve = document.createElement('button'); approve.className = 'mini-btn primary'; approve.textContent = 'Approve';
          approve.addEventListener('click', () => command(t.id, { method: 'approval/resolve', requestId: t.pendingApproval.requestId, decision: 'accept', turnId: t.pendingApproval.turnId, fingerprint: t.pendingApproval.fingerprint }).catch((e) => toast('⚠ ' + esc(e.message))));
          row.appendChild(approve);
        }
        if (supported.has('decline')) {
          const decline = document.createElement('button'); decline.className = 'mini-btn danger'; decline.textContent = 'Decline';
          decline.addEventListener('click', () => command(t.id, { method: 'approval/resolve', requestId: t.pendingApproval.requestId, decision: 'decline', turnId: t.pendingApproval.turnId, fingerprint: t.pendingApproval.fingerprint }).catch((e) => toast('⚠ ' + esc(e.message))));
          row.appendChild(decline);
        }
        if (!supported.has('accept') && !supported.has('decline')) {
          const unavailable = document.createElement('span'); unavailable.className = 'small'; unavailable.textContent = 'Open to review available decisions';
          row.appendChild(unavailable);
        }
      } else {
        const unavailable = document.createElement('span'); unavailable.className = 'small'; unavailable.textContent = 'Delegated approval required';
        row.appendChild(unavailable);
      }
      row.appendChild(open);
      el.attentionList.appendChild(row);
    }
  }

  function canApprove() { return !!(state.me && state.approvers.has(state.me.id)); }

  function supportedApprovalDecisions(request) {
    const offered = Array.isArray(request.availableDecisions) ? request.availableDecisions : [];
    return new Set(offered.filter((decision) => ['accept', 'decline', 'cancel'].includes(decision)));
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
    if (state.activeThreadId) { el.input.value = ''; state.newTaskDraft = null; }
    $('#encrypted-composer-error')?.remove();
    closeEncryptedSurfaces(); hideWorkViews(); document.body.classList.remove('navigation-open');
    if (state.subscribedId) send({ type: 'thread.unsubscribe', threadId: state.subscribedId });
    state.activeThreadId = null; state.activeThread = null; state.subscribedId = null; state.viewers = [];
    closeDiff();
    el.threadView.classList.add('hidden'); el.fleetView.classList.remove('hidden');
    el.composerHostHome.appendChild(el.composer); el.composer.classList.remove('hidden');
    el.send.disabled = false; el.input.placeholder = 'Describe a task for the agent…'; state.draftTarget = null;
    el.navFleet.classList.add('active');
    renderProviderPicker(); updateTopbar(); renderPresence(); renderThreadList(); rememberWorkspace();
    el.input.focus();
  }

  function selectThread(id) {
    if ((state.encryptedTasks || []).some(task => task.id === id)) return selectEncryptedTask(id);
    closeEncryptedSurfaces();
    if (state.subscribedId && state.subscribedId !== id) send({ type: 'thread.unsubscribe', threadId: state.subscribedId });
    state.activeThreadId = id; state.subscribedId = id; state.lastSeq = 0;
    state.activeThread = state.threads.get(id) || null;
    closeDiff();
    el.fleetView.classList.add('hidden'); el.threadView.classList.remove('hidden');
    el.composerHostThread.appendChild(el.composer); el.composer.classList.remove('hidden');
    el.send.disabled = false;
    el.navFleet.classList.remove('active');
    clearMessages();
    renderProviderPicker(state.activeThread);
    if (state.activeThread && state.activeThread.settings) {
      const s = state.activeThread.settings;
      if (s.effort) el.effortSelect.value = s.effort;
    }
    send({ type: 'thread.subscribe', threadId: id });
    updateTopbar(); renderThreadList();
    el.input.focus();
  }

  function presetFor(s) {
    if (s.approvalPolicy === 'never') return 'full-access';
    if (s.sandboxPolicy === 'read-only') return 'read-only';
    if (s.approvalPolicy === 'untrusted') return 'agent-untrusted';
    return 'agent';
  }

  function updateTopbar() {
    const t = state.activeThread;
    if (!t) {
      el.topbarTitle.textContent = selectedProject()?.name || 'Workspace'; el.topbarBranch.classList.add('hidden'); el.topbarWorktree.classList.add('hidden'); el.topbarRuntime.classList.add('hidden'); el.changesBtn.classList.add('hidden'); el.assignBtn.classList.add('hidden'); el.auditBtn.classList.add('hidden'); el.catchupBtn.classList.add('hidden'); closeCatchup();
      return;
    }
    el.assignBtn.classList.remove('hidden'); el.auditBtn.classList.remove('hidden'); el.catchupBtn.classList.remove('hidden');
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
    renderProjectWorkspace();
    const list = [...state.threads.values()].filter(inSelectedProject).filter((t) => !q || (t.name || '').toLowerCase().includes(q)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    el.threadList.innerHTML = '';
    for (const task of state.encryptedTasks.filter(inSelectedProject)) {
      const title = state.encryptedTitles.get(task.id) || 'Encrypted task · ' + task.id.slice(-6);
      if (q && !title.toLowerCase().includes(q)) continue;
      const row = document.createElement('button'); row.className = 'thread-item encrypted-task-row' + (task.id === state.activeThreadId ? ' active' : '');
      row.dataset.taskId = task.id; row.setAttribute('aria-current', task.id === state.activeThreadId ? 'page' : 'false');
      row.append(uiNode('span', 't-title', title), uiNode('span', 't-sub', taskState(task))); row.addEventListener('click', () => selectEncryptedTask(task.id)); el.threadList.appendChild(row);
    }
    if (!list.length && !el.threadList.children.length) { el.threadList.innerHTML = '<div class="thread-empty">' + (q ? 'No matching threads' : 'No threads in this team yet') + '</div>'; return; }
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
    const thread = state.activeThread || {};
    const requester = ev.by || thread.lastTurnBy || thread.createdBy;
    const requestedAt = ev.ts ? new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'time unavailable';
    const workspace = String(ev.cwd || thread.workDir || thread.cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'unknown workspace';
    const runtime = state.runtimes.find((candidate) => candidate.id === thread.runtimeId);
    const host = thread.runtimeName || (runtime && runtime.name) || 'unknown host';
    const provider = (thread.settings && thread.settings.provider) || 'unknown provider';
    card.innerHTML = '<div class="approval-title">' + (ev.collision ? 'Collision — another agent changed this file' : isFile ? 'Agent wants to write outside the workspace' : 'Agent wants to run a command') + '</div>' +
      '<div class="approval-reason approval-requester">Requested by ' + esc((requester && requester.name) || 'unknown requester') + ' at ' + esc(requestedAt) + '</div>' +
      (ev.reason ? '<div class="approval-reason">' + esc(ev.reason) + '</div>' : '');
    const scope = document.createElement('div');
    scope.className = 'approval-reason approval-scope';
    scope.textContent = 'Scope · workspace ' + workspace + ' · host ' + host + ' · provider ' + provider;
    card.appendChild(scope);
    if (ev.collision) { const c = document.createElement('div'); c.className = 'approval-collision'; c.append(avatar(ev.collision.by || { name: '?' }, 'sm'), document.createTextNode('Open “' + ev.collision.name + '” to coordinate, or approve to overwrite.')); card.appendChild(c); }
    const cmd = document.createElement('div'); cmd.className = 'approval-cmd mono';
    cmd.textContent = isFile ? (ev.changes || []).map((c) => c.kind + ' ' + c.path).join('\n') : '$ ' + ev.command;
    const evidence = document.createElement('details'); evidence.className = 'small approval-evidence';
    const evidenceSummary = document.createElement('summary'); evidenceSummary.textContent = 'Inspect request evidence';
    const evidenceBody = document.createElement('div'); evidenceBody.className = 'mono small';
    evidenceBody.textContent = ['request ' + ev.requestId, ev.turnId ? 'turn ' + ev.turnId : '', ev.itemId ? 'item ' + ev.itemId : ''].filter(Boolean).join(' · ');
    evidence.append(evidenceSummary, evidenceBody);
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    card.append(cmd, evidence, actions); wrap.appendChild(card);
    wrap._approvalEvent = ev;
    state.approvals.set(ev.requestId, wrap);
    fillApprovalActions(actions, ev);
  }

  function fillApprovalActions(actions, ev) {
    actions.innerHTML = '';
    if (!canApprove()) {
      const unavailable = document.createElement('span'); unavailable.className = 'small';
      unavailable.textContent = 'You can review this request, but a teammate with delegated approval authority must decide it.';
      actions.appendChild(unavailable);
      return;
    }
    const supported = supportedApprovalDecisions(ev);
    const mk = (label, decision, cls) => { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.dataset.decision = decision; b.addEventListener('click', () => command(state.activeThreadId, { method: 'approval/resolve', requestId: ev.requestId, decision, turnId: ev.turnId, fingerprint: ev.fingerprint }).catch((e) => toast('⚠ ' + esc(e.message)))); return b; };
    if (supported.has('accept')) actions.appendChild(mk('Approve', 'accept', 'approve'));
    if (supported.has('decline')) actions.appendChild(mk('Decline', 'decline', 'secondary'));
    if (supported.has('cancel')) actions.appendChild(mk('Cancel turn', 'cancel', 'secondary'));
    if (!actions.children.length) {
      const unavailable = document.createElement('span'); unavailable.className = 'small'; unavailable.textContent = 'This host did not offer a supported decision for this request.';
      actions.appendChild(unavailable);
    }
  }

  function refreshApprovalActions() {
    for (const wrap of state.approvals.values()) {
      const actions = wrap.querySelector('.approval-actions');
      if (actions && wrap._approvalEvent) fillApprovalActions(actions, wrap._approvalEvent);
    }
  }

  function resolveApprovalCard(ev) {
    const wrap = state.approvals.get(ev.requestId);
    state.approvals.delete(ev.requestId);
    const inner = document.createElement('span'); inner.className = 'resolved-chip' + (ev.decision === 'accept' || ev.decision === 'acceptForSession' ? '' : ' decline');
    const resolvedAt = ev.ts ? new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'time unavailable';
    inner.append(avatar(ev.by || { name: '?' }, 'sm'), document.createTextNode((ev.by ? ev.by.name : 'someone') + ' ' + ({ accept: 'approved', acceptForSession: 'approved for the session', decline: 'declined', cancel: 'cancelled the turn' }[ev.decision] || ev.decision) + ' · resolved at ' + resolvedAt));
    if (wrap) {
      const actions = wrap.querySelector('.approval-actions');
      if (actions) { actions.innerHTML = ''; actions.appendChild(inner); }
    } else {
      const chip = document.createElement('div'); chip.className = 'msg'; chip.appendChild(inner); el.messages.appendChild(chip);
    }
  }

  // ================= sending =================
  async function sendMessage() {
    const text = el.input.value.trim();
    if (!text) return;
    if (!state.activeThreadId && state.newTaskDraft &&
        (state.newTaskDraft.runtimeId !== selectedRuntime()?.id || state.newTaskDraft.projectId !== el.fleetProject.value)) {
      showEncryptedError(new Error('This draft was written for another project. Return to that project, or clear the draft before starting work here.'));
      return;
    }
    const settings = { provider: el.providerSelect.value, model: el.modelSelect.value, effort: el.effortSelect.value, preset: el.presetSelect.value };
    if (activeEncryptedTask() || (!state.activeThreadId && selectedRuntime()?.taskProtocol === 'encrypted-v1')) return sendEncryptedMessage(text, settings);
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
  // The catch-up screen renders a projection built on this endpoint - decrypted here, from
  // the encrypted log, never handed over by the relay. Until this browser can read a task it
  // renders the projection of an empty log, which is an honest screen saying nothing has
  // been recorded rather than a blank one implying there is nothing to know.
  function emptyProjection(explain) {
    return { version: 1, scope: { taskId: null, projectId: null, title: state.activeThread?.title || null, from: 0, through: 0, events: 0 },
      freshness: { state: 'unknown', through: 0, age: null, explain: explain || 'This task has no verified event log on this endpoint yet.' },
      responsible: { value: null, provenance: 'unavailable', reason: 'No responsible teammate is recorded for this task.' },
      host: { value: null, provenance: 'unavailable', reason: 'No execution host is recorded for this task.' },
      provider: { value: null, provenance: 'unavailable', reason: 'No provider is recorded for this task.' },
      hostConnected: null,
      objective: { value: null, provenance: 'unavailable', reason: 'This log has no creation event, so the objective is unknown.' },
      decisions: [], plan: { value: null, provenance: 'unavailable', reason: 'No plan has been recorded for this task.' },
      currentStep: { value: null, provenance: 'unavailable', reason: 'No plan has been recorded for this task.' },
      changes: { value: null, provenance: 'unavailable', reason: 'No file changes have been recorded for this task.' },
      links: [], activity: [], outcome: { value: 'open', provenance: 'derived', sources: [] },
      turn: { value: null, provenance: 'unavailable', reason: 'No turn has finished on this task yet.' },
      pending: { approvals: [],
        blocker: { value: null, provenance: 'unavailable', reason: 'Nothing in the log identifies a blocker.' } } };
  }

  // Which encrypted task this screen is about. The thread id is used when it names one,
  // because that is the only mapping that exists; a single readable task is used when it is
  // the only candidate. Anything else is ambiguous and is left alone rather than guessed.
  function catchupTask() {
    const tasks = state.encryptedTasks || [];
    return tasks.find((t) => t.id === state.activeThreadId) || (tasks.length === 1 ? tasks[0] : null);
  }

  function openCatchup() {
    state.catchupOpen = true;
    el.threadView.classList.add('hidden'); el.diffView.classList.add('hidden');
    el.catchupView.classList.remove('hidden'); el.catchupBtn.classList.add('active');
    renderCatchupView();
    loadCatchup().catch((error) => toast('⚠ ' + esc(error.message || String(error))));
  }

  function renderCatchupView() {
    window.PlexusCatchup.renderCatchup(state.catchup || emptyProjection(state.catchupExplain), el.catchupView, {
      onOpenTranscript: closeCatchup,
      // A source link that does nothing is worse than no link: it says the claim is backed
      // when nothing has been checked. Resolving against the snapshot this endpoint accepted
      // means an absent record shows as absent.
      onOpenSource: (source) => {
        const opened = window.PlexusCatchup.resolveSource(state.catchupSnapshot, source);
        const pane = document.createElement('aside');
        pane.className = 'cu-source-pane';
        pane.setAttribute('aria-label', 'Source record');
        window.PlexusCatchup.renderSource(opened, pane);
        const held = el.catchupView.querySelector('.cu-source-pane');
        if (held) held.remove();
        el.catchupView.appendChild(pane);
        pane.scrollIntoView({ block: 'nearest' });
      }
    });
    if (state.catchupHostPrompt) el.catchupView.appendChild(hostConfirmation(state.catchupHostPrompt));
  }

  // The one thing this screen asks a person to do: compare a host's fingerprint with what
  // that host prints, and say whether they match. Nothing is read from that host until they
  // do, and the button does not decide - it records what the person decided.
  function hostConfirmation({ runtimeId, endpoints }) {
    const panel = document.createElement('aside');
    panel.className = 'cu-source-pane';
    panel.setAttribute('aria-label', 'Confirm the execution host');
    const title = document.createElement('h4');
    title.textContent = 'Confirm this execution host';
    const why = document.createElement('p');
    why.className = 'cu-explain';
    why.textContent = 'This task was written by ' + runtimeId + '. Compare the key below with the one the host itself prints. '
      + 'Nothing from this task is shown until they match, because a relay listing a key is not the same as a person recognising one.';
    panel.append(title, why);
    if (!endpoints.length) {
      const none = document.createElement('p');
      none.className = 'cu-missing';
      none.textContent = 'That host has published no endpoint, so there is nothing to confirm yet.';
      panel.appendChild(none);
      return panel;
    }
    for (const endpoint of endpoints) {
      const row = document.createElement('div');
      row.className = 'cu-card';
      const key = document.createElement('p');
      key.className = 'cu-card-text mono';
      key.textContent = endpoint.device + ' · ' + endpoint.fingerprint;
      const confirm = document.createElement('button');
      confirm.className = 'mini-btn';
      confirm.type = 'button';
      confirm.dataset.action = 'confirm-host';
      confirm.textContent = 'These match';
      confirm.addEventListener('click', async () => {
        confirm.disabled = true;
        try {
          await state.encrypted.confirmHost(runtimeId, endpoint);
          state.catchupHostPrompt = null;
          if (state.setupHostPrompt?.runtimeId === runtimeId) state.setupHostPrompt = null;
          if (activeEncryptedTask()) await updateEncryptedTask(); else if (state.catchupOpen) await loadCatchup(); else state.catchupExplain = null;
          renderEncryptedSetup();
        } catch (error) {
          confirm.disabled = false;
          toast('⚠ ' + esc(error.message || String(error)));
        }
      });
      row.append(key, confirm);
      panel.appendChild(row);
    }
    return panel;
  }

  // Replay the task on this endpoint and hand the screen what came back. Every way this can
  // fail is a state worth showing, so none of them are swallowed into a blank screen.
  async function loadCatchup() {
    state.catchupHostPrompt = null;
    if (!state.encrypted) { state.catchupExplain = 'This browser has no encrypted endpoint, so no task log can be read here.'; return renderIfOpen(); }

    const task = catchupTask();
    if (!task) { state.catchupExplain = 'No encrypted task on this team matches this view.'; return renderIfOpen(); }
    const runtime = state.runtimes.find((r) => r.id === task.runtimeId);
    const out = await state.encrypted.catchUp(task, {
      responsible: (state.users.find((u) => u.userId === task.creatorUserId) || {}).name || null,
      host: task.runtimeId,
      // The host records which provider it ran, and that wins. This is only the fallback for
      // a log written before hosts asserted one, and it is marked as context so nobody reads
      // the screen's own guess as something somebody wrote down.
      provider: (state.activeThread && state.activeThread.settings && state.activeThread.settings.provider) || null,
      hostConnected: runtime ? !!runtime.online : null
    });
    if (out.error === 'host_unconfirmed') {
      state.catchup = null; state.catchupSnapshot = null;
      state.catchupExplain = 'The host that wrote this task has not been confirmed on this device.';
      state.catchupHostPrompt = { runtimeId: task.runtimeId, endpoints: await state.encrypted.hostEndpoints(task.runtimeId) };
      return renderIfOpen();
    }
    if (out.error) {
      state.catchup = null; state.catchupSnapshot = null;
      // A log that does not verify is a finding, not a loading failure.
      state.catchupExplain = 'This task log did not verify on this endpoint (' + out.error + '), so nothing from it is shown.';
      return renderIfOpen();
    }
    state.catchup = out.projection;
    pilot.catchup(task).catch(() => {});
    state.catchupSnapshot = out.snapshot;
    state.catchupTaskId = task.id;
    state.encryptedSnapshots.set(task.id, out.snapshot);
    state.encryptedTitles.set(task.id, out.snapshot.title || task.id);
    state.catchupExplain = null;
    renderIfOpen();
  }

  function renderIfOpen() { if (state.catchupOpen) renderCatchupView(); }

  // ---- the inbox ----
  //
  // Questions a teammate addressed to this account, across every task this endpoint can
  // read. It renders the same records the task view renders, from the same projections, so
  // the two cannot disagree about whether something is still open.
  function renderInbox() {
    const open = state.inbox || [];
    el.inboxBtn.classList.toggle('hidden', !state.encrypted);
    el.inboxCount.textContent = String(open.length);
    el.inboxCount.classList.toggle('zero', open.length === 0);
    if (!state.inboxOpen) return;
    el.inboxView.innerHTML = '';
    const head = document.createElement('h3');
    head.textContent = open.length ? 'Questions for you' : 'Nothing is waiting on you';
    el.inboxView.appendChild(head);
    if (!open.length) {
      const empty = document.createElement('p');
      empty.className = 'inbox-empty';
      empty.textContent = 'A teammate can ask you about a task they have shared with you. '
        + 'Questions appear here, and stay here until you resolve them or the asker withdraws them.';
      el.inboxView.appendChild(empty);
      return;
    }
    const list = document.createElement('ul');
    list.className = 'cu-cards';
    for (const entry of open) {
      const card = document.createElement('li');
      card.className = 'cu-card cu-help';
      card.dataset.request = entry.request.id;
      const question = document.createElement('p');
      question.className = 'cu-help-question';
      question.textContent = entry.request.question;
      const who = document.createElement('p');
      who.className = 'cu-help-who';
      who.textContent = (nameFor(entry.request.from) || entry.request.from) + ' asked you';
      const where = document.createElement('p');
      where.className = 'inbox-task';
      // Freshness travels with the entry, so "act later" does not quietly mean "act on
      // something that stopped being true a while ago".
      where.textContent = (entry.title || entry.taskId) + ' · ' + entry.freshness;
      const actions = document.createElement('div');
      actions.className = 'cu-actions';
      const open_ = document.createElement('button');
      open_.className = 'mini-btn';
      open_.type = 'button';
      open_.textContent = 'Open the task';
      open_.addEventListener('click', () => {
        closeInbox();
        selectEncryptedTask(entry.taskId).catch(showEncryptedError);
      });
      const done = document.createElement('button');
      done.className = 'mini-btn';
      done.type = 'button';
      done.dataset.action = 'resolve-help';
      done.textContent = 'Mark resolved';
      done.addEventListener('click', async () => {
        done.disabled = true;
        try {
          await state.encrypted.settleHelp(entry.task, entry.request.id, 'resolved');
          // The host records it, and this endpoint learns it did by reading the log again -
          // not by assuming the send succeeded and crossing it off locally.
          toast('Sent. It clears once the host records it.');
          await refreshEncrypted();
        } catch (error) {
          done.disabled = false;
          toast('⚠ ' + esc(error.message || String(error)));
        }
      });
      actions.append(open_, done);
      card.append(question, who, where, actions);
      list.appendChild(card);
    }
    el.inboxView.appendChild(list);
  }

  function nameFor(userId) {
    const member = (state.users || []).find((u) => u.userId === userId);
    return member ? member.name : null;
  }

  // ---- recovery ----
  //
  // Three things this screen has to do without softening any of them: hand over a key exactly
  // once, refuse to call it done until somebody proves they wrote it down, and say plainly
  // what happens if it and every device are lost. The last one is not a warning banner; it is
  // the honest answer to the question everybody asks second.
  function renderRecovery() {
    el.recoveryBtn.classList.toggle('hidden', !state.encrypted);
    if (!state.recoveryOpen) return;
    const view = el.recoveryView;
    if (state.ownerRecoveryTeam !== state.teamId) {
      state.ownerRecoveryTeam = state.teamId; state.ownerRecoveryDrill = null;
      state.ownerRecoveryReceipt = null; state.ownerRecoveryPreview = null; state.ownerRestoreDraft = null; state.ownerKitCiphertext = null;
    }
    if (state.ownerRecoveryDrill && view._ownerDrillGeneration === state.ownerRecoveryDrill.generation) return;
    if (state.recoveryDrill && view._recoveryDrillKey === state.recoveryDrill.recoveryKey) return;
    const restoreKey = view.querySelector('[name="restore-recovery-key"]');
    if (restoreKey) state.recoveryRestoreDraft = { key: restoreKey.value, scope: view.querySelector('[name="restore-backup"]')?.value };
    const ownerKey = view.querySelector('[name="owner-recovery-key"]');
    if (ownerKey) state.ownerRestoreDraft = { key: ownerKey.value, scope: view.querySelector('[name="owner-kit-scope"]')?.value };
    view._recoveryDrillKey = state.recoveryDrill?.recoveryKey || '';
    view._ownerDrillGeneration = state.ownerRecoveryDrill?.generation || '';
    const signature = JSON.stringify([state.recoveryState, state.recoveryDrill, !!state.ownerRecoveryDrill,
      state.ownerRecoveryReceipt?.state, state.ownerRecoveryPreview, state.localEncryptedSetup, state.encryptedState?.durable, !!state.ownerKitCiphertext]);
    if (view.dataset.signature === signature) return;
    view.dataset.signature = signature; view.innerHTML = '';
    const head = document.createElement('h3');
    head.textContent = 'Recovery';
    view.appendChild(head);
    if (!state.recoveryDrill) renderOwnerRecovery(view);
    if (state.ownerRecoveryDrill) return;

    const backups = (state.recoveryState && state.recoveryState.backups) || [];
    const limits = (state.recoveryState && state.recoveryState.limits) || {};

    if (state.recoveryDrill) {
      // The one moment the key exists anywhere outside this person's own notes.
      const explain = document.createElement('p');
      explain.className = 'rec-limit';
      explain.textContent = 'Write this down somewhere outside this machine. It is shown once, '
        + 'it is never sent anywhere, and nobody else has a copy - including us.';
      const key = document.createElement('div');
      key.className = 'rec-key';
      key.textContent = state.recoveryDrill.recoveryKey;
      const ask = document.createElement('p');
      ask.className = 'rec-limit';
      ask.textContent = 'Now type it back. Nothing is backed up until you do, because a key you '
        + 'did not actually store is not recovery.';
      const input = document.createElement('input');
      input.className = 'rec-input';
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = 'Paste or type the key';
      const confirm = document.createElement('button');
      confirm.className = 'mini-btn';
      confirm.type = 'button';
      confirm.dataset.action = 'confirm-recovery';
      confirm.textContent = 'I have stored it';
      confirm.addEventListener('click', async () => {
        confirm.disabled = true;
        try {
          const scope = 'account:' + state.me.id;
          const taskIds = (state.encryptedTasks || []).map((task) => task.id);
          if (!taskIds.length) throw Object.assign(new Error('nothing_to_back_up'), { code: 'nothing_to_back_up' });
          await state.encrypted.completeRecoverySetup(state.recoveryDrill.recoveryKey, input.value, { scope, taskIds });
          state.recoveryDrill = null;
          toast('Recovery is set up.');
          await refreshRecovery();
        } catch (error) {
          confirm.disabled = false;
          toast('⚠ ' + esc(error.code || error.message || String(error)));
        }
      });
      view.append(explain, key, ask, input, confirm);
      return;
    }

    view.append(uiNode('h3', null, 'History-only backup'));
    const status = document.createElement('p');
    status.className = 'rec-limit';
    if (backups.length) {
      const when = new Date(backups[0].updatedAt);
      status.textContent = 'Backed up ' + when.toLocaleString() + ' · ' + backups[0].bytes + ' bytes of ciphertext. '
        + limits.operatorView;
    } else {
      status.textContent = 'No separate history-only backup. Owner kits contain only the history selected when they were prepared.';
    }
    view.appendChild(status);
    appendRecoveryRestore(view, backups);

    const start = document.createElement('button');
    start.className = 'mini-btn';
    start.type = 'button';
    start.dataset.action = backups.length ? 'replace-recovery' : 'start-recovery';
    start.textContent = backups.length ? 'Replace the key' : 'Set up recovery';
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        if (backups.length) {
          const scope = 'account:' + state.me.id;
          const taskIds = (state.encryptedTasks || []).map((task) => task.id);
          const rotated = await state.encrypted.beginRecoverySetup();
          state.recoveryDrill = { recoveryKey: rotated.recoveryKey, rotated: true };
          toast('The existing backup remains usable until you confirm the replacement key.');
        } else {
          state.recoveryDrill = await state.encrypted.beginRecoverySetup();
        }
        renderRecovery();
      } catch (error) {
        start.disabled = false;
        toast('⚠ ' + esc(error.code || error.message || String(error)));
      }
    });
    view.appendChild(start);

    const limitsHead = document.createElement('h4');
    limitsHead.textContent = 'History-only recovery limits';
    view.appendChild(limitsHead);
    for (const key of ['everythingLost', 'siteDataCleared', 'storageLocked']) {
      if (!limits[key]) continue;
      const line = document.createElement('p');
      line.className = 'rec-limit' + (key === 'everythingLost' ? ' rec-warn' : '');
      line.textContent = limits[key];
      view.appendChild(line);
    }
    if (state.encryptedState && state.encryptedState.durable === false) {
      const fragile = document.createElement('p');
      fragile.className = 'rec-limit rec-warn';
      fragile.textContent = 'This browser has no persistent key store, so this device\'s identity ends with the tab. '
        + 'Set up recovery before that happens.';
      view.appendChild(fragile);
    }
  }

  async function refreshRecovery() {
    if (!state.encrypted) return;
    const client = state.encrypted, result = await client.recoveryState();
    if (client !== state.encrypted) return;
    state.recoveryState = result;
    renderRecovery();
  }

  function downloadOwnerKit(ciphertext) {
    const url = URL.createObjectURL(new Blob([ciphertext], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'plexus-owner-recovery-kit.json'; link.click();
    URL.revokeObjectURL(url);
  }
  function renderOwnerRecovery(view) {
    const information = state.recoveryState?.ownerRecovery || {}, kits = state.recoveryState?.ownerKits || [];
    const section = uiSection('Owner authority recovery kit',
      'A separately prepared kit can restore the original owner account on a new device when every trusted device is lost. It contains account-level cross-signing capability and selected authenticated task history. Keep its key outside this machine.');
    section.id = 'owner-authority-recovery'; section.dataset.state = state.ownerRecoveryDrill ? 'drill' : information.stage ? 'staged' : information.epoch ? 'membership-recovered' : information.descriptor ? 'saved' : 'not-configured';
    section.append(uiNode('p', 'small', 'The original team fingerprint stays unchanged. Recovery resets device confirmations and project grants. It does not restore provider credentials, pending actions or delegated approvals. Every execution host needs a separate local confirmation.'));
    if (state.ownerRecoveryDrill) {
      const draft = state.ownerRecoveryDrill;
      section.append(uiNode('p', 'ew-explain', 'Store this new key now. Then enter your stored copy so a clean, inactive SDK endpoint can perform a real recovery drill before this kit becomes active.'));
      section.append(uiNode('pre', 'rec-key', draft.recoveryKey));
      const typed = uiField('Stored owner recovery key', 'owner-recovery-drill', { type: 'password' });
      section.append(typed.wrap, uiButton('Test stored key and save kit', 'complete-owner-recovery-kit', async () => {
        const client = state.encrypted;
        const receipt = await client.completeOwnerRecoverySetup(typed.input.value);
        if (client !== state.encrypted) return;
        typed.input.value = ''; state.ownerRecoveryDrill = null; state.ownerRecoveryReceipt = receipt;
        await refreshEncrypted(); await refreshRecovery();
        toast('Owner recovery kit saved after a clean endpoint drill. Download its encrypted file and keep the key separately.');
      }, true));
      section.append(uiButton('Cancel this kit setup', 'cancel-owner-recovery-kit', () => {
        state.encrypted.cancelOwnerRecoverySetup(); state.ownerRecoveryDrill = null; renderRecovery();
      }));
      view.append(section); return;
    }
    if (information.descriptor) section.append(uiNode('p', 'small', 'Configured authority generation ' + information.descriptor.generation + '. The encrypted kit and its separate customer-held key are both needed.'));
    else section.append(uiNode('p', 'cu-missing', 'Owner authority recovery is not configured. Existing history-only backups cannot restore owner membership.'));
    if (state.ownerRecoveryReceipt?.ciphertext) section.append(uiButton('Download encrypted owner kit', 'download-owner-recovery-kit', () => downloadOwnerKit(state.ownerRecoveryReceipt.ciphertext)));
    if (information.eligible) {
      section.append(uiButton(information.descriptor ? 'Replace owner recovery kit' : 'Set up owner recovery kit', 'start-owner-recovery-kit', async () => {
        const replaceAuthority = !!information.generation;
        if (replaceAuthority && !confirm('Replace the account recovery signing root? Prior kits stop authorizing recovery only after the newer signed descriptor is applied. Previously downloaded history remains readable. Other hosts must apply the change separately.')) return;
        const client = state.encrypted;
        const draft = await client.beginOwnerRecoverySetup({ taskIds: state.encryptedTasks.map(task => task.id), replaceAuthority });
        if (client !== state.encrypted) return;
        state.ownerRecoveryDrill = draft; renderRecovery();
      }));
      if (information.descriptor) section.append(uiButton('Disable owner authority recovery', 'disable-owner-recovery-kit', async () => {
        if (!confirm('Disable customer-kit owner recovery? Hosts must apply the signed change separately. Keep a verified device or another recovery method; downloaded history cannot be erased.')) return;
        await state.encrypted.disableOwnerRecovery(); await refreshRecovery();
      }));
    } else section.append(uiNode('p', 'small', 'Only a currently verified device of the original owner can provision or replace this authority kit.'));

    const restore = uiSection('Restore an owner kit on a new device',
      'Your current device stays unchanged while a separate inactive endpoint verifies the kit. No membership or host authority changes during this step.');
    const key = uiField('Owner recovery key', 'owner-recovery-key', { type: 'password', value: state.ownerRestoreDraft?.key || '' });
    restore.append(key.wrap);
    const choose = kits.length ? uiField('Encrypted owner kit', 'owner-kit-scope', { value: state.ownerRestoreDraft?.scope,
      options: kits.map(kit => ({ id: kit.scope, name: kit.scope + ' · ' + new Date(kit.updatedAt).toLocaleString() })) }) : null;
    if (choose) restore.append(choose.wrap);
    const file = uiField('Customer-held encrypted kit file (optional)', 'owner-kit-file', { type: 'file' });
    file.input.accept = '.json,application/json';
    restore.append(file.wrap);
    if (state.ownerKitCiphertext) restore.append(uiNode('p', 'small', 'Customer-held kit loaded for verification.'));
    const stage = uiButton(information.resumeRequired ? 'Resume inactive recovery' : 'Verify kit in an inactive endpoint', 'stage-owner-recovery', async () => {
      const client = state.encrypted;
      const status = await client.stageOwnerRecovery({ scope: choose?.input.value, ciphertext: state.ownerKitCiphertext, recoveryKey: key.input.value });
      if (client !== state.encrypted) return;
      key.input.value = ''; state.ownerRestoreDraft = null; state.ownerKitCiphertext = null; state.ownerRecoveryPreview = null;
      state.ownerRecoveryReceipt = { state: 'staged', identity: status.identity };
      await refreshRecovery();
    });
    stage.disabled = !choose && !state.ownerKitCiphertext && !information.resumeRequired;
    file.input.addEventListener('change', async () => {
      stage.disabled = true;
      state.ownerKitCiphertext = file.input.files[0] ? await file.input.files[0].text() : null;
      stage.disabled = !choose && !state.ownerKitCiphertext && !information.resumeRequired;
      renderRecovery();
    });
    restore.append(stage); section.append(restore);
    if (information.stage) {
      const staged = information.stage;
      const confirmation = uiSection('History restored; membership recovery not yet applied',
        'This is a new endpoint. Publishing recovery resets earlier device confirmations and project grants. Every execution host remains paused until its own local confirmation, and approval authority stays separate.');
      confirmation.dataset.state = information.resumeRequired ? 'resume-required' : 'history-restored';
      confirmation.append(uiNode('p', 'ew-fingerprint mono', window.PlexusEncrypted.fingerprint(staged.identity)));
      for (const taskId of staged.taskIds || []) {
        const inspect = uiButton('Inspect restored task ' + taskId.slice(-6), 'inspect-owner-recovery-history', async () => {
          state.ownerRecoveryPreview = await state.encrypted.previewOwnerRecoveryHistory(taskId); renderRecovery();
        });
        inspect.disabled = !!information.resumeRequired; confirmation.append(inspect);
      }
      if (state.ownerRecoveryPreview) {
        const preview = state.ownerRecoveryPreview, evidence = uiSection(preview.snapshot.title || preview.taskId,
          'Verified restored task history through encrypted event ' + preview.snapshot.seq + '. Reading this evidence does not publish membership recovery.');
        evidence.dataset.taskId = preview.taskId; evidence.append(uiNode('p', null, preview.snapshot.objective));
        for (const diff of preview.snapshot.diffs || []) evidence.append(uiNode('pre', 'mono ew-code-scroll', diff.patch || JSON.stringify(diff)));
        confirmation.append(evidence);
      }
      const publish = uiButton('Recover owner membership and reset access', 'recover-owner-membership', async () => {
        if (!confirm('Recover this owner account on the new device and reset prior device confirmations and project grants? Pending actions and delegated approvals will not return. Every execution host remains paused until separately confirmed on that machine.')) return;
        const client = state.encrypted, receipt = await client.recoverOwnerMembership();
        if (client !== state.encrypted) return;
        state.encryptedIdentity = receipt.identity; state.encryptedReceipts.clear(); state.ownerRecoveryReceipt = receipt;
        state.ownerRecoveryPreview = null; await refreshEncrypted(); await refreshRecovery();
      }, true);
      publish.disabled = !!information.resumeRequired; confirmation.append(publish); section.append(confirmation);
    }
    if (information.epoch) {
      const local = state.localEncryptedSetup, selected = selectedRuntime();
      const localHost = local?.runtimeId === selected?.id && local.teamId === state.teamId;
      const confirmationSaved = localHost && local.freshnessAuthority?.recoveryEpoch === information.epoch &&
        ['user', 'device', 'curve25519', 'ed25519'].every(key => local.freshnessAuthority.signer?.[key] === state.encryptedIdentity?.[key]) &&
        local.freshnessAuthority.state === 'active';
      const active = localHost && local?.freshnessAuthority?.recoveryEpoch === information.epoch &&
        local.freshnessAuthority.state === 'active' && local.state === 'ready';
      const status = uiSection(active ? 'Recovery active on this execution host' : confirmationSaved ? 'Local recovery confirmation saved' : 'Owner membership recovered; hosts need local confirmation',
        active ? 'Grant this account explicit project access before creating new work. Configure action approval separately. Other hosts need their own local confirmation.'
          : confirmationSaved ? 'Waiting for membership verification and task key rotation on this host. Reconciliation retries automatically; controls remain unavailable until it finishes. Other hosts still need their own local confirmation.'
          : 'A membership recovery record alone cannot restart an execution host. Open the installed app on each reachable machine and confirm its new membership signer. Offline hosts remain pending.');
      status.dataset.state = active ? 'active' : confirmationSaved ? 'rotation-pending' : 'pending-host';
      for (const runtime of state.runtimes) {
        const appliedHere = active && runtime.id === local?.runtimeId;
        const row = uiNode('p', appliedHere ? 'small' : 'cu-missing', (runtime.name || runtime.id) + ': ' +
          (appliedHere ? 'this host has locally applied this recovery epoch.'
            : runtime.online ? 'local recovery confirmation is pending or cannot be verified from this client.'
              : 'offline; local recovery confirmation remains pending.'));
        row.dataset.recoveryRuntime = runtime.id; row.dataset.recoveryState = appliedHere ? 'active' : 'pending'; status.append(row);
      }
      if (!active && !confirmationSaved && window.harnessDesktop?.confirmFreshnessAuthority) {
        const activate = uiButton('Confirm recovery on this host', 'activate-owner-recovery-host', async () => {
          await activateMembershipRecovery(selectedRuntime()); await refreshRecovery();
        });
        activate.disabled = !localHost || !selected?.online;
        status.append(activate);
        if (activate.disabled) status.append(uiNode('p', 'cu-missing', 'Select this machine’s online execution host before confirming recovery locally.'));
      }
      section.append(status);
    }
    section.append(uiNode('p', 'rec-limit rec-warn', 'If every trusted device and every usable customer recovery key or encrypted kit is lost, the operator cannot recover your history or owner authority. Rewrapping a key does not erase old downloaded history or revoke a copied signing secret.'));
    view.append(section);
  }

  function openRecovery() {
    closeEncryptedSurfaces(); document.body.classList.remove('navigation-open');
    state.recoveryOpen = true;
    el.threadView.classList.add('hidden'); el.diffView.classList.add('hidden');
    el.catchupView.classList.add('hidden'); el.inboxView.classList.add('hidden'); el.fleetView.classList.add('hidden');
    el.recoveryView.classList.remove('hidden'); el.recoveryBtn.classList.add('active');
    renderRecovery();
    refreshRecovery().catch(() => {});
  }

  function closeRecovery() {
    if (!state.recoveryOpen) return;
    state.recoveryOpen = false;
    el.recoveryView.classList.add('hidden'); el.recoveryBtn.classList.remove('active');
    if (state.activeThreadId) el.threadView.classList.remove('hidden'); else el.fleetView.classList.remove('hidden');
  }

  function openInbox() {
    closeEncryptedSurfaces(); document.body.classList.remove('navigation-open');
    state.inboxOpen = true;
    el.threadView.classList.add('hidden'); el.diffView.classList.add('hidden');
    el.catchupView.classList.add('hidden'); el.fleetView.classList.add('hidden');
    el.inboxView.classList.remove('hidden'); el.inboxBtn.classList.add('active');
    renderInbox();
    refreshEncrypted().catch(() => {});
  }

  function closeInbox() {
    if (!state.inboxOpen) return;
    state.inboxOpen = false;
    el.inboxView.classList.add('hidden'); el.inboxBtn.classList.remove('active');
    if (state.activeThreadId) el.threadView.classList.remove('hidden'); else el.fleetView.classList.remove('hidden');
  }

  function closeCatchup() {
    if (!state.catchupOpen) return;
    state.catchupOpen = false; el.catchupView.classList.add('hidden'); el.catchupBtn.classList.remove('active');
    if (state.activeThreadId) el.threadView.classList.remove('hidden'); else el.fleetView.classList.remove('hidden');
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
    for (const u of state.users) { const o = document.createElement('option'); o.value = u.userId; o.textContent = u.name + (state.me && u.userId === state.me.id ? ' (me)' : ''); el.assignUser.appendChild(o); }
    const want = cur || (state.activeThread && state.activeThread.assignee && state.activeThread.assignee.userId);
    if (want && [...el.assignUser.options].some((o) => o.value === want)) el.assignUser.value = want;
  }

  // Shared encrypted workspace presentation. Operational results come only from the
  // verified log or host receipts; local state contains selection and unsent drafts.
  function uiNode(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function uiButton(label, action, handler, primary = false) {
    const button = uiNode('button', 'mini-btn' + (primary ? ' primary' : ''), label);
    button.type = 'button'; button.dataset.action = action;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await handler(); if (action.includes('recovery') || action === 'restore-history') pilot.clear('recovery'); } catch (error) {
        showEncryptedError(error);
        const scope = button.closest('section, dialog');
        if (scope) { let detail = scope.querySelector('.ew-inline-error'); if (!detail) { detail = uiNode('p', 'ew-error ew-inline-error'); detail.setAttribute('role', 'alert'); scope.append(detail); } const code = error.code || error.message || 'Action unavailable'; detail.textContent = hostToolsFailureMessage(code) || code; }
      }
      finally { if (button.isConnected) button.disabled = false; }
    });
    return button;
  }
  function uiField(label, name, { multiline = false, options = null, value = '', type = 'text' } = {}) {
    const wrap = uiNode('label', 'ew-field'); wrap.append(uiNode('span', 'small', label));
    const input = uiNode(options ? 'select' : multiline ? 'textarea' : 'input');
    if (!multiline && !options) input.type = type;
    input.name = name; input.setAttribute('aria-label', label); input.autocomplete = 'off';
    if (options) for (const option of options) { const o = uiNode('option', null, option.name || option.label || option.id); o.value = option.id; input.append(o); }
    input.value = value || (options && options[0]?.id) || ''; wrap.append(input); return { wrap, input };
  }
  function uiSection(title, description) {
    const section = uiNode('section', 'ew-section'); section.append(uiNode('h3', null, title));
    if (description) section.append(uiNode('p', 'ew-explain', description));
    return section;
  }
  function hostToolsFailureMessage(code) {
    if (['codex_host_tools_version_unsupported', 'codex_host_tools_model_unsupported', 'codex_host_tools_platform_unproven'].includes(code)) {
      return 'Use the supported Codex 0.153.4 setup on macOS with Apple silicon (darwin/arm64) and model gpt-5.5, then start a new turn.';
    }
    if (code === 'codex_host_tools_login_required') {
      return 'Sign in with ChatGPT on the execution host using Codex’s local file credential storage, then configure the supported isolated host setup. Provider credentials stay on that machine.';
    }
    if (typeof code === 'string' && code.startsWith('codex_host_tools_')) {
      return 'Reconfigure the supported isolated host setup on the execution machine. Its configuration, instructions, tools or credential profile could not be verified. Keep the isolation checks enabled before retrying.';
    }
    return null;
  }
  function showEncryptedError(error) {
    const code = error.code || error.message || 'Action unavailable';
    if (state.recoveryOpen) pilot.failure('recovery', code);
    else if (/^(codex_|provider_)/.test(code)) pilot.failure('provider', code);
    else if (state.encryptedState?.state !== 'verified') pilot.failure('endpoint', code);
    const explanation = code === 'endpoint_key_mismatch'
      ? 'The execution host keys do not match the verified fingerprint. Confirm the host identity through a trusted channel before sending more work.'
      : FRIENDLY[code] || hostToolsFailureMessage(code) || code;
    toast(esc(explanation));
    const message = $('#ew-error'); if (message) message.textContent = explanation;
    if (!activeEncryptedTask() && !el.fleetView.classList.contains('hidden')) {
      let detail = $('#encrypted-composer-error');
      if (!detail) { detail = uiNode('p', 'ew-error'); detail.id = 'encrypted-composer-error'; detail.setAttribute('role', 'alert'); el.composer.append(detail); }
      detail.textContent = explanation;
    }
  }
  function activeEncryptedTask() { return state.encryptedTasks.find(task => task.id === state.activeThreadId) || null; }
  function encryptedSnapshot() { return state.encryptedSnapshots.get(state.activeThreadId) || null; }
  function encryptedTurnId() {
    const snap = encryptedSnapshot();
    return snap && (snap.activeTurnId || snap.turnId || snap.execution?.turnId) || null;
  }
  function hostOnline(task = activeEncryptedTask()) { return !!(task && state.connected && state.runtimes.find(r => r.id === task.runtimeId)?.online); }
  function canControlTask() { return !!(state.encryptedState?.state === 'verified' && hostOnline() && encryptedSnapshot() &&
    state.encrypted?.confirmedHost(activeEncryptedTask()?.runtimeId) && !encryptedSnapshot().outcome); }
  function closeEncryptedSurfaces() {
    $('#encrypted-workspace').classList.add('hidden'); $('#access-view').classList.add('hidden');
    state.accessOpen = false; $('#app').classList.remove('encrypted-selected');
  }
  function hideWorkViews() {
    for (const id of ['fleet-view', 'thread-view', 'diff-view', 'catchup-view', 'inbox-view', 'recovery-view', 'access-view']) $('#' + id).classList.add('hidden');
    state.catchupOpen = false; state.inboxOpen = false; state.recoveryOpen = false; state.accessOpen = false;
  }
  async function refreshEncryptedSetup() {
    if (!state.encrypted) return;
    const desktop = window.harnessDesktop;
    if (desktop?.encryptedSetup) state.localEncryptedSetup = await desktop.encryptedSetup();
    if (desktop?.codexStatus && !state.localCodexStatus) state.localCodexStatus = await desktop.codexStatus();
    const local = state.localEncryptedSetup;
    const projects = [];
    for (const runtime of state.runtimes) {
      const localProjects = local?.runtimeId === runtime.id ? local.projects || [] : [];
      for (const project of runtime.encryptedProjects || []) {
        if (state.encryptedState?.membershipIdentity?.deletions?.some(entry => entry.action === 'project.delete' && entry.projectId === project.id)) continue;
        const named = localProjects.find(p => p.id === project.id);
        projects.push({ ...project, runtimeId: runtime.id, name: named?.name || project.name || 'Shared project ' + project.id.slice(-6) });
      }
    }
    const old = el.fleetProject.value;
    state.encryptedProjects = projects; renderProjects();
    if ([...el.fleetProject.options].some(o => o.value === old)) el.fleetProject.value = old;
    renderEncryptedSetup(); restoreWorkspace(); renderProjectWorkspace();
  }
  function renderEncryptedSetup() {
    const root = $('#encrypted-setup'); if (!root) return;
    if (!state.encrypted) return;
    const runtime = selectedRuntime();
    if (state.setupHostPrompt && (state.setupHostPrompt.runtimeId !== runtime?.id || state.setupHostPrompt.teamId !== state.teamId)) state.setupHostPrompt = null;
    const signature = JSON.stringify([state.encryptedState?.state, state.encryptedIdentity?.fingerprint, state.localEncryptedSetup, state.localCodexStatus, runtime?.id, runtime?.encryptedEndpoint, state.encrypted.confirmedHost(runtime?.id), state.setupHostPrompt, state.encryptedState?.membershipIdentity, state.localSetupNotice]);
    if (root.dataset.signature === signature) return;
    root.dataset.signature = signature; root.replaceChildren();
    const panel = uiSection('Encrypted execution', 'Choose the machine and project that will run this task. Provider usage belongs to the account configured on that machine.');
    panel.append(uiNode('p', 'small', 'This endpoint: ' + (state.encryptedState?.state || 'starting')));
    if (state.encryptedIdentity) panel.append(uiNode('p', 'ew-fingerprint mono', state.encryptedIdentity.fingerprint));
    const desktop = window.harnessDesktop;
    if (desktop?.confirmEncryptionAuthority && state.membership?.role === 'owner' && state.encryptedState?.membershipIdentity?.owner &&
        !(state.localEncryptedSetup?.runtimeId === runtime?.id && state.localEncryptedSetup.authority)) {
      panel.append(uiButton('Authorize this execution host', 'authorize-encrypted-host', async () => {
        const teamId = state.teamId;
        await refreshEncrypted();
        const identity = state.encryptedState?.membershipIdentity?.owner;
        if (state.teamId !== teamId || !identity) throw new Error('Verify the original team owner fingerprint before authorizing this execution host.');
        await desktop.confirmEncryptionAuthority({ teamId, identity });
        await refreshEncryptedSetup(); send({ type: 'runtimes.list' });
      }));
    }
    if (desktop?.confirmApprovalAuthority && state.encryptedState?.state === 'verified') {
      panel.append(uiButton('Set this device as host approver', 'authorize-host-approver', async () => {
        await desktop.confirmApprovalAuthority({ teamId: state.teamId, identity: state.encrypted.endpoint.identity(),
          recoveryEpoch: state.encryptedState?.membershipIdentity?.recoveryEpoch || null });
        await refreshEncryptedSetup(); send({ type: 'runtimes.list' });
      }));
    }
    renderFreshnessAuthority(panel, runtime);
    if (desktop?.configureCodex) {
      const status = state.localCodexStatus;
      if (status?.supportedVersion) panel.append(uiNode('p', 'small',
        'Supported setup: Codex ' + status.supportedVersion + ' on an Apple silicon Mac, with a locally saved ChatGPT or API login.'));
      if (status?.available && status.supportedVersion && status.version !== status.supportedVersion) {
        panel.append(uiNode('p', 'ew-error', 'This machine has Codex ' + status.version + '. Install the supported version, then choose Check setup again.'));
      }
      if (status?.platformSupported === false) panel.append(uiNode('p', 'ew-error', 'Shared Codex execution is not yet qualified on this platform. Join from this browser or use a supported Mac execution host.'));
      panel.append(uiNode('p', 'small', status?.available
        ? 'Codex ' + (status.version || '') + ' · ' + ({ chatgpt: 'ChatGPT account connected', apikey: 'API account connected',
          none: 'Run codex login on this execution host before starting a task.',
          config_error: 'The CLI cannot load its configuration. Use a compatible Codex version and check its local settings.',
          unavailable: 'Account status could not be checked. Run codex login status on this execution host.' }[status.authMode]
          || 'Account mode is unknown. Check codex login status on this execution host.')
        : 'Install Codex and sign in on this execution host to use its local provider account.'));
      panel.append(uiButton('Configure Codex on this machine', 'configure-local-codex', async () => {
        const result = await desktop.configureCodex();
        state.localSetupNotice = result?.enabled ? 'Codex is configured. The execution host is reconnecting; select Codex in the task composer once it is ready.'
          : result?.code ? 'Codex could not be enabled. Check the supported version and local account below, then retry.' : 'Codex setup was cancelled. Your project and team setup are preserved.';
        state.localCodexStatus = await desktop.codexStatus(); await refreshEncryptedSetup();
        send({ type: 'runtimes.list' });
      }));
    }
    if (desktop?.codexStatus) panel.append(uiButton('Check setup again', 'refresh-local-setup', async () => {
      state.localCodexStatus = await desktop.codexStatus(); state.localSetupNotice = null;
      await refreshEncryptedSetup(); send({ type: 'runtimes.list' });
    }));
    if (state.localSetupNotice) { const notice = uiNode('p', 'small', state.localSetupNotice); notice.setAttribute('role', 'status'); panel.append(notice); }
    if (runtime?.taskProtocol === 'encrypted-v1' && !state.encrypted.confirmedHost(runtime.id)) {
      panel.append(uiButton('Verify execution host', 'show-host-fingerprint', async () => {
        const teamId = state.teamId;
        const endpoints = await state.encrypted.hostEndpoints(runtime.id);
        if (selectedRuntime()?.id !== runtime.id || state.teamId !== teamId) return;
        state.setupHostPrompt = { teamId, runtimeId: runtime.id, endpoints };
        renderEncryptedSetup();
      }));
      if (state.setupHostPrompt) panel.append(hostConfirmation(state.setupHostPrompt));
    }
    root.append(panel); renderSetupProgress();
  }
  function renderFreshnessAuthority(panel, runtime) {
    const local = state.localEncryptedSetup;
    const desktop = window.harnessDesktop;
    if (!runtime?.id) return;
    if (local?.runtimeId !== runtime.id || local?.teamId !== state.teamId) {
      panel.append(uiSection('Membership recovery on the execution host',
        'Open the installed app on this execution machine to appoint a verified replacement owner device. A remote browser cannot change the host’s selected membership signer.'));
      return;
    }
    if (!local.authority) return;
    const identity = state.encrypted.endpoint.identity();
    const original = local.authority;
    const selected = local.freshnessAuthority;
    const signer = selected?.signer || original;
    const sameDevice = ['user', 'device', 'curve25519', 'ed25519'].every(key => signer[key] === identity[key]);
    const membership = state.encryptedState?.membershipIdentity;
    const originalAuthorityMatches = ['user', 'device', 'curve25519', 'ed25519'].every(key => membership?.owner?.[key] === original[key]);
    const owner = original.user === identity.user && originalAuthorityMatches;
    const verified = membership?.state === 'verified';
    const currentEpoch = (selected?.recoveryEpoch || null) === (membership?.recoveryEpoch || null);
    const section = uiSection('Membership recovery on this host',
      'A verified replacement device for the original owner can confirm current membership for this execution host. The original team identity stays unchanged.');
    section.dataset.state = selected?.state || 'original';
    section.append(uiNode('p', 'small', 'Current membership signer: ' + signer.device +
      (selected?.state === 'revoked' ? ' · revoked; current membership cannot be confirmed' : sameDevice ? ' · this device' : ' · another device')));
    section.append(uiNode('p', 'ew-fingerprint mono', window.PlexusEncrypted.fingerprint(signer)));
    section.append(uiNode('p', 'small', 'This restores membership confirmation on this host only. It does not restore approval rights or provider credentials. Other hosts need separate local confirmation.'));
    if (!desktop?.confirmFreshnessAuthority) {
      section.append(uiNode('p', 'cu-missing', 'Open the installed app on the execution machine to appoint a replacement device.'));
    } else if (membership?.state === 'revoked' || selected?.state === 'revoked' && sameDevice) {
      section.append(uiNode('p', 'cu-missing', 'This device is revoked. Use a different owner device verified by a surviving teammate, or restore a separately prepared owner authority kit on a new device before local confirmation.'));
    } else if (!owner || !verified) {
      section.append(uiNode('p', 'cu-missing', !membership?.owner
        ? 'Compare the original team owner fingerprint in Team & access. A surviving verified teammate must then verify this replacement device.'
        : !originalAuthorityMatches ? 'The verified team identity does not match this host’s original authority. Compare the original fingerprint with a trusted teammate before continuing.'
        : original.user !== identity.user ? 'Only a verified replacement device of the original team owner can be appointed here.'
          : 'A surviving teammate must verify this device, or you can restore a separately prepared owner authority kit. History-only backups do not authorize membership.'));
    } else if (!sameDevice || !currentEpoch) {
      section.append(uiButton('Use this verified device for membership recovery', 'authorize-freshness-authority', () => activateMembershipRecovery(runtime)));
    } else section.append(uiNode('p', 'small', 'This device is already the selected membership signer for this host.'));
    panel.append(section);
  }
  async function activateMembershipRecovery(runtime) {
    const local = state.localEncryptedSetup, desktop = window.harnessDesktop;
    if (!runtime || !desktop?.confirmFreshnessAuthority || local?.runtimeId !== runtime.id || local.teamId !== state.teamId) {
      throw new Error('Open the installed app on the selected execution host to confirm recovery locally.');
    }
    const teamId = state.teamId, runtimeId = runtime.id, identity = state.encrypted.endpoint.identity();
    try {
      const result = await desktop.confirmFreshnessAuthority({ teamId, identity });
      if (!result?.confirmed || state.teamId !== teamId || selectedRuntime()?.id !== runtimeId) return;
      await refreshEncryptedSetup(); send({ type: 'runtimes.list' });
      toast('This host now uses the replacement membership signer. Other hosts, approval rights and provider credentials are unchanged.');
    } catch (error) {
      const code = error.code || error.message || '';
      throw new Error(code.includes('freshness_host_busy')
        ? 'Finish or interrupt the active agent turn, then retry membership recovery on this host.'
        : code.includes('local_runtime_restart_failed')
          ? 'The signer was saved, but the host did not restart. Retry local startup and check the selected signer before continuing.'
          : 'Membership recovery could not be verified. Refresh local setup and verify this device through a trusted teammate or a valid owner authority kit before retrying.');
    }
  }
  async function selectEncryptedTask(id) {
    $('#encrypted-composer-error')?.remove();
    if (state.subscribedId) send({ type: 'thread.unsubscribe', threadId: state.subscribedId });
    state.subscribedId = null; state.activeThreadId = id; state.activeThread = null; state.setupHostPrompt = null;
    state.draftTarget = null; el.input.value = ''; state.catchupSnapshot = state.encryptedSnapshots.get(id) || null;
    state.catchup = null; state.catchupExplain = null; state.projectAccess = null;
    hideWorkViews(); $('#encrypted-workspace').classList.remove('hidden'); $('#app').classList.add('encrypted-selected');
    $('#ew-composer').append(el.composer); el.composer.classList.remove('hidden');
    el.navFleet.classList.remove('active');
    for (const node of [el.assignBtn, el.auditBtn, el.catchupBtn, el.changesBtn, el.topbarBranch, el.topbarWorktree]) node.classList.add('hidden');
    const task = activeEncryptedTask();
    const runtime = state.runtimes.find(r => r.id === task.runtimeId);
    if (runtime) { el.fleetRuntime.value = runtime.id; renderProjects(); el.fleetProject.value = task.projectId; }
    rememberWorkspace();
    renderProviderPicker({ runtimeId: task.runtimeId });
    el.topbarRuntime.textContent = runtime?.name || task.runtimeId; el.topbarRuntime.classList.remove('hidden');
    renderEncryptedWorkspace(); renderThreadList();
    document.body.classList.remove('navigation-open');
    await updateEncryptedTask();
  }
  async function updateEncryptedTask() {
    const task = activeEncryptedTask(); if (!task || !state.encrypted) return;
    const id = task.id;
    const runtime = state.runtimes.find(r => r.id === task.runtimeId);
    const result = await state.encrypted.catchUp(task, {
      host: runtime?.name || task.runtimeId, hostConnected: hostOnline(task),
      responsible: nameFor(task.creatorUserId) || task.creatorUserId
    });
    if (id !== state.activeThreadId) return;
    if (result.error) {
      state.catchupExplain = result.error === 'host_unconfirmed' ? 'Verify the execution host before opening this history.'
        // Not an integrity problem and not something a retry fixes: this endpoint is not yet
        // covered by a signed membership, so the host's keys cannot be delivered to it at all.
        : result.error === 'membership_authority_required'
          ? 'This device is not covered by a signed team membership yet, so the execution host cannot deliver its keys here. Ask a teammate who already holds membership authority to publish one that includes this device.'
          : 'History unavailable: ' + result.error + '. Previously verified records remain available.';
      if (result.historyRecovery?.state === 'host_offline') state.catchupExplain += ' Reconnect the execution host to request another authenticated history transfer.';
      else if (result.historyRecovery?.state === 'requested') state.catchupExplain += ' A fresh history transfer has been requested; the task remains unavailable until verification succeeds.';
      else if (result.historyRecovery?.state === 'throttled') state.catchupExplain += ' History delivery retries are briefly paused; the task remains unavailable until verification succeeds.';
      else if (result.historyRecovery?.state === 'unavailable') state.catchupExplain += ' History transfer could not be requested: ' + result.historyRecovery.code + '.';
    } else {
      state.encryptedSnapshots.set(id, result.snapshot); state.encryptedTitles.set(id, result.snapshot.title || id);
      state.catchupSnapshot = result.snapshot; state.catchup = result.projection; state.catchupExplain = null;
    }
    if (state.encrypted.projectAccess) {
      try { const access = await state.encrypted.projectAccess(task.projectId); if (id !== state.activeThreadId) return; state.projectAccess = access; }
      catch { if (id !== state.activeThreadId) return; state.projectAccess = null; }
    }
    renderEncryptedWorkspace(); renderThreadList();
  }
  async function submitEncrypted(label, operation) {
    const task = activeEncryptedTask();
    const submitted = await operation();
    if (submitted?.commandId) state.encryptedReceipts.set(submitted.commandId, { label, taskId: task?.id, submitted });
    renderEncryptedReceipts();
    return submitted;
  }
  async function sendEncryptedMessage(text, settings) {
    el.send.disabled = true;
    $('#encrypted-composer-error')?.remove();
    try {
      if (!state.encrypted || state.encryptedState?.state !== 'verified') throw new Error('Verify this endpoint in Team & access before starting or steering work.');
      let task = activeEncryptedTask();
      if (!task) {
        const runtime = selectedRuntime(); const projectId = el.fleetProject.value;
        if (state.newTaskDraft && (state.newTaskDraft.runtimeId !== runtime?.id || state.newTaskDraft.projectId !== projectId)) {
          throw new Error('This draft was written for another project. Return to that project, or clear the draft before starting work here.');
        }
        if (!runtime?.online || !projectId) throw new Error('Choose an online execution host and an explicitly shared project.');
        if (!state.encrypted.confirmedHost(runtime.id)) { renderEncryptedSetup(); throw new Error('Verify the execution host in setup before sending the objective.'); }
        task = await state.encrypted.createTask(runtime.id, projectId, { title: text.split('\n')[0].slice(0, 120), objective: text, settings });
        state.encryptedTasks.push(task); state.encryptedTitles.set(task.id, text.split('\n')[0].slice(0, 120));
        await selectEncryptedTask(task.id);
      } else {
        if (!canControlTask()) throw new Error('Task controls are unavailable until the host is connected and your endpoint is verified.');
        const target = state.draftTarget || { taskId: task.id, turnId: encryptedTurnId() };
        if (target.taskId !== task.id) throw new Error('This draft belongs to another task.');
        if (target.turnId !== encryptedTurnId()) throw new Error('The agent turn changed while you were writing. Copy or clear this draft, then write a new instruction for the current turn.');
        const input = [{ type: 'text', text }];
        if (target.turnId) await submitEncrypted('Direction from ' + state.me.name + ' · turn ' + target.turnId,
          () => state.encrypted.steer(task, { input, expectedTurnId: target.turnId }));
        else await submitEncrypted('Start follow-up from ' + state.me.name, () => state.encrypted.startTurn(task, { input, settings }));
      }
      el.input.value = ''; state.draftTarget = null; state.newTaskDraft = null; autosize();
      await updateEncryptedTask();
    } catch (error) { showEncryptedError(error); }
    finally { if (activeEncryptedTask()) renderEncryptedWorkspace(); else el.send.disabled = !selectedRuntime()?.online || !state.connected; }
  }
  function renderEncryptedReceipts() {
    const root = $('#ew-receipts'); root.replaceChildren();
    for (const recorded of encryptedSnapshot()?.receipts || []) if (!state.encryptedReceipts.has(recorded.commandId)) {
      state.encryptedReceipts.set(recorded.commandId, { taskId: state.activeThreadId, label: 'Command from ' + (nameFor(recorded.actor) || recorded.actor || 'teammate'), submitted: recorded });
    }
    for (const [id, held] of [...state.encryptedReceipts].reverse()) {
      if (held.taskId && held.taskId !== state.activeThreadId) continue;
      const receipt = state.encrypted?.receipt?.(id) || held.submitted;
      const entry = uiNode('div', 'ew-receipt');
      const status = receipt?.state || receipt?.outcome || 'submitted';
      entry.dataset.commandId = id; entry.dataset.state = status;
      entry.append(uiNode('p', null, held.label), uiNode('p', 'small', status === 'submitted' ? 'Submitted · awaiting the host' : String(status)));
      if (receipt?.error || receipt?.code) {
        const code = receipt.error?.code || receipt.error || receipt.code;
        entry.append(uiNode('p', 'ew-error', hostToolsFailureMessage(code) || code));
      }
      const explanations = {
        accepted: 'The host accepted the request; this alone does not confirm execution.',
        queued: 'Waiting for the agent to receive this instruction.',
        delivered: 'The host confirmed delivery; review the resulting changes separately.',
        rejected: 'The host refused this request. Review the reason before sending another.',
        unknown: 'The outcome is unknown. Reconnect and inspect history before retrying.'
      };
      if (explanations[status]) entry.append(uiNode('p', 'small', explanations[status]));
      if (!hostOnline() && ['submitted', 'accepted', 'queued'].includes(status)) {
        entry.dataset.delivery = 'unknown';
        entry.append(uiNode('p', 'ew-error', 'Connection unavailable. Current delivery is unknown; this request will not be resent automatically.'));
      }
      const settled = receipt?.result?.settled || receipt?.settled;
      if (settled) entry.append(uiNode('p', 'small', 'Settled by ' + (settled.by?.name || settled.by?.userId || settled.by || 'another approver') + ' · ' + settled.decision));
      root.append(entry);
    }
  }
  function openEncryptedSource(source) {
    const pane = uiNode('aside', 'cu-source-pane'); pane.setAttribute('aria-label', 'Source record');
    window.PlexusCatchup.renderSource(window.PlexusCatchup.resolveSource(encryptedSnapshot(), source), pane);
    pane.prepend(uiButton('Close source', 'close-source', () => pane.remove()));
    $('#ew-content').append(pane); pane.scrollIntoView({ block: 'nearest' });
  }
  function currentTaskCatchup(task) {
    const projection = state.catchup;
    if (!projection || projection.scope?.taskId !== task?.id) return null;
    if (!hostOnline(task) || state.catchupExplain) return { ...projection, freshness: {
      ...projection.freshness, state: 'unknown',
      explain: !hostOnline(task) ? 'The execution host is not connected. Previously verified history remains available; current execution is unknown.'
        : 'History refresh is unavailable. Showing previously verified records.'
    } };
    return projection;
  }
  function renderEncryptedWorkspace() {
    const task = activeEncryptedTask(); if (!task || $('#encrypted-workspace').classList.contains('hidden')) return;
    const snapshot = encryptedSnapshot(); const runtime = state.runtimes.find(r => r.id === task.runtimeId);
    const title = snapshot?.title || state.encryptedTitles.get(task.id) || 'Opening encrypted task';
    el.topbarTitle.textContent = title;
    const head = $('#ew-heading'); head.replaceChildren(uiNode('h1', null, title));
    head.append(uiNode('p', 'ew-ownership', 'Responsible: ' + (nameFor(snapshot?.responsible || task.creatorUserId) || snapshot?.responsible || 'You') +
      ' · Host: ' + (runtime?.name || task.runtimeId) + ' · ' + (hostOnline(task) ? 'Connected' : 'Disconnected · execution may be unknown')));
    head.append(uiNode('p', 'small', 'Provider: ' + (snapshot?.provider || 'Awaiting host record') + ' · Account: execution host’s provider account · Agent turn: ' + (snapshot?.turn || 'awaiting host record') + ' · Task outcome: ' + (snapshot?.outcome || 'open')));
    const nav = $('#ew-tabs'); nav.replaceChildren();
    for (const [id, label] of [['review', 'Changes'], ['catchup', 'Catch up'], ['access', 'Access']]) {
      const button = uiButton(label, 'view-' + id, () => { state.encryptedTab = id; renderEncryptedWorkspace(); });
      button.setAttribute('aria-current', state.encryptedTab === id ? 'page' : 'false'); nav.append(button);
    }
    nav.append(uiButton('Discussion', 'toggle-discussion', () => $('#encrypted-workspace').classList.toggle('inspector-open')));
    const content = $('#ew-content');
    const projection = currentTaskCatchup(task);
    // Keep a person’s partially completed access/action form stable while replay updates.
    const editing = content.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    const now = Date.now();
    const deadlines = JSON.stringify([(snapshot?.approvals || []).map(request => !!request.expiresAt && request.expiresAt <= now),
      (snapshot?.approvers || []).map(grant => grant.expiresAt <= now)]);
    const contentSignature = JSON.stringify([task.id, state.encryptedTab, snapshot?.events?.length, state.catchup?.freshness?.state, hostOnline(task), state.encryptedState?.state, state.catchupExplain, state.projectAccess, state.encryptedState?.endpoints, state.encryptedState?.revocations, state.users, deadlines]);
    // Deadlines can change eligibility without another host event. Preserve drafts,
    // but never retain an enabled expired decision just because a field has focus.
    const authority = JSON.stringify([canControlTask(), snapshot?.activeTurnId, snapshot?.outcome,
      snapshot?.approvers, snapshot?.decisions, state.encryptedState?.revocations, projectPeople()]);
    if ((!editing || content.dataset.approvalDeadlines !== deadlines || content.dataset.authority !== authority) && content.dataset.signature !== contentSignature) {
      const openSections = new Set([...content.querySelectorAll('details[open]')].map(node => node.querySelector('summary')?.textContent));
      const drafts = new Map([...content.querySelectorAll('input[name],textarea[name],select[name]')].map(node => [node.name, { value: node.value, checked: node.checked }]));
      content.dataset.signature = contentSignature; content.dataset.approvalDeadlines = deadlines; content.dataset.authority = authority; content.replaceChildren();
      const error = uiNode('p', 'ew-error', state.catchupExplain || ''); error.id = 'ew-error'; error.setAttribute('role', 'status'); content.append(error);
      if (state.catchupExplain && state.encryptedState?.membershipIdentity?.state !== 'verified') content.append(uiButton('Open Team & access', 'task-enrollment', openAccess));
      if (!state.encrypted.confirmedHost(task.runtimeId)) {
        content.append(uiButton('Verify execution host', 'verify-task-host', async () => content.append(hostConfirmation({ runtimeId: task.runtimeId, endpoints: await state.encrypted.hostEndpoints(task.runtimeId) }))));
      }
      if (state.encryptedTab === 'catchup' && projection) {
        const pane = uiNode('div'); content.append(pane);
        window.PlexusCatchup.renderCatchup(projection, pane, { onOpenSource: openEncryptedSource, onOpenTranscript: () => $('#encrypted-workspace').classList.add('inspector-open') });
      } else if (state.encryptedTab === 'access') renderAccessContent(content, task.projectId);
      else renderEncryptedReview(content, task, snapshot);
      for (const node of content.querySelectorAll('details')) node.open = openSections.has(node.querySelector('summary')?.textContent);
      for (const node of content.querySelectorAll('input[name],textarea[name],select[name]')) { const held = drafts.get(node.name); if (held) { node.value = held.value; node.checked = held.checked; } }
    }
    renderEncryptedDiscussion(snapshot);
    const targetTurn = state.draftTarget ? state.draftTarget.turnId : encryptedTurnId();
    $('#ew-target').textContent = targetTurn
      ? 'To ' + (snapshot?.provider || 'agent') + ' · turn ' + targetTurn
      : 'Start a follow-up on this task';
    el.send.disabled = !canControlTask();
    el.input.placeholder = canControlTask() ? 'Describe the correction for the agent…' : 'Host connection and verified access are required to send';
    renderEncryptedReceipts();
  }
  function renderEncryptedReview(content, task, snapshot) {
    const lastTurn = snapshot?.events?.findLast(event => event.type === 'turn.completed');
    if (snapshot?.turn === 'failed' && lastTurn) {
      const failure = uiSection('The provider turn failed'); failure.dataset.providerFailure = lastTurn.payload.error || 'provider_failed';
      const messages = {
        codex_auth_required: 'Sign in to Codex on the execution host, then start a new turn. Provider credentials stay on that machine.',
        codex_usage_limit: 'Check the provider account’s usage limits on the execution host. Start a new turn when that account can run again.',
        codex_model_unavailable: 'Choose a model available to the provider account on the execution host, then start a new turn.',
        codex_protocol_unsupported: 'Update or pin a supported Codex CLI version on the execution host, then retry.',
        codex_effort_unsupported: 'Choose a supported reasoning level on this execution host, then retry.',
        codex_unavailable: 'Install Codex on the execution host and verify that the app can find it.',
        codex_completion_missing: 'Codex exited without confirming completion. Review the recorded changes before starting another turn.',
        codex_disconnected: 'The provider connection ended. Review the recorded changes and reconnect the execution host before continuing.',
        codex_turn_timeout: 'The provider did not finish in time. Review the recorded changes before starting another turn.'
      };
      failure.append(uiNode('p', 'ew-error', messages[lastTurn.payload.error] || hostToolsFailureMessage(lastTurn.payload.error) || 'Check Codex on the execution host. Review the recorded changes before starting another turn.'));
      content.append(failure);
    }
    const objective = uiSection('The objective'); objective.append(uiNode('p', null, snapshot?.objective || 'Waiting for the host to record the encrypted objective.')); content.append(objective);
    const changes = uiSection('Review the changes', 'Read-only changes recorded by the execution host. Open a source to inspect its original record.');
    const files = snapshot?.diffs || [];
    if (!files.length) changes.append(uiNode('p', 'cu-missing', 'No successful file change has been recorded.'));
    for (const file of files) {
      const panel = uiNode('article', 'ew-file'); panel.append(uiNode('h4', 'mono', file.path));
      if (Array.isArray(file.lines) && file.lines.length) {
        const table = uiNode('table', 'diff-table');
        for (const line of file.lines) {
          const row = uiNode('tr', line.kind);
          for (const value of [line.oldLine || '', line.newLine || '', line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : '', line.text]) row.append(uiNode('td', null, String(value ?? '')));
          table.append(row);
        }
        const scroll = uiNode('div', 'ew-code-scroll'); scroll.append(table); panel.append(scroll);
      } else panel.append(uiNode('pre', 'ew-code-scroll', file.patch || 'Detailed diff unavailable in this event.'));
      const seq = (snapshot.events || []).findLastIndex(event => event.type === 'diff.updated' && event.payload.files?.some(f => f.path === file.path)) + 1;
      if (seq) panel.append(uiButton('View source · event ' + seq, 'open-diff-source', () => openEncryptedSource({ seq, type: 'diff.updated' })));
      changes.append(panel);
    }
    content.append(changes);
    renderEncryptedApprovals(content, task, snapshot);
    renderTaskActions(content, task, snapshot);
  }
  function renderEncryptedDiscussion(snapshot) {
    const root = $('#ew-discussion'); const oldScroll = root.scrollTop;
    root.replaceChildren(uiNode('h3', null, 'Review together'));
    const close = uiButton('Close discussion', 'close-discussion', () => $('#encrypted-workspace').classList.remove('inspector-open')); close.classList.add('ew-close-discussion'); root.append(close);
    root.append(uiNode('p', 'small', currentTaskCatchup(activeEncryptedTask())?.freshness?.explain || 'Waiting for a verified event range.'));
    for (const message of snapshot?.messages || []) {
      const row = uiNode('article', 'ew-message');
      const actor = message.actor?.name || nameFor(message.by?.userId || message.actor) || message.by?.name || (message.role === 'user' ? 'Teammate' : 'Agent');
      row.append(uiNode('h4', null, actor), uiNode('p', null, message.text)); root.append(row);
    }
    for (const request of snapshot?.help || []) {
      const row = uiNode('article', 'ew-message');
      row.append(uiNode('h4', null, (nameFor(request.from) || request.from) + ' asked ' + (nameFor(request.recipient) || request.recipient)),
        uiNode('p', null, request.question), uiNode('p', 'small', 'Human help · ' + (request.outcome || 'open')));
      if (!request.outcome && (request.from === state.me.id || request.recipient === state.me.id)) {
        const outcome = request.recipient === state.me.id ? 'resolved' : 'cancelled';
        row.append(uiButton(outcome === 'resolved' ? 'Resolve request' : 'Cancel request', outcome + '-help', () => submitEncrypted('Human help ' + outcome, () => state.encrypted.settleHelp(activeEncryptedTask(), request.id, outcome))));
      }
      root.append(row);
    }
    root.scrollTop = oldScroll;
  }
  function projectPeople() {
    const holders = state.projectAccess?.participants;
    const ids = Array.isArray(holders) ? new Set(holders.map(p => p.userId)) : null;
    return state.users.filter(user => !ids || ids.has(user.userId)).map(user => ({ id: user.userId, name: user.name }));
  }
  function isRequestApprovalOwner(snapshot, request) {
    if (!request) return false;
    // An explicit null on a newer request removes the creation-time authority.
    const owner = Object.hasOwn(request, 'approvalOwner') ? request.approvalOwner : snapshot?.details?.approvalOwner;
    return !!owner && ['user', 'device', 'curve25519', 'ed25519'].every(field =>
      typeof owner[field] === 'string' && owner[field] && owner[field] === state.encryptedIdentity?.[field]);
  }
  function isPendingApproval(snapshot, request, now = Date.now()) {
    return !!request && request.turnId === snapshot.activeTurnId &&
      !(request.expiresAt && request.expiresAt <= now) && !snapshot.decisions?.some(decision => decision.basis === request.id);
  }
  function renderEncryptedApprovals(root, task, snapshot) {
    const decisions = snapshot?.decisions || [];
    const approvals = snapshot?.approvals || [];
    for (const request of approvals) {
      const resolved = decisions.find(d => d.basis === request.id);
      const section = uiSection('A decision before the next step', request.reason);
      section.dataset.approvalId = request.id;
      section.append(uiNode('pre', 'ew-action mono', request.action));
      section.append(uiNode('p', 'small', 'Requested by: ' + (request.actor?.name || request.requester?.name || request.actor || 'Host agent') +
        ' · Host: ' + task.runtimeId + ' · Turn: ' + (request.turnId || 'unavailable') + ' · Scope: this action, once'));
      const seq = snapshot.events.findIndex(event => event.type === 'approval.requested' && event.payload.id === request.id) + 1;
      if (seq) section.append(uiButton('Inspect request', 'approval-source', () => openEncryptedSource({ seq, type: 'approval.requested' })));
      for (const grant of snapshot?.approvers || []) {
        if (grant.requestId !== request.id || grant.turnId !== request.turnId) continue;
        const active = isPendingApproval(snapshot, request) && grant.expiresAt > Date.now();
        const row = uiNode('p', 'ew-link-row', (active ? 'Approval delegated to ' : 'Previous approval grant for ') + (nameFor(grant.userId) || grant.userId) + ' · request ' + (grant.requestId || grant.scope?.requestId || 'unknown') + (active ? ' · expires ' + new Date(grant.expiresAt).toLocaleTimeString() : ' · no longer active'));
        if (active && isRequestApprovalOwner(snapshot, request)) row.append(uiButton('Remove approval grant', 'revoke-approval-grant', () => submitEncrypted('Approval grant revoked', () => state.encrypted.revokeApproval(task, { userId: grant.userId, turnId: grant.turnId }))));
        if (!canControlTask()) for (const button of row.querySelectorAll('button')) button.disabled = true;
        section.append(row);
      }
      if (resolved) section.append(uiNode('p', 'ew-receipt', (nameFor(resolved.actor) || resolved.actor) + ' · ' + resolved.text));
      else if (request.turnId !== snapshot.activeTurnId) section.append(uiNode('p', 'ew-error', 'This request belongs to a finished or interrupted turn. It cannot authorize a new action.'));
      else if (request.expiresAt && Date.now() >= request.expiresAt) section.append(uiNode('p', 'ew-error', 'Expired. This request can no longer authorize an action.'));
      else {
        const isOwner = isRequestApprovalOwner(snapshot, request);
        const grant = snapshot.approvers?.find(entry => entry.userId === state.me.id && entry.turnId === request.turnId &&
          entry.requestId === request.id && entry.expiresAt > Date.now());
        const mayApprove = isOwner || !!grant;
        const actions = uiNode('div', 'cu-actions');
        for (const [decision, label] of [['accept', 'Approve once'], ['decline', 'Decline']]) {
          const button = uiButton(label + ' as ' + state.me.name, 'encrypted-approval-' + decision,
            () => submitEncrypted(label, () => state.encrypted.resolveApproval(task, {
              requestId: request.id, turnId: request.turnId, fingerprint: request.fingerprint, decision
            })), decision === 'accept');
          button.disabled = !canControlTask() || !request.turnId || !request.fingerprint || !mayApprove;
          if (!mayApprove) button.title = 'The host approver must delegate this exact action to you before you can respond.';
          actions.append(button);
        }
        section.append(actions, uiNode('p', 'small', !hostOnline(task) ? 'Host unavailable. Approval and delegation wait until you reconnect.' : mayApprove
          ? 'The execution host checks the current grant and exact action; the first valid decision wins.'
          : 'Approval rights are missing. The host’s configured approver must delegate this exact action to you.'));
        if (isOwner) {
          const person = uiField('Delegate this action to', 'approval-recipient', { options: projectPeople() });
          const delegate = uiButton('Delegate this action', 'grant-action-approval', () => submitEncrypted('Delegate approval', () => state.encrypted.grantApproval(task, {
            userId: person.input.value, requestId: request.id, turnId: request.turnId,
            expiresAt: Math.min(request.expiresAt || Date.now() + 15 * 60000, Date.now() + 60 * 60000)
          })));
          delegate.disabled = !canControlTask();
          section.append(person.wrap, delegate);
        }
      }
      root.append(section);
    }
  }
  function renderTaskActions(root, task, snapshot) {
    const controls = uiSection('Work together');
    if (snapshot?.recovery) {
      controls.append(uiNode('p', 'ew-error', 'The host restarted during execution. The earlier process may have acted. Inspect the recorded changes before explicitly starting a new turn.'));
      controls.append(uiButton('Acknowledge unknown execution and start follow-up', 'acknowledge-recovery', async () => {
        const text = el.input.value.trim(); if (!text) throw new Error('Write the new objective in the composer first.');
        await submitEncrypted('Follow-up after unknown execution', () => state.encrypted.startTurn(task, { input: [{ type: 'text', text }], acknowledgeUnknown: true }));
        el.input.value = ''; state.draftTarget = null; await updateEncryptedTask();
      }));
    }
    const stop = uiButton('Interrupt active turn', 'encrypted-interrupt', () => submitEncrypted('Interruption requested', () => state.encrypted.interrupt(task, { turnId: encryptedTurnId() })));
    stop.disabled = !canControlTask() || !encryptedTurnId(); controls.append(stop);
    controls.append(uiButton('Copy private task link', 'copy-private-task', async () => {
      const link = state.encrypted.privateLink(task); await navigator.clipboard.writeText(link);
      toast('Private link copied. Membership and verified key access are still required.');
    }));
    const help = uiNode('details', 'ew-details'); help.append(uiNode('summary', null, 'Ask a teammate'));
    const recipient = uiField('Help recipient', 'help-recipient', { options: projectPeople().filter(p => p.id !== state.me.id) });
    const question = uiField('Question for your teammate', 'help-question', { multiline: true });
    help.append(recipient.wrap, question.wrap, uiNode('p', 'small', 'This is a human request. It does not send an instruction to the agent.'),
      uiButton('Send help request', 'ask-for-help', async () => {
        await submitEncrypted('Help request', () => state.encrypted.askForHelp(task, { question: question.input.value, recipient: recipient.input.value })); question.input.value = '';
      })); controls.append(help);
    const handoff = uiNode('details', 'ew-details'); handoff.append(uiNode('summary', null, 'Hand off responsibility'));
    const next = uiField('New responsible teammate', 'handoff-recipient', { options: projectPeople() });
    const note = uiField('Handoff note', 'handoff-note', { multiline: true });
    handoff.append(next.wrap, note.wrap, uiNode('p', 'small', 'Execution stays on ' + task.runtimeId + '. Provider credentials and approval grants stay unchanged.'),
      uiButton('Hand off responsibility', 'encrypted-handoff', () => submitEncrypted('Responsibility handoff', () => state.encrypted.handOverResponsibility(task, { to: next.input.value, note: note.input.value })))); controls.append(handoff);
    const related = uiNode('details', 'ew-details'); related.append(uiNode('summary', null, 'Related work'));
    const link = uiField('Issue or pull request URL', 'related-url', { type: 'url' });
    const label = uiField('Link title (optional)', 'related-title');
    related.append(link.wrap, label.wrap, uiNode('p', 'small', 'The association is encrypted. Adding it does not read or post to the tracker.'),
      uiButton('Add link', 'add-related-link', async () => { await submitEncrypted('Related work', () => state.encrypted.addLink(task, { url: link.input.value, title: label.input.value })); link.input.value = ''; }));
    for (const entry of snapshot?.links || []) {
      if (entry.removedBy) continue;
      const row = uiNode('p', 'ew-link-row'); const anchor = uiNode('a', 'cu-link', entry.title || entry.url);
      if (/^https?:\/\//i.test(entry.url)) { anchor.href = entry.url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
      row.append(anchor, uiButton('Remove', 'remove-related-link', () => submitEncrypted('Remove related link', () => state.encrypted.removeLink(task, entry.id)))); related.append(row);
    }
    controls.append(related);
    const outcome = uiNode('details', 'ew-details'); outcome.append(uiNode('summary', null, 'Record the task outcome'));
    outcome.append(uiNode('p', 'small', snapshot?.outcome ? 'Recorded outcome: ' + snapshot.outcome : 'An agent turn ending does not complete the task. Record your decision after review.'));
    if (!snapshot?.outcome) for (const [value, label_] of [['completed', 'Mark completed'], ['cancelled', 'Mark cancelled']]) outcome.append(uiButton(label_, 'outcome-' + value,
      () => submitEncrypted('Task ' + value, () => state.encrypted.recordOutcome(task, value))));
    controls.append(outcome);
    if (!canControlTask()) for (const button of controls.querySelectorAll('button')) if (button.dataset.action !== 'copy-private-task') button.disabled = true;
    root.append(controls);
    pilot.taskActions(root, task);
  }
  function originalRemovalAvailability() {
    const membership = state.encryptedState?.membershipIdentity;
    const identity = state.encryptedIdentity;
    const same = (left, right) => !!left && !!right && ['user', 'device', 'curve25519', 'ed25519'].every(key => left[key] === right[key]);
    if (membership?.state !== 'verified' || identity?.user !== membership.owner?.user || same(identity, membership.owner)) {
      return { allowed: false, reason: 'Use a different verified device of the original owner. A surviving verified teammate can verify a replacement.' };
    }
    const desktop = window.harnessDesktop;
    if (!desktop?.encryptedSetup || !desktop?.confirmFreshnessAuthority) {
      return { allowed: false, reason: 'Open the installed app on an execution host and complete its local appointment before removing the original device.' };
    }
    const local = state.localEncryptedSetup, selected = local?.freshnessAuthority;
    const runtimeId = activeEncryptedTask()?.runtimeId || selectedRuntime()?.id;
    if (local?.teamId !== state.teamId || local.runtimeId !== runtimeId || !same(local.authority, membership.owner) ||
        selected?.state !== 'active' || !/^[a-f0-9]{32}$/.test(selected.activationId || '') ||
        !same(selected.genesis, membership.owner) || !same(selected.signer, identity)) {
      return { allowed: false, reason: 'First appoint this exact verified replacement in Membership recovery on this host. Each execution host requires its own local confirmation.' };
    }
    return { allowed: true, runtimeId, activationId: selected.activationId };
  }
  function renderOriginalDeviceRemoval(card, endpoint) {
    card.append(uiNode('p', 'small', 'Original team device. Its historical fingerprint remains the verifier of the first membership record after device removal. Previously received history cannot be erased.'));
    if (endpoint.state === 'revoked') {
      card.append(uiNode('p', 'small', 'Original device removed. Other hosts apply removal separately; any host still using this device needs its own local membership recovery. Approval rights and provider accounts are unchanged.'));
      return;
    }
    const availability = originalRemovalAvailability();
    const remove = uiButton('Remove original device', 'revoke-original-device', async () => {
      const teamId = state.teamId, runtimeId = availability.runtimeId, activationId = availability.activationId;
      const requireCurrent = () => {
        const current = originalRemovalAvailability();
        const target = state.encryptedState?.endpoints.find(value => value.userId === endpoint.userId && value.device === endpoint.device);
        if (state.teamId !== teamId || !current.allowed || current.runtimeId !== runtimeId || current.activationId !== activationId || !target?.isOriginal) {
          throw new Error(current.reason || 'The selected local appointment changed. Review the current host and original device before retrying.');
        }
        return target;
      };
      await refreshEncrypted(); requireCurrent();
      if (!confirm('Remove original device ' + endpoint.device + '? Its historical public fingerprint stays the team’s original verifier. Previously received history cannot be erased. Each host applies removal separately; hosts still using this device need local membership recovery. Approval rights and provider accounts do not transfer.')) return;
      await refreshEncrypted();
      await state.encrypted.revokeDevice(requireCurrent()); await refreshEncrypted();
      toast('Original device removal recorded. Check each host’s authenticated application status.');
    });
    remove.disabled = !availability.allowed; card.append(remove);
    card.append(uiNode('p', availability.allowed ? 'small' : 'cu-missing', availability.reason ||
      'This host has appointed your current replacement. Other hosts apply removal independently and may need their own local appointment. No approval rights or provider credentials transfer.'));
  }
  function renderAccessContent(root, projectId) {
    const section = uiSection('Shared work. Clear boundaries.', 'Team membership, verified devices, project history and approval rights are separate. Project access includes existing shared history and future tasks.');
    if (state.authorityNeeded) for (const authority of state.authorityEndpoints || []) {
      const owner = uiSection('Verify the team authority', 'Compare this complete fingerprint with the team owner before confirming the membership history.');
      owner.append(uiNode('p', 'ew-fingerprint mono', authority.fingerprint), uiButton('Confirm team owner fingerprint', 'confirm-team-authority', async () => {
        await state.encrypted.confirmAuthority(authority); await refreshEncrypted();
      })); section.append(owner);
    }
    section.append(uiNode('p', 'small', 'Your device: ' + (state.encryptedState?.device || 'starting') + ' · ' + (state.encryptedState?.state || 'unknown')));
    section.append(uiNode('p', 'ew-fingerprint mono', state.encryptedIdentity?.fingerprint || 'Fingerprint unavailable'));
    const membership = state.encryptedState?.membershipIdentity;
    if (membership?.recoveryEpoch && projectId && membership.state === 'verified' && membership.owner?.user === state.encryptedIdentity?.user &&
        !membership.grants.some(grant => grant.projectId === projectId && grant.userId === state.me.id && !grant.revoked)) {
      section.append(uiSection('Project access reset by owner recovery', 'History remains readable. Grant this account new project access before issuing any new task controls.'));
      section.append(uiButton('Grant this account project access', 'reclaim-recovery-project', async () => {
        await state.encrypted.reclaimProjectAccess(projectId); await refreshEncrypted();
      }, true));
    }
    for (const endpoint of state.encryptedState?.endpoints || []) {
      const card = uiNode('article', 'ew-device'); card.dataset.device = endpoint.device;
      card.append(uiNode('h4', null, (nameFor(endpoint.userId) || endpoint.userId) + ' · ' + endpoint.device), uiNode('p', 'small', endpoint.state), uiNode('p', 'ew-fingerprint mono', endpoint.fingerprint));
      if (['announced', 'pending'].includes(endpoint.state)) {
        card.append(uiNode('p', 'small', 'This device cannot control tasks or approve actions until it is verified. It has no verified device access to revoke.'));
      }
      if (['announced', 'pending'].includes(endpoint.state) && state.encryptedState.state === 'verified') {
        const agree = uiField('I compared this fingerprint with its owner', 'confirmed-fingerprint', { type: 'checkbox' });
        card.append(agree.wrap, uiButton('Verify device', 'verify-teammate', async () => {
          if (!agree.input.checked) throw new Error('Compare the complete fingerprint with this person before confirming.');
          await state.encrypted.confirmTeammate(endpoint); await refreshEncrypted();
        }));
      }
      if (endpoint.state === 'verified' && projectId && state.encryptedState.state === 'verified' && state.membership?.role === 'owner') {
        card.append(uiButton('Share project history and future tasks', 'grant-project', async () => {
          await state.encrypted.grantProject(projectId, { userId: endpoint.userId });
          toast('Project grant submitted. Key delivery requires the host to apply the grant.'); await refreshEncrypted();
        }));
      }
      if (endpoint.isOriginal) renderOriginalDeviceRemoval(card, endpoint);
      else if (endpoint.state === 'verified' && state.membership?.role === 'owner' && state.encryptedState?.membershipIdentity?.state === 'verified') card.append(uiButton('Remove device', 'revoke-device', async () => {
        if (!confirm('Remove ' + endpoint.device + '? Previously received history cannot be erased. Offline hosts remain pending until they acknowledge removal.')) return;
        await state.encrypted.revokeDevice(endpoint); await refreshEncrypted();
      }));
      section.append(card);
    }
    // Only this collection verifies signed receipts against confirmed host keys and
    // the persisted host roster. projectAccess contains untrusted relay summaries.
    const revocations = state.encryptedState?.revocations || [];
    for (const revocation of revocations) {
      const pending = revocation.pendingHosts || revocation.pending || [];
      section.append(uiNode('p', revocation.applied ? 'small' : 'ew-error', 'Removal of ' + revocation.device + ': ' +
        (revocation.applied === true ? 'applied by acknowledged hosts' : pending.length ? 'pending hosts ' + pending.join(', ') : 'pending authenticated host acknowledgements')));
      for (const [status, hosts] of [['applied', revocation.appliedBy || []], ['pending', pending]]) for (const runtimeId of hosts) {
        const local = state.localEncryptedSetup;
        const recoveryRequired = local?.runtimeId === runtimeId && local.teamId === state.teamId &&
          local.freshnessAuthority?.state === 'revoked' && local.freshnessAuthority.signer?.device === revocation.device;
        const name = state.runtimes.find(runtime => runtime.id === runtimeId)?.name || runtimeId;
        const row = uiNode('p', status === 'pending' || recoveryRequired ? 'ew-error' : 'small', name + ': ' +
          (status === 'pending' ? 'removal pending. Reconnect or update this host; it may need local membership recovery.'
            : recoveryRequired ? 'removal applied; local membership recovery required.' : 'removal applied.'));
        row.dataset.runtimeId = runtimeId; row.dataset.revocationDevice = revocation.device; row.dataset.hostState = status;
        section.append(row);
      }
    }
    section.append(uiNode('p', 'ew-explain', 'Removing a device excludes future content after the affected hosts apply the new state. It cannot erase plaintext or keys the device already received.'));
    root.append(section);
  }
  function renderAccess() {
    if (!state.accessOpen) return;
    const root = $('#access-view');
    if (root.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const signature = JSON.stringify([state.encryptedState, state.authorityNeeded, state.projectAccess, state.localEncryptedSetup,
      activeEncryptedTask()?.projectId, el.fleetProject.value, selectedRuntime()?.id, state.pilotSignature]);
    if (root.dataset.signature === signature) return;
    root.dataset.signature = signature; root.replaceChildren(); renderAccessContent(root, activeEncryptedTask()?.projectId || el.fleetProject.value || null);
    pilot.renderAccess(root, activeEncryptedTask()?.projectId || el.fleetProject.value || null);
  }
  async function openAccess() {
    hideWorkViews(); $('#encrypted-workspace').classList.add('hidden'); state.accessOpen = true;
    $('#access-view').classList.remove('hidden'); document.body.classList.remove('navigation-open'); renderAccess(); await refreshEncrypted();
  }
  function appendRecoveryRestore(view, backups) {
    const section = uiSection('Restore on this device', 'Use your customer-held key. Restored history does not restore execution approval rights. A new endpoint needs verification before it can control a task.');
    const key = uiField('Recovery key', 'restore-recovery-key', { type: 'password', value: state.recoveryRestoreDraft?.key || '' });
    section.append(key.wrap);
    if (backups.length) {
      const choose = uiField('Backup to restore', 'restore-backup', { value: state.recoveryRestoreDraft?.scope || '', options: backups.map(b => ({ id: b.scope || b.id, name: (b.scope || b.id) + ' · ' + new Date(b.updatedAt).toLocaleString() })) });
      section.append(choose.wrap, uiButton('Restore history', 'restore-history', async () => {
        const backup = backups.find(b => (b.scope || b.id) === choose.input.value);
        await state.encrypted.restoreFromRecovery({ scope: backup.scope || backup.id, ...(backup.taskIds ? { taskIds: backup.taskIds } : {}), recoveryKey: key.input.value });
        key.input.value = ''; await refreshEncrypted(); toast('History restored. Device verification and action approvals remain separate.');
      }));
    } else section.append(uiNode('p', 'cu-missing', 'No encrypted backup is available to this signed-in account.'));
    view.append(section);
  }
  let encryptedPoll = null, encryptedPolling = false;
  async function pollEncryptedWorkspace() {
    if (!state.encrypted || !state.connected || encryptedPolling) return;
    encryptedPolling = true;
    try {
      await refreshEncrypted();
      if (activeEncryptedTask()) await updateEncryptedTask();
    } catch (error) { pilot.failure('endpoint', error.code); state.catchupExplain = 'Connection unavailable. Last verified history is retained.'; renderEncryptedWorkspace(); }
    finally { encryptedPolling = false; }
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
    el.fleetRuntime.addEventListener('change', () => { renderProjects(); renderProviderPicker(); updateAddProjectAvailability(); renderEncryptedSetup(); renderThreadList(); rememberWorkspace(); });
    el.fleetProject.addEventListener('change', () => { renderThreadList(); rememberWorkspace(); });
    $('#btn-setup').addEventListener('click', () => openWorkspaceSetup());
    el.providerSelect.addEventListener('change', () => {
      pilot.clear('provider');
      const r = state.activeThread ? state.runtimes.find((x) => x.id === state.activeThread.runtimeId) : selectedRuntime();
      renderModelPicker((r && r.providers) || []);
      if (r && r.taskProtocol !== 'encrypted-v1' && el.providerSelect.value !== 'demo') command(null, { method: 'model/list', provider: el.providerSelect.value }, r.id).then((res) => { if (res.models && res.models.length) { const cur = el.modelSelect.value; el.modelSelect.innerHTML = ''; for (const m of res.models) { const o = document.createElement('option'); o.value = m; o.textContent = m; el.modelSelect.appendChild(o); } if (res.models.includes(cur)) el.modelSelect.value = cur; } }).catch(() => {});
    });
    el.addProject.addEventListener('click', async () => {
      const r = selectedRuntime(); if (!r) return;
      if (!window.harnessDesktop || !window.harnessDesktop.pickFolder || r.id !== state.localRuntimeId) {
        toast('⚠ Select this desktop’s local execution host to share a folder.');
        return;
      }
      try {
        const result = await window.harnessDesktop.pickFolder(r.id);
        if (result && result.changed) toast('Project registered on the local execution host.');
        else if (result && !result.canceled) toast('That project is already registered on the local execution host.');
      } catch (e) { toast('⚠ ' + esc(e.message)); }
    });
    document.querySelectorAll('.suggestion').forEach((b) => b.addEventListener('click', () => { el.input.value = b.dataset.prompt; autosize(); sendMessage(); }));
    el.send.addEventListener('click', sendMessage);
    el.input.addEventListener('input', () => { autosize(); if (!state.activeThreadId && el.input.value && !state.newTaskDraft) state.newTaskDraft = { runtimeId: selectedRuntime()?.id, projectId: el.fleetProject.value }; if (!el.input.value) state.newTaskDraft = null; if (el.input.value && !state.draftTarget && activeEncryptedTask()) state.draftTarget = { taskId: state.activeThreadId, turnId: encryptedTurnId() }; if (!el.input.value) state.draftTarget = null; });
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
      const u = state.users.find((x) => x.userId === el.assignUser.value); if (!u) return;
      try { await command(state.activeThreadId, { method: 'thread/assign', assignee: { userId: u.userId, name: u.name, color: u.color }, note: el.assignNote.value.trim() }); el.assignModal.classList.add('hidden'); toast('Handed off to <b>' + esc(u.name) + '</b>'); } catch (e) { toast('⚠ ' + esc(e.message)); }
    });
    el.unassign.addEventListener('click', async () => {
      try { await command(state.activeThreadId, { method: 'thread/assign', assignee: null }); el.assignModal.classList.add('hidden'); } catch (e) { toast('⚠ ' + esc(e.message)); }
    });
    el.auditBtn.addEventListener('click', async () => {
      const t = state.activeThread; if (!t) return;
      try {
        const r = await fetch('/api/threads/' + t.id + '/events?limit=500', { headers: { authorization: 'Bearer ' + state.me.token } });
        if (!r.ok) throw new Error((await r.json()).error || r.status);
        const j = await r.json();
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), thread: j.thread, events: j.events }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'audit-' + t.id + '.json'; document.body.appendChild(a); a.click(); a.remove();
        toast('<b>Audit log exported</b> — ' + j.events.length + ' events');
      } catch (e) { toast('⚠ ' + esc(e.message)); }
    });
    el.changesBtn.addEventListener('click', () => (state.diffOpen ? closeDiff() : openDiff()));
    el.catchupBtn.addEventListener('click', () => (state.catchupOpen ? closeCatchup() : openCatchup()));
    el.closeDiff.addEventListener('click', closeDiff);
    el.commitBtn.addEventListener('click', async () => {
      const msg = el.commitMsg.value.trim() || 'Changes from harness';
      try { const r = await command(state.activeThreadId, { method: 'git/commit', message: msg }); if (r.ok) { toast('<b>Committed</b> — ' + esc(msg)); el.commitMsg.value = ''; openDiff(); } else toast('⚠ ' + esc(r.error || 'commit failed')); } catch (e) { toast('⚠ ' + esc(e.message)); }
    });
    el.commitMsg.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.commitBtn.click(); });
    el.copyPatchBtn.addEventListener('click', async () => {
      try { const r = await command(state.activeThreadId, { method: 'git/patch' }); await navigator.clipboard.writeText(r.patch || ''); toast('<b>Patch copied</b> — ' + ((r.patch || '').length / 1024).toFixed(1) + ' KB'); } catch (e) { toast('⚠ ' + esc(e.message)); }
    });
    const gateFail = (e) => { el.gateError.textContent = String(e && e.message || e); el.gateError.classList.remove('hidden'); };
    el.createTeam.addEventListener('click', () => {
      const name = el.teamName.value.trim();
      if (!name) return gateFail(new Error('Give the team a name.'));
      el.gateError.classList.add('hidden');
      send({ type: 'team/create', name });
    });
    el.joinTeam.addEventListener('click', () => {
      const code = el.joinCode.value.trim();
      if (!code) return gateFail(new Error('Paste the invitation code you were sent.'));
      el.gateError.classList.add('hidden');
      send({ type: 'team/invite/accept', code });
    });
    el.inviteBtn.addEventListener('click', () => {
      const inviteeUserId = el.inviteeUserId.value.trim();
      if (!inviteeUserId) return toast(state.authMode === 'github' ? 'Enter your teammate’s verified GitHub email.' : 'Enter your teammate’s account ID.');
      send({ type: 'team/invite', teamId: state.teamId, ...(state.authMode === 'github' ? { inviteeEmail: inviteeUserId } : { inviteeUserId }) });
    });
    el.teamMembers.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action="remove-member"]');
      if (!button) return;
      const member = state.users.find((user) => user.userId === button.dataset.userId);
      if (!member || !confirm('Remove ' + member.name + ' from this team?')) return;
      send({ type: 'team/member/remove', teamId: state.teamId, userId: member.userId });
    });
    el.inviteCode.addEventListener('focus', () => el.inviteCode.select());
    el.pairBtn.addEventListener('click', () => {
      const code = el.pairCode.value.trim();
      if (!code) return toast('Enter the pairing code shown on that machine.');
      send({ type: 'runtime/pair', teamId: state.teamId, code });
      el.pairCode.value = '';
    });
    el.settingsBtn.addEventListener('click', () => {
      el.settingTheme.value = state.prefs.theme || 'dark'; el.settingNotifications.checked = state.prefs.notifications !== false;
      const hosted = state.authMode === 'github';
      el.settingsAccountId.value = (hosted ? state.me?.verifiedEmail : state.me?.id) || '';
      $('#settings-account-label').textContent = hosted ? 'Verified GitHub email' : 'Your account ID';
      $('#settings-account-help').textContent = hosted ? 'Team owners can invite you using this verified email.' : 'Share this ID with a team owner so invitations can be addressed to your account.';
      const team = state.teams.find((t) => t.id === state.teamId);
      el.settingsConn.textContent = HUB_URL + ' · ' + (team ? team.name + ' (' + (state.membership ? state.membership.role : 'member') + ')' : 'no team') + ' · ' + (state.me ? state.me.name : '');
      el.settingsModal.classList.remove('hidden');
    });
    el.copyGateAccountId.addEventListener('click', () => copyAccountId(el.teamGateAccountId));
    el.copyAccountId.addEventListener('click', () => copyAccountId(el.settingsAccountId, state.authMode === 'github' ? 'Email' : 'Account ID'));
    el.closeSettings.addEventListener('click', () => el.settingsModal.classList.add('hidden'));
    el.settingsModal.addEventListener('click', (e) => { if (e.target === el.settingsModal) el.settingsModal.classList.add('hidden'); });
    el.settingTheme.addEventListener('change', () => { state.prefs.theme = el.settingTheme.value; savePrefs(); applyTheme(); });
    el.settingNotifications.addEventListener('change', () => { state.prefs.notifications = el.settingNotifications.checked; savePrefs(); });
    const signOut = async () => {
      state.signingOut = true;
      try {
        if (state.authMode === 'github') {
          const response = window.harnessDesktop ? (await window.harnessDesktop.accountLogout(), { ok: true }) : await fetch('/api/auth/logout', { method: 'POST' });
          if (!response.ok) throw new Error('Could not sign out. Please try again.');
        }
        localStorage.removeItem('harness.session'); location.reload();
      } catch (error) { state.signingOut = false; toast(esc(error.message)); }
    };
    el.logout.addEventListener('click', signOut);
    $('#gate-logout').addEventListener('click', signOut);
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); showFleet(); }
      if (e.key === 'Escape') { el.settingsModal.classList.add('hidden'); el.assignModal.classList.add('hidden'); if (state.diffOpen) closeDiff(); }
    });
  }

  // ================= boot =================
  const pilot = window.PlexusPilot.create({ state, node: uiNode, button: uiButton, section: uiSection, field: uiField,
    runtime: selectedRuntime, projectId: () => el.fleetProject.value, refresh: refreshEncrypted, showFleet, openAccess, openRecovery });
  applyTheme();
  bind();
  $('#btn-access').addEventListener('click', () => openAccess().catch(showEncryptedError));
  $('#btn-navigation').addEventListener('click', () => document.body.classList.toggle('navigation-open'));
  encryptedPoll = setInterval(pollEncryptedWorkspace, 1800);
  window.addEventListener('beforeunload', () => clearInterval(encryptedPoll));
  el.loginHub.textContent = 'hub: ' + HUB_URL;
  const params = new URLSearchParams(location.search);
  // A handle on this page's own state, so automated checks can drive the real app instead of
  // a fixture of it. Hosted session cookies remain HttpOnly; this adds no authority.
  window.__plexus = {
    state, openCatchup, openInbox, openRecovery,
    refreshEncrypted: () => refreshEncrypted(), refreshRecovery: () => refreshRecovery()
  };
  el.inboxBtn.addEventListener('click', () => (state.inboxOpen ? closeInbox() : openInbox()));
  el.recoveryBtn.addEventListener('click', () => (state.recoveryOpen ? closeRecovery() : openRecovery()));

  function accountError(error) {
    const message = String(error?.message || '');
    const known = {
      os_key_protection_unavailable: 'Unlock your system keychain to sign in securely, then try again.',
      desktop_sign_in_expired: 'Desktop sign-in expired. Start again to get a new code.',
      hosted_account_unavailable: 'This desktop cannot connect to hosted accounts. Check the service address.',
      sign_in_busy: 'Sign-in is busy. Please try again shortly.',
      identity_provider_unavailable: 'GitHub is unavailable. Please try again shortly.'
    };
    for (const [code, text] of Object.entries(known)) if (message.includes(code)) return text;
    return 'Sign-in is unavailable. Check your connection and try again.';
  }
  async function bootAccount() {
    $('#retry-login').classList.add('hidden');
    el.loginHub.textContent = 'Checking sign-in…';
    try {
      const response = await fetch('/api/auth/config');
      if (!response.ok) throw new Error('Sign-in is unavailable. Check your connection and try again.');
      const config = await response.json();
      if (!['local', 'github'].includes(config.mode)) throw new Error('This service does not support secure sign-in.');
      state.authMode = config.mode;
      if (config.mode === 'github') {
        localStorage.removeItem('harness.session');
        el.loginForm.classList.add('hidden');
        el.inviteeUserId.placeholder = 'Teammate’s verified GitHub email';
        el.inviteeUserId.setAttribute('aria-label', 'Teammate’s verified GitHub email');
        $('#invite-help').textContent = 'Your teammate signs in with GitHub first. Use their verified email, then share the single-use invitation.';
        FRIENDLY.unknown_user = 'No unique signed-in account matches that verified email. Ask your teammate to sign in first and check their email.';
        $('#github-login').classList.remove('hidden');
        const desktopToken = window.harnessDesktop ? await window.harnessDesktop.accountSession() : null;
        const session = window.harnessDesktop ? { ok: !!desktopToken, status: desktopToken ? 200 : 401 } : await fetch('/api/auth/session');
        if (session.ok) {
          const deviceId = /^\/connect\/([A-Za-z0-9_-]{43})$/.exec(location.pathname)?.[1];
          if (deviceId) {
            $('#github-login').classList.add('hidden'); $('#desktop-consent').classList.remove('hidden');
            el.loginHub.textContent = 'Only continue if you started sign-in from your own desktop.';
          } else { el.loginHub.textContent = 'Opening your workspace…'; connect({ token: desktopToken }); }
        }
        else if (session.status === 401) el.loginHub.textContent = 'Invited early access. Your agent runs on your computer; teammates join here.';
        else throw new Error('Could not check your session. Please try again.');
      } else {
        el.loginForm.classList.remove('hidden');
        el.loginHub.textContent = 'Local development · ' + HUB_URL;
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem('harness.session') || 'null'); } catch {}
        if (saved?.token) connect({ token: saved.token });
        else if (params.get('name')) connect({ name: params.get('name') });
        else el.loginName.focus();
      }
    } catch (error) { el.loginHub.textContent = accountError(error); $('#retry-login').classList.remove('hidden'); }
  }
  $('#retry-login').addEventListener('click', bootAccount);
  $('#github-login').addEventListener('click', async () => {
    if (!window.harnessDesktop) return location.assign('/api/auth/login?returnTo=' + encodeURIComponent(location.pathname));
    $('#github-login').disabled = true;
    try {
      const { code } = await window.harnessDesktop.accountStart();
      el.loginHub.textContent = 'Enter this code in your browser: ' + code + '. Waiting for you to connect this desktop…';
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const token = await window.harnessDesktop.accountPoll();
        if (token) { connect({ token }); return; }
      }
      throw new Error('Sign-in expired. Please try again.');
    } catch (error) { el.loginHub.textContent = accountError(error); }
    finally { $('#github-login').disabled = false; }
  });
  $('#desktop-consent').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.target.querySelector('button'); button.disabled = true;
    try {
      const id = /^\/connect\/([A-Za-z0-9_-]{43})$/.exec(location.pathname)?.[1];
      const response = await fetch('/api/auth/desktop/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('#desktop-code').value.trim().toUpperCase() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error === 'desktop_code_mismatch' ? 'That code does not match. Check your desktop and try again.' : 'This sign-in expired or is no longer available. Start again from your desktop.');
      $('#desktop-consent').classList.add('hidden');
      el.loginHub.textContent = 'Desktop connected. Return to Plexus on your computer to continue setup.';
    } catch (error) { el.loginHub.textContent = error.message; button.disabled = false; }
  });
  bootAccount();
  // initial view
  el.composerHostHome.appendChild(el.composer);
  el.composer.classList.remove('hidden');
})();
