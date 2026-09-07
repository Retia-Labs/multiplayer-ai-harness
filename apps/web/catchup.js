// The catch-up screen: template `evidence` inside the shared `shell`.
//
// This renders a projection and nothing else. It performs no reduction of its own, invents
// no text, and never upgrades a derived claim into a recorded one on the way to the screen -
// the projection decided that, and this file's job is to make the difference visible rather
// than tidy it away.
//
// Slots, in the order the accepted capture puts them:
//   scope    - task, covered range, freshness
//   summary  - objective, decided together
//   records  - current plan, recent changes, activity
//   detail   - each source opens the event behind the claim
//   followup - inspect the change, open the review
(function (global) {
  'use strict';

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  // Freshness is a control-adjacent cue, so it never relies on colour alone: every state
  // carries its own word and its own explanation.
  const FRESHNESS = {
    current: { label: 'Up to date', tone: 'ok' },
    stale: { label: 'Quiet', tone: 'warn' },
    unknown: { label: 'Unknown', tone: 'warn' },
    behind: { label: 'Catching up', tone: 'warn' },
    replaying: { label: 'Reading', tone: 'warn' },
    error: { label: 'Failed', tone: 'bad' }
  };

  // A claim that came from somewhere gets a way back to it; a claim that did not gets said
  // so in words, not implied by a missing link.
  function provenanceRow(field, onOpenSource) {
    const row = el('div', 'cu-prov');
    if (!field) return row;
    if (field.provenance === 'recorded' && field.source) {
      row.appendChild(el('span', 'cu-tag cu-tag-recorded', 'Recorded'));
      const link = el('button', 'cu-source', 'Source');
      link.type = 'button';
      link.title = 'Open event ' + field.source.seq;
      link.addEventListener('click', () => onOpenSource && onOpenSource(field.source));
      row.appendChild(link);
      row.appendChild(el('span', 'cu-evt', 'event ' + field.source.seq));
    } else if (field.provenance === 'derived') {
      row.appendChild(el('span', 'cu-tag cu-tag-derived', 'Read from the log'));
      for (const source of field.sources || []) {
        const link = el('button', 'cu-source', 'event ' + source.seq);
        link.type = 'button';
        link.addEventListener('click', () => onOpenSource && onOpenSource(source));
        row.appendChild(link);
      }
    } else if (field.provenance === 'context') {
      row.appendChild(el('span', 'cu-tag cu-tag-context', 'From this workspace'));
    }
    return row;
  }

  function section(title, body, note) {
    const wrap = el('section', 'cu-section');
    wrap.appendChild(el('h3', 'cu-h', title));
    if (note) wrap.appendChild(el('p', 'cu-note', note));
    if (body) wrap.appendChild(body);
    return wrap;
  }

  // An unavailable slot stays on screen saying why. Hiding it would let a reader assume the
  // task simply has no plan, rather than that nothing recorded one.
  const missing = (field) => el('p', 'cu-missing', field && field.reason ? field.reason : 'Nothing recorded.');

  function renderCatchup(projection, root, handlers = {}) {
    const onOpenSource = handlers.onOpenSource;
    root.textContent = '';
    root.setAttribute('data-template', 'evidence');
    root.setAttribute('data-freshness', projection.freshness.state);

    // --- scope ---
    const scope = el('div', 'cu-scope');
    const head = el('div', 'cu-scope-head');
    head.appendChild(el('h2', 'cu-title', 'Pick up the context.'));
    head.appendChild(el('p', 'cu-sub', projection.scope.title || 'Untitled task'));
    scope.appendChild(head);

    const meta = el('div', 'cu-meta');
    const fresh = FRESHNESS[projection.freshness.state] || FRESHNESS.error;
    const badge = el('span', 'cu-fresh cu-fresh-' + fresh.tone, fresh.label);
    badge.title = projection.freshness.explain;
    meta.appendChild(badge);
    meta.appendChild(el('span', 'cu-range',
      projection.scope.events ? 'events ' + projection.scope.from + '–' + projection.scope.through : 'no events yet'));
    for (const [label, field] of [['Responsible', projection.responsible], ['Execution host', projection.host], ['Provider', projection.provider]]) {
      const item = el('span', 'cu-fact');
      item.appendChild(el('span', 'cu-fact-k', label));
      item.appendChild(el('span', field.value ? 'cu-fact-v' : 'cu-fact-v cu-fact-unknown', field.value || 'Unknown'));
      if (!field.value) item.title = field.reason;
      meta.appendChild(item);
    }
    const outcome = projection.outcome || {};
    const status = el('span', 'cu-fact');
    status.appendChild(el('span', 'cu-fact-k', 'Status'));
    status.appendChild(el('span', 'cu-fact-v', String(outcome.value || 'unknown').replace(/-/g, ' ')));
    status.appendChild(el('span', outcome.provenance === 'recorded' ? 'cu-tag cu-tag-recorded' : 'cu-tag cu-tag-derived',
      outcome.provenance === 'recorded' ? 'Recorded' : 'Read from the log'));
    meta.appendChild(status);
    scope.appendChild(meta);
    scope.appendChild(el('p', 'cu-explain', projection.freshness.explain));
    root.appendChild(scope);

    // --- summary: objective ---
    const objective = el('div');
    if (projection.objective.value) {
      objective.appendChild(el('p', 'cu-objective', projection.objective.value));
      objective.appendChild(provenanceRow(projection.objective, onOpenSource));
    } else objective.appendChild(missing(projection.objective));
    root.appendChild(section('The objective', objective));

    // --- summary: decisions ---
    const decisions = el('div', 'cu-cards');
    if (projection.decisions.length) {
      for (const decision of projection.decisions) {
        const card = el('div', 'cu-card');
        card.appendChild(el('p', 'cu-card-text', decision.value));
        const by = el('p', 'cu-card-by');
        by.appendChild(el('span', null, decision.actor));
        by.appendChild(el('span', 'cu-dot', '·'));
        by.appendChild(el('span', null, 'Recorded decision'));
        card.appendChild(by);
        card.appendChild(provenanceRow(decision, onOpenSource));
        decisions.appendChild(card);
      }
    } else {
      decisions.appendChild(el('p', 'cu-missing',
        'No decision has been recorded on this task. Messages in the transcript are not decisions, and nothing here will treat them as one.'));
    }
    root.appendChild(section('Decided together', decisions));

    // --- records: plan ---
    const plan = el('div');
    if (Array.isArray(projection.plan.value)) {
      const list = el('ul', 'cu-plan');
      for (const step of projection.plan.value) {
        const item = el('li', 'cu-step cu-step-' + String(step.status || 'unknown').replace(/[^a-z-]/gi, ''));
        item.appendChild(el('span', 'cu-step-text', step.text));
        // 'in-progress' is a protocol value; the screen reads it aloud as English.
        item.appendChild(el('span', 'cu-step-status', String(step.status || '').replace(/-/g, ' ')));
        list.appendChild(item);
      }
      plan.appendChild(list);
      plan.appendChild(provenanceRow(projection.plan, onOpenSource));
    } else plan.appendChild(missing(projection.plan));
    root.appendChild(section('Current plan', plan));

    // --- records: changes ---
    const changes = el('div');
    if (Array.isArray(projection.changes.value) && projection.changes.value.length) {
      const list = el('ul', 'cu-files');
      for (const file of projection.changes.value) {
        const item = el('li', 'cu-file');
        item.appendChild(el('span', 'cu-file-path mono', file.path));
        list.appendChild(item);
      }
      changes.appendChild(list);
      changes.appendChild(provenanceRow(projection.changes, onOpenSource));
    } else changes.appendChild(missing(projection.changes));
    root.appendChild(section('Recent changes', changes));

    // --- records: what the host reported doing ---
    const activity = el('div');
    if (projection.activity && projection.activity.length) {
      const list = el('ul', 'cu-files');
      for (const entry of projection.activity) {
        const item = el('li', 'cu-activity');
        item.appendChild(el('span', 'cu-activity-text', entry.value));
        item.appendChild(provenanceRow(entry, onOpenSource));
        list.appendChild(item);
      }
      activity.appendChild(list);
    } else activity.appendChild(el('p', 'cu-missing', 'The host has recorded no activity on this task.'));
    root.appendChild(section('What happened', activity));

    // --- records: what is outstanding ---
    const pending = el('div');
    const blocker = projection.pending.blocker;
    if (blocker.value) {
      pending.appendChild(el('p', 'cu-blocker', blocker.value));
      pending.appendChild(provenanceRow(blocker, onOpenSource));
    } else pending.appendChild(missing(blocker));
    pending.appendChild(el('p', 'cu-missing', projection.pending.approvals.reason || 'No approvals are pending.'));
    root.appendChild(section('Waiting on', pending));

    // --- followup ---
    if (handlers.onOpenTranscript || handlers.onOpenChanges) {
      const actions = el('div', 'cu-actions');
      if (handlers.onOpenTranscript) {
        const b = el('button', 'mini-btn', 'Read the transcript');
        b.type = 'button';
        b.addEventListener('click', handlers.onOpenTranscript);
        actions.appendChild(b);
      }
      if (handlers.onOpenChanges) {
        const b = el('button', 'mini-btn', 'Inspect the changes');
        b.type = 'button';
        b.addEventListener('click', handlers.onOpenChanges);
        actions.appendChild(b);
      }
      root.appendChild(actions);
    }
    return root;
  }

  // Rendering one source the reader asked to open. An unresolvable reference is shown as
  // unavailable rather than as an empty panel, because "the record is gone" is the finding.
  function renderSource(opened, root) {
    root.textContent = '';
    if (!opened || !opened.available) {
      root.appendChild(el('p', 'cu-missing', 'That record is not available on this endpoint.'));
      root.setAttribute('data-source', 'unavailable');
      return root;
    }
    root.setAttribute('data-source', 'open');
    root.appendChild(el('p', 'cu-src-head', 'Event ' + opened.source.seq + ' · ' + opened.event.type));
    root.appendChild(el('pre', 'cu-src-body mono', JSON.stringify(opened.event.payload, null, 2)));
    return root;
  }

  // Mirrors openSource() in packages/e2ee/catchup.mjs. The browser build does not load that
  // module, so the rule lives in both places and the view test asserts they still agree.
  function resolveSource(snapshot, source) {
    const events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : [];
    const event = events[(source && source.seq) - 1];
    if (!event || event.type !== source.type) return { available: false, reason: 'source_unavailable', source };
    return { available: true, source, event };
  }

  global.PlexusCatchup = { renderCatchup, renderSource, resolveSource, FRESHNESS };
})(typeof window !== 'undefined' ? window : globalThis);
