/* Shared browser/desktop setup, privacy and pilot operations. */
(function (global) {
  let active;
  const RETENTION = 'Task ciphertext and live indexes are deleted immediately. Service snapshots expire within 7 days and cannot restore old memberships or approvals. Recovery archives containing this history, and unindexed legacy archives for affected participants, are removed as whole archives; prepare new archives for retained work. Offline hosts apply deletion on reconnect. Participant-held plaintext, keys, downloaded kits and copies remain outside remote deletion.';
  const LABELS = { account: 'Plexus account', endpoint: 'Verify this device', project: 'Pair a host and share a project', provider: 'Provider readiness', solo: 'First solo task', invite: 'Invite a teammate', recovery: 'Check customer recovery' };
  function create({ state, node, button, section, field, runtime, projectId, refresh, showFleet, openAccess, openRecovery }) {
    let diagnostic, measurement, consent = { enabled: false }, seats = [], summary, account, failure, ready;
    const sent = new Set(), attempts = new Set();
    const modules = Promise.all([import('/shared/product/diagnostics.mjs'), import('/shared/product/measurement.mjs')]).then(([d,m]) => { diagnostic = d; measurement = m; });
    const api = async (route, body) => {
      const response = await fetch('/api/pilot/' + route + (route === 'consent' ? '' : '?team=' + encodeURIComponent(state.teamId)), {
        method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + state.me.token, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error || 'pilot_request_refused'), { code: value.error });
      return value;
    };
    async function emit(kind, source, task = null, extra = {}) {
      if (!consent.enabled || !state.me || !state.teamId) return;
      const userId = state.me.id, teamId = state.teamId;
      const event = await measurement.measurementEvent({ kind, source, userId, teamId, taskId: task?.id || null, ...extra });
      if (!measurement.validMeasurement(event) || event.at < consent.since || sent.has(event.id) || attempts.has(event.id)) return;
      attempts.add(event.id);
      try { await api('measurement', event); if (state.me?.id === userId && state.teamId === teamId) sent.add(event.id); }
      catch {} finally { attempts.delete(event.id); }
    }
    function facts() {
      const host = runtime(), provider = host?.providers?.find(p => p.id === document.querySelector('#provider-select')?.value);
      const snapshots = [...state.encryptedSnapshots.values()];
      const lastTurn = snapshots.filter(snapshot => snapshot.provider === provider?.id).flatMap(snapshot => snapshot.events || [])
        .filter(event => event.type === 'turn.completed').sort((a, b) => (b.payload.occurredAt || 0) - (a.payload.occurredAt || 0))[0]?.payload;
      const providerFailed = lastTurn?.status === 'failed';
      return { account: !!state.me, verified: state.encryptedState?.membershipIdentity?.state === 'verified',
        enrollmentError: !!state.encryptedError, host: !!host?.online, project: !!(host?.online && projectId() && state.encrypted?.confirmedHost(host.id)),
        provider: !!(provider?.configured && !provider?.disabled && !providerFailed), providerCode: providerFailed ? diagnostic.safeCode(lastTurn.error) : provider && !provider.configured ? diagnostic.safeCode(provider.reason) : !provider ? 'provider_missing' : null,
        solo: snapshots.some(snapshot => snapshot.events?.some(event => event.type === 'turn.started' && event.payload.actor === state.me?.id) && snapshot.events.some(event => event.type === 'turn.completed' && event.payload.status === 'completed')),
        invited: state.users.some(user => user.userId !== state.me?.id) || !!state.pilotInvited,
        recovery: !!state.encryptedState?.membershipIdentity?.recoveryDescriptor,
        recoveryError: failure?.stage === 'recovery' };
    }
    function stages() {
      const rows = diagnostic.onboarding(facts());
      if (failure?.stage === 'provider' && [...state.encryptedSnapshots.values()].some(snapshot => snapshot.events?.some(event => event.type === 'turn.completed' && event.payload.status === 'completed' && event.payload.occurredAt > failure.at))) failure = null;
      if (failure) { const row = rows.find(row => row.stage === failure.stage); if (row) Object.assign(row, { status: 'failed', code: failure.code }); }
      return rows;
    }
    function dialog(title, description) {
      const box = node('dialog', 'pilot-dialog'); box.dataset.template = 'decision';
      const heading = node('h2', null, title); heading.id = 'pilot-dialog-heading'; box.setAttribute('aria-labelledby', heading.id);
      box.append(heading, node('p', 'ew-explain', description));
      const close = button('Cancel', 'close-pilot-dialog', () => box.close());
      box.append(close); box.addEventListener('close', () => box.remove()); document.body.append(box); box.showModal();
      return box;
    }
    async function preview() {
      const versions = global.harnessDesktop?.diagnostics ? (await global.harnessDesktop.diagnostics()).versions : {};
      const exported = diagnostic.diagnosticExport({ client: global.harnessDesktop ? 'desktop' : 'browser',
        versions, stages: stages() });
      const box = dialog('Inspect your diagnostic export', 'Only this report will be downloaded. Review it before choosing to share it yourself. Plexus does not send diagnostics automatically.');
      box.querySelector('button').textContent = 'Close';
      const text = JSON.stringify(exported, null, 2); box.append(node('pre', 'pilot-export', text));
      box.append(button('Download reviewed report', 'download-diagnostics', () => {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = node('a'); link.href = url; link.download = 'plexus-diagnostics.json'; link.click(); URL.revokeObjectURL(url);
      }, true));
    }
    function renderSetup() {
      const root = document.querySelector('#pilot-setup'); if (!root || !diagnostic) return;
      const rows = stages(), signature = JSON.stringify([rows, consent.enabled, ready]);
      if (root.dataset.signature === signature) return;
      root.dataset.signature = signature; root.replaceChildren(); root.dataset.template = 'shell setup';
      const panel = section('Make room for a teammate.', 'Complete setup on your execution host, then bring a teammate into the work.');
      const layout = node('div', 'pilot-setup-grid'), list = node('ol', 'pilot-checklist');
      for (const row of rows) {
        const item = node('li'); item.dataset.stage = row.stage; item.dataset.state = row.status;
        item.append(node('span', 'pilot-stage-name', LABELS[row.stage]), node('span', 'pilot-stage-status', row.status));
        if (row.code) item.append(node('p', 'small', diagnostic.DIAGNOSTIC_CODES[row.code]));
        list.append(item);
      }
      const support = node('div', 'pilot-support');
      support.append(node('h3', null, 'Your work stays private.'), node('p', 'small', diagnostic.PRIVACY_NOTICE), node('p', 'small', diagnostic.RECOVERY_NOTICE),
        button('Inspect diagnostic export', 'preview-diagnostics', preview),
        button('Team & access', 'setup-access', openAccess), button('Recovery options', 'setup-recovery', openRecovery));
      const privacy = section('Optional product measurement', measurement.MEASUREMENT_NOTICE);
      const enabled = field('Allow content-free product measurement', 'measurement-consent', { type: 'checkbox' }); enabled.input.checked = !!consent.enabled;
      enabled.input.disabled = !ready;
      enabled.input.addEventListener('change', async () => {
        enabled.input.disabled = true;
        try { consent = await api('consent', { enabled: enabled.input.checked }); sent.clear(); renderSetup(); }
        catch { enabled.input.checked = !!consent.enabled; }
        finally { enabled.input.disabled = false; }
      });
      privacy.append(enabled.wrap, node('p', 'small', consent.enabled ? 'Enabled for your account. Only your qualifying activity is reported.' : 'Off. No product measurement is sent for your account.'));
      support.append(privacy); layout.append(list, support); panel.append(layout); root.append(panel);
    }
    function renderAccess(root, project) {
      if (!diagnostic) return;
      const panel = section('Product seats', 'Individual Plexus seats pay for collaboration. Your provider usage is billed separately by your provider. A seat record does not grant team membership, project history, decryption keys or action approvals.');
      panel.dataset.pilotSeats = 'true';
      for (const seat of seats) {
        const row = node('div', 'pilot-seat-row'); row.dataset.userId = seat.userId;
        row.append(node('span', null, state.users.find(user => user.userId === seat.userId)?.name || 'Your seat'),
          node('span', 'small', 'Seat: ' + seat.status), node('span', 'small', 'Payment: ' + seat.payment),
          node('span', 'small', seat.price === null || seat.price === undefined ? 'Price not recorded' : seat.currency + ' ' + seat.price));
        if (seat.billingOwnerId) row.append(node('span', 'small', 'Billing owner: ' + (state.users.find(user => user.userId === seat.billingOwnerId)?.name || seat.billingOwnerId)));
        panel.append(row);
      }
      if (!seats.length) panel.append(node('p', 'small', ready ? 'No seat record has been entered.' : 'Seat records are unavailable. Retry when connected.'));
      panel.append(node('p', 'small', 'Founders record pilot seats manually. Free pilots, verbal intent and unpaid invoices do not count as paid teams.'));
      if (summary) panel.append(node('p', 'small', 'Consented activity in the last ' + summary.windowDays + ' days: ' + summary.activatedPeople + ' activated people · ' + summary.qualifyingTasks + ' qualifying tasks · Returning team: ' + (summary.returningTeam ? 'yes' : 'not yet')));
      root.append(panel);
      const deletion = section('Deletion and project offboarding', RETENTION); deletion.dataset.pilotDeletion = 'true';
      if (mayDelete() && project) deletion.append(button('Delete shared project', 'delete-project', () => confirmDeletion(null, project)));
      for (const entry of state.encryptedState?.deletions || []) {
        const pending = entry.pendingHosts.length;
        const row = node('p', pending ? 'ew-error' : 'small', (entry.action === 'project.delete' ? 'Project' : 'Task') + ' deleted from the service. ' +
          (pending ? 'Host application pending: ' + entry.pendingHosts.map(id => state.runtimes.find(host => host.id === id)?.name || id).join(', ') : 'Applied by the verified hosts.'));
        row.dataset.deletionSeq = entry.seq; row.dataset.state = pending ? 'pending' : 'applied'; deletion.append(row);
      }
      root.append(deletion);
    }
    function mayDelete() { const membership = state.encryptedState?.membershipIdentity; return membership?.state === 'verified' && membership.owner?.user === state.encryptedIdentity?.user; }
    function confirmDeletion(task, project) {
      const box = dialog(task ? 'Delete this shared task?' : 'Delete this shared project?', RETENTION);
      const identity = task ? state.encryptedTitles.get(task.id) || 'Selected task' : 'Selected shared project';
      box.append(node('p', null, identity), node('p', 'small', 'Only the verified team owner can delete shared records. Files in the execution host’s project folder are retained.'));
      const agree = field('I understand deletion and the recovery archive consequences', 'confirm-deletion', { type: 'checkbox' }); box.append(agree.wrap);
      const action = button(task ? 'Delete task' : 'Delete project', 'confirm-delete', async () => {
        if (!agree.input.checked) return;
        if (task) await state.encrypted.enrolment.deleteTask(state.teamId, task);
        else {
          const tasks = (await state.encrypted.list()).filter(task => task.projectId === project).map(task => ({ id: task.id, runtimeId: task.runtimeId }));
          await state.encrypted.enrolment.deleteProject(state.teamId, project, tasks);
        }
        box.close(); await refresh(); showFleet(); await openAccess();
      }, true);
      action.disabled = true; agree.input.addEventListener('change', () => { action.disabled = !agree.input.checked; }); box.append(action);
    }
    function taskActions(root, task) { if (mayDelete()) root.append(button('Delete shared task', 'delete-task', () => confirmDeletion(task, task.projectId))); }
    async function poll() {
      await modules;
      if (!state.me || !state.teamId) return;
      const context = state.me.id + '/' + state.teamId;
      if (account !== context) { account = context; consent = { enabled: false }; seats = []; summary = null; sent.clear(); }
      try {
        const values = await Promise.all([api('consent'), api('seats'), state.membership?.role === 'owner' ? api('summary') : Promise.resolve(null)]);
        if (context !== state.me?.id + '/' + state.teamId) return;
        [consent, { seats }, summary] = values; ready = true;
        state.pilotSignature = JSON.stringify([seats, summary]);
      } catch { ready = false; }
      renderSetup();
      for (const row of stages()) await emit('setup', row.stage + ':' + row.status, null, { stage: row.stage, outcome: row.status });
    }
    async function observe(userId, teamId, task, snapshot) {
      await modules;
      if (userId !== state.me?.id || teamId !== state.teamId || !consent.enabled) return;
      for (const outcome of measurement.observedOutcomes(snapshot, { userId, creatorUserId: task.creatorUserId })) {
        if (Number.isSafeInteger(outcome.at)) await emit(outcome.kind, outcome.source, task, { at: outcome.at, outcome: outcome.outcome || null });
      }
    }
    return { poll, renderSetup, renderAccess, taskActions, observe,
      failure(stage, code) { if (diagnostic) {
        const safe = diagnostic.safeCode(code);
        failure = { stage, at: Date.now(), code: safe === 'setup_failed' ? ({ endpoint: 'enrollment_failed', recovery: 'recovery_failed', provider: 'provider_unavailable' }[stage] || safe) : safe }; renderSetup();
      } },
      clear(stage) { if (failure?.stage === stage) { failure = null; renderSetup(); } },
      invite(id) { state.pilotInvited = true; renderSetup(); return emit('invite', id); },
      catchup(task) { return emit('catchup', Math.floor(Date.now() / 86400000), task); } };
  }
  global.PlexusPilot = { create(options) { active = create(options); return active; },
    observeVerified(...args) { return active?.observe(...args); } };
})(window);
