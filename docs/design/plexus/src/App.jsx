import { useEffect, useRef, useState } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ArrowRight, ArrowSquareOut, ArrowsClockwise, Bell, BookOpen, CaretDown, CaretRight, Check, CheckCircle, Circle, Clock, Code, Cube, FileCode, GearSix, GitBranch, Hand, Tray as Inbox, Link, List, Monitor, PaperPlaneTilt, Pause, Plus, ShieldCheck, SquaresFour, Users, X } from '@phosphor-icons/react';
import { Avatar, Button, Modal, SourceLink, Status } from './ui.jsx';
import { initialTasks, initialRequests, retryDiff, testDiff, sourceEvents } from './data.js';
import { WorkspaceScreen, InboxScreen, ApprovalScreen, SetupScreen, AccessScreen } from './management-screens.jsx';
import { TemplatesScreen } from './templates.jsx';

gsap.registerPlugin(useGSAP);
const screens = ['review', 'workspace', 'activity', 'catchup', 'inbox', 'approval', 'setup', 'access', 'templates'];
const titleByScreen = { workspace: 'Workspace', inbox: 'Your inbox', approval: 'Action approval', setup: 'Set up your workspace', access: 'Team & access', templates: 'Design templates' };
function readScreen() { const value = new URLSearchParams(window.location.search).get('screen'); return screens.includes(value) ? value : 'review'; }

export function App() {
  const [screen, setScreen] = useState(readScreen);
  const [tasks, setTasks] = useState(initialTasks);
  const [taskId, setTaskId] = useState('checkout');
  const [file, setFile] = useState('retry.ts');
  const [responsible, setResponsible] = useState('Alex');
  const [requests, setRequests] = useState(initialRequests);
  const [access, setAccess] = useState({ project: true, steering: true, delegated: true, role: 'Member', revocation: 'connected' });
  const accessRef = useRef(access); accessRef.current = access;
  const [approval, setApproval] = useState({ status: 'pending', actor: null });
  const [runtime, setRuntime] = useState({ host: 'connected', turnStatus: 'running', turn: 4 });
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const [instructions, setInstructions] = useState([]);
  const [draft, setDraft] = useState('');
  const [draftTurn, setDraftTurn] = useState(4);
  const [dialog, setDialog] = useState(null);
  const [source, setSource] = useState(null);
  const [toast, setToast] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [relatedLink, setRelatedLink] = useState('');
  const [handoffNote, setHandoffNote] = useState('');
  const [helpQuestion, setHelpQuestion] = useState('');
  const [newTask, setNewTask] = useState('');
  const [newObjective, setNewObjective] = useState('');
  const [newOwner, setNewOwner] = useState('Maya');
  const root = useRef(null);
  const timers = useRef([]);
  const task = tasks.find(item => item.id === taskId) || tasks[0];
  const isTaskScreen = ['review', 'activity', 'catchup'].includes(screen);
  const openRequests = requests.filter(item => item.status === 'open');
  useEffect(() => { const onPop = () => setScreen(readScreen()); window.addEventListener('popstate', onPop); return () => { window.removeEventListener('popstate', onPop); timers.current.forEach(clearTimeout); }; }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3600); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { document.title = `${titleByScreen[screen] || task.title} · Plexus`; }, [screen, task.title]);
  useGSAP(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    gsap.fromTo('.p-view > *', { y: 7 }, { y: 0, duration: 0.32, stagger: 0.035, ease: 'power2.out', clearProps: 'transform,opacity' });
  }, { scope: root, dependencies: [screen, taskId], revertOnUpdate: true });

  function navigate(next) { setScreen(next); const url = new URL(window.location.href); url.searchParams.set('screen', next); window.history.pushState({}, '', url); setMobileNav(false); setContextOpen(false); setScenarioOpen(false); }
  function openTask(id) { if (!access.project || access.revocation === 'revoked') { setToast('Project access is unavailable for this sample device. Restore access before joining.'); return; } setTaskId(id); navigate(id === 'checkout' ? 'review' : 'catchup'); }
  function showSource(key) { setSource(sourceEvents[key]); setDialog('source'); }
  function delay(callback, ms = 900) { timers.current.push(setTimeout(callback, ms)); }
  function resolveHelp(id) { setRequests(current => current.map(item => item.id === id ? { ...item, status: 'resolved' } : item)); setToast('Help request resolved. No instruction sent to Codex.'); }
  function sendInstruction(event) {
    event.preventDefault(); if (!draft.trim()) return;
    const id = Date.now(); const target = draftTurn;
    if (target !== runtime.turn) { setToast(`Turn ${target} has ended. Review your draft and select the current turn.`); return; }
    if (runtime.host !== 'connected' || runtime.turnStatus !== 'running' || !access.project || !access.steering || access.revocation === 'revoked') return;
    setInstructions(current => [...current, { id, text: draft.trim(), turn: target, status: 'Accepted by host' }]); setDraft('');
    delay(() => {
      const now = runtimeRef.current;
      const status = !accessRef.current.project || !accessRef.current.steering || accessRef.current.revocation === 'revoked' ? 'Rejected · access revoked' : now.host !== 'connected' ? 'Delivery unknown · host unavailable' : now.turn !== target ? 'Rejected · stale turn' : now.turnStatus !== 'running' ? 'Not delivered · turn interrupted' : 'Delivered to Codex';
      setInstructions(current => current.map(item => item.id === id ? { ...item, status } : item));
    });
  }
  function interrupt() {
    if (runtime.host !== 'connected' || !access.project || !access.steering || access.revocation === 'revoked') return;
    setRuntime(current => ({ ...current, turnStatus: 'interrupt-requested' }));
    delay(() => { if (runtimeRef.current.host === 'connected') setRuntime(current => ({ ...current, turnStatus: 'interrupted' })); }, 1000);
  }
  function changeHost(value) {
    setScenarioOpen(false);
    setRuntime(current => ({ ...current, host: value }));
    if (value === 'reconnecting') delay(() => { if (runtimeRef.current.host === 'reconnecting') { setInstructions(current => current.map(item => item.status.startsWith('Delivery unknown') || item.status === 'Accepted by host' ? { ...item, status: 'Not delivered · not replayed' } : item)); setRuntime(current => ({ ...current, host: 'connected', turnStatus: current.turnStatus === 'interrupt-requested' ? 'interrupted' : current.turnStatus })); } }, 1500);
  }
  function decideApproval(status) {
    if (approval.status !== 'pending' || runtime.turn !== 4 || runtime.host !== 'connected' || !access.project || !access.delegated || access.revocation === 'revoked') return;
    setApproval({ status, actor: 'Maya', decidedAt: 'Just now' }); setToast(`${status === 'approved' ? 'Action approved once' : 'Action declined'} by Maya. Sample decision recorded.`);
  }
  const hostText = runtime.host === 'connected' ? 'Connected' : runtime.host === 'reconnecting' ? 'Reconnecting' : 'Unavailable';
  const canControl = access.project && access.steering && access.revocation !== 'revoked';
  const canApprove = access.project && access.delegated && access.revocation !== 'revoked';
  const canSend = runtime.host === 'connected' && runtime.turnStatus === 'running' && taskId === 'checkout' && canControl;

  const composer = <form className="p-composer" onSubmit={sendInstruction}>
    <label htmlFor="agent-instruction">Suggest a correction to Codex…</label>
    <textarea id="agent-instruction" value={draft} onChange={event => { if (!draft) setDraftTurn(runtime.turn); setDraft(event.target.value); }} placeholder="Describe the change you want Codex to make." disabled={!canSend} />
    {draft && draftTurn !== runtime.turn && <button type="button" className="p-inline-warning" onClick={() => setDraftTurn(runtime.turn)}>Draft targets turn {draftTurn}. Use turn {runtime.turn} after reviewing.</button>}
    <div className="p-composer-footer"><span>To Codex <i>·</i> {draft ? `target turn ${draftTurn}` : `active turn ${runtime.turn}`}</span><Button variant="primary" type="submit" disabled={!draft.trim() || !canSend || draftTurn !== runtime.turn}>Send to agent <PaperPlaneTilt size={16} /></Button></div>
    {!canSend && <p className="p-composer-note">{!canControl ? 'Your current project or steering permissions do not allow agent control.' : taskId !== 'checkout' ? 'Agent controls are available in the Checkout recovery sample.' : runtime.host !== 'connected' ? 'Controls unlock after the host reconnects and reconciles.' : 'The turn is stopped. Start a follow-up to continue.'}</p>}
  </form>;

  return <main className="p-app overflow-x-hidden w-full max-w-full" ref={root}>
    <header className="p-topbar">
      <button className="p-icon-button p-mobile-toggle" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle navigation"><List size={22} /></button>
      <button className="p-brand" onClick={() => navigate('workspace')} aria-label="Plexus workspace"><img src="/assets/plexus-symbol.svg" alt="" /><span>plexus</span></button>
      <div className="p-breadcrumb"><button onClick={() => navigate('workspace')}>Storefront</button><span>/</span><strong>{isTaskScreen ? task.title : titleByScreen[screen]}</strong>{screen === 'review' && <Button variant="quiet" onClick={() => navigate('catchup')}>Open task</Button>}</div>
      <div className="p-top-people"><button className="p-host-menu" onClick={() => setScenarioOpen(!scenarioOpen)} aria-expanded={scenarioOpen} aria-label="Execution host and demo connection states"><Avatar name="Alex" /><span>Alex<small><Status tone={runtime.host === 'connected' ? 'success' : 'warning'}>{hostText}</Status></small></span><CaretDown size={15} /></button><span className="p-person"><Avatar name="Maya" />Maya</span></div>
      {scenarioOpen && <div className="p-scenario-menu"><strong>Execution host</strong><p>Alex’s Mac · sample connection</p><button onClick={() => changeHost('connected')}>Connected <Check size={14} /></button><button onClick={() => changeHost('unavailable')}>Simulate unavailable host</button><button onClick={() => changeHost('reconnecting')}>Reconnect and reconcile</button></div>}
    </header>
    {runtime.host !== 'connected' && <div className="p-connection-banner" role="status"><Monitor size={17} /><span>{runtime.host === 'reconnecting' ? 'Reconciling history and runtime state. Controls are temporarily unavailable.' : 'Alex’s Mac is unavailable. Execution status is unknown; already-started work may continue.'}</span>{runtime.host === 'unavailable' && <button onClick={() => changeHost('reconnecting')}>Reconnect <ArrowsClockwise size={14} /></button>}</div>}
    <div className={`p-shell ${runtime.host !== 'connected' ? 'p-shell-banner' : ''} ${!isTaskScreen ? 'p-shell-wide' : ''}`}>
      {mobileNav && <button className="p-nav-backdrop" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}
      <aside className={`p-sidebar ${mobileNav ? 'p-sidebar-open' : ''}`} aria-label="Workspace navigation">
        <div className="p-nav-tasks"><div className="p-sidebar-label"><button onClick={() => navigate('workspace')}>Tasks</button><div><button className="p-icon-button" aria-label="Open inbox" onClick={() => navigate('inbox')}><Inbox size={17} /></button><button className="p-icon-button" aria-label="New task" onClick={() => setDialog('newtask')}><Plus size={17} /></button></div></div>
          <nav aria-label="Tasks">{tasks.map(item => <button key={item.id} onClick={() => openTask(item.id)} aria-current={item.id === taskId && isTaskScreen ? 'page' : undefined} className={`p-task-link ${item.id === taskId && isTaskScreen ? 'is-active' : ''}`}><Circle size={7} weight="fill" /><span>{item.title}<small>{item.status} <i>·</i> {item.id === 'checkout' ? responsible : item.owner}</small></span></button>)}</nav>
        </div>
        {isTaskScreen && taskId === 'checkout' && <div className="p-nav-files"><p className="p-sidebar-label">Changed files <span>· 2</span></p>{['retry.ts', 'retry.test.ts'].map(name => <button key={name} className={`p-file-link ${file === name && screen === 'review' ? 'is-active' : ''}`} onClick={() => { setFile(name); navigate('review'); }}><FileCode size={18} /><span>{name === 'retry.ts' ? 'src/checkout/retry.ts' : name}</span><small>{name === 'retry.ts' ? '' : 'M'}</small></button>)}</div>}
        {!isTaskScreen && <nav className="p-section-nav" aria-label="Workspace views">{[['workspace','Overview',SquaresFour],['inbox','Inbox',Inbox],['approval','Approvals',ShieldCheck]].map(([id,label,Icon]) => <button key={id} className={screen === id ? 'is-active' : ''} onClick={() => navigate(id)}><Icon size={18} />{label}{id === 'inbox' && <span className="p-count">{openRequests.length}</span>}{id === 'approval' && approval.status === 'pending' && <span className="p-attention-dot" />}</button>)}</nav>}
        <div className="p-sidebar-bottom">
          {isTaskScreen && <div className="p-runtime-meta"><div><Users size={17} /><span>Responsible</span><strong>{taskId === 'checkout' ? responsible : task.owner}</strong></div><div><Monitor size={17} /><span>Execution host</span><strong>Alex’s Mac</strong></div><div><Circle size={17} /><span>Host status</span><Status tone={runtime.host === 'connected' ? 'success' : 'warning'}>{hostText}</Status></div><div><Cube size={17} /><span>Provider</span><strong>Codex · Alex’s account</strong></div></div>}
          {isTaskScreen && <button className="p-handoff-link" onClick={() => setDialog('handoff')}><Users size={20} /><span>Hand off responsibility<small>Execution stays on Alex’s Mac.</small></span><CaretRight size={15} /></button>}
          <nav className="p-utility-nav" aria-label="Product screens"><button onClick={() => navigate('setup')} className={screen === 'setup' ? 'is-active' : ''}><Monitor size={16} />Setup</button><button onClick={() => navigate('access')} className={screen === 'access' ? 'is-active' : ''}><GearSix size={16} />Access</button><button onClick={() => navigate('templates')} className={screen === 'templates' ? 'is-active' : ''}><SquaresFour size={16} />Templates</button></nav>
          <p className="p-demo-caption">Interactive prototype <span>·</span> Sample data</p>
        </div>
      </aside>
      {isTaskScreen ? <>
        <section className="p-work-area p-view" key={`${screen}-${taskId}`}>
          <div className="p-page-heading"><div><h1>{screen === 'review' ? 'Review the retry change' : screen === 'catchup' ? 'Pick up the context.' : 'Build in the same direction.'}</h1><p>{task.title}</p></div><button className="p-icon-button p-context-toggle" aria-label="Open collaboration panel" onClick={() => setContextOpen(true)}><Users size={21} /></button></div>
          <nav className="p-tabs" aria-label="Task views">{(taskId === 'checkout' ? [['review','Changes'],['activity','Activity'],['catchup','Catch-up']] : [['catchup','Catch-up']]).map(([id,label]) => <button key={id} className={screen === id ? 'is-active' : ''} onClick={() => navigate(id)} aria-current={screen === id ? 'page' : undefined}>{label}</button>)}<span className="p-tab-runtime">{taskId === 'checkout' ? `Turn ${runtime.turn}` : 'Not started'}</span></nav>
          {screen === 'review' ? <>
            <div className="p-direction"><Avatar /><div><div className="p-byline"><strong>Maya’s direction</strong><span>· Delivered to Codex · turn 4</span><time>10:35</time></div><p>Keep retries idempotent. Reuse the original payment key.</p></div></div>
            <div className="p-diff" aria-label={`Read-only changes to ${file}`}><div className="p-diff-header"><FileCode size={18} /><span>{file === 'retry.ts' ? 'src/checkout/retry.ts' : file}</span><span className="p-diff-total"><b>+{file === 'retry.ts' ? '2' : '8'}</b> <i>−{file === 'retry.ts' ? '1' : '0'}</i></span></div><div className="p-diff-scroll" tabIndex={0}>{(file === 'retry.ts' ? retryDiff : testDiff).map(([line,sign,text],index) => <div className={`p-code-line ${sign === '+' ? 'p-code-added' : sign === '-' ? 'p-code-removed' : ''}`} key={index}><span className="p-line-number">{line}</span><span className="p-line-sign">{sign}</span><code>{text}</code></div>)}</div></div>
            <div className="p-check-result"><div>Latest check <time>10:36</time></div><div><CheckCircle size={21} className="p-accent" /><span>Duplicate-charge test passed <i>· event 35</i></span><SourceLink onClick={() => showSource('test')}>View result</SourceLink></div></div>
            <button className="p-related" onClick={() => setDialog('related')}><Link size={20} /><span>Related work <i>·</i> {relatedLink ? 'Linked issue / PR' : 'Link an issue or PR'}</span><ArrowSquareOut size={15} /></button>
          </> : screen === 'catchup' ? <CatchUp task={task} responsible={responsible} onSource={showSource} onChanges={() => navigate('review')} onApproval={() => navigate('approval')} onAsk={() => setDialog('help')} onStart={() => { setTasks(current => current.map(item => item.id === taskId ? { ...item, status: 'In progress' } : item)); setToast('Sample task started on Alex’s Mac. Live agent execution is not connected.'); }} /> : <Activity instructions={instructions} runtime={runtime} canControl={canControl} onInterrupt={interrupt} onResume={() => { setRuntime(current => ({ ...current, turnStatus: 'running', turn: current.turn + 1 })); setToast('A new sample turn started. Previous turn history is preserved.'); }} onSource={showSource} handoffNote={handoffNote} responsible={responsible} />}
        </section>
        <aside className={`p-collaboration ${contextOpen ? 'p-collaboration-open' : ''}`} aria-label="Collaboration panel">
          <button className="p-icon-button p-close-context" aria-label="Close collaboration panel" onClick={() => setContextOpen(false)}><X size={20} /></button>
          <div className="p-collab-summary"><h2>Review together</h2><p>{taskId === 'checkout' ? 'Codex replaced fresh payment keys with the original key. Retry tests now cover timeouts.' : task.description}</p>{taskId === 'checkout' ? <span>Updated 20s ago <i>·</i> <SourceLink onClick={() => showSource('summary')}>Sources</SourceLink></span> : <span>New task · No agent events yet</span>}</div>
          <div className="p-collab-feed">{taskId === 'checkout' ? <><article className="p-message"><Avatar /><div><div className="p-byline"><strong>Maya</strong><time>10:35</time></div><p>Keep retries idempotent. Reuse the original payment key.</p><Status icon tone="success">Delivered to Codex <i>·</i> turn 4</Status></div></article>
          <article className="p-message"><Avatar name="Codex" agent /><div><div className="p-byline"><strong>Codex</strong><time>10:36</time></div><p>The retry now reuses the original key. I added a regression test.</p></div></article>
          {instructions.map(item => <article className="p-message p-new-message" key={item.id}><Avatar /><div><div className="p-byline"><strong>Maya</strong><time>Just now</time></div><p>{item.text}</p><Status icon tone={item.status === 'Delivered to Codex' ? 'success' : 'warning'}>{item.status} · turn {item.turn}</Status></div></article>)}
          <article className="p-message p-help-message"><Avatar name="Alex" /><div><div className="p-byline"><strong>Alex</strong><span>asked Maya</span><time>10:32</time></div><p>{requests[0].question}</p><Status icon tone={requests[0].status === 'open' ? 'warning' : 'success'}>Help request · {requests[0].status === 'open' ? 'Open' : 'Resolved by Maya'}</Status>{requests[0].status === 'open' && <Button onClick={() => resolveHelp(1)}>Resolve request</Button>}</div></article></> : <div className="p-no-activity"><Cube size={27} /><h3>Room for what comes next.</h3><p>Agent activity will appear here when this task runs. The prototype does not connect to a live provider.</p></div>}</div>
          {composer}
          <div className="p-collab-actions"><button onClick={() => setDialog('help')}><Users size={14} />Ask a teammate</button><button onClick={() => navigate('approval')}><ShieldCheck size={14} />Approval {approval.status === 'pending' ? '· 1' : '· resolved'}</button></div>
        </aside>
      </> : <section className="p-management-area p-view" key={screen}>
        {screen === 'workspace' && <WorkspaceScreen hostStatus={runtime.host} tasks={tasks.map(item => item.id === 'checkout' ? { ...item, owner: responsible } : item)} onOpenTask={openTask} onNewTask={() => setDialog('newtask')} />}
        {screen === 'inbox' && <InboxScreen requests={requests} onResolve={resolveHelp} onOpenTask={openTask} onAsk={() => setDialog('help')} />}
        {screen === 'approval' && <>{runtime.host !== 'connected' && <p className="p-inline-warning">The execution host must be connected to resolve this action.</p>}<ApprovalScreen hostStatus={runtime.host} approval={runtime.turn !== 4 && approval.status === 'pending' ? { ...approval, status: 'expired' } : approval} onDecide={decideApproval} disabled={runtime.host !== 'connected' || !canApprove || runtime.turn !== 4} /></>}
        {screen === 'setup' && <SetupScreen onToast={setToast} onStartSolo={() => { const id = `solo-${Date.now()}`; setTasks(current => [...current, { id, title: 'Explore Storefront', owner: 'Maya', description: 'Understand the checkout flow and identify a useful first improvement.', status: 'Planned', updated: 'Just now' }]); openTask(id); }} />}
        {screen === 'access' && <AccessScreen hostStatus={runtime.host} onToast={setToast} access={access} onAccessChange={setAccess} />}
        {screen === 'templates' && <TemplatesScreen onNavigate={navigate} />}
      </section>}
    </div>
    {toast && <div className="p-toast" role="status"><CheckCircle size={18} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={15} /></button></div>}
    {dialog === 'source' && source && <Modal title={source.title} onClose={() => setDialog(null)}><div className="p-source-meta"><Avatar name={source.actor} agent={source.actor === 'Codex'} /><span>{source.actor} · {source.time} · event {source.event}</span></div><blockquote>{source.text}</blockquote>{source.detail && <p>{source.detail}</p>}<p className="p-modal-note">Source preserved in this sample task history.</p></Modal>}
    {dialog === 'handoff' && <Modal title="Hand off responsibility" onClose={() => setDialog(null)}><form onSubmit={event => { event.preventDefault(); if (taskId === 'checkout') { setResponsible(newOwner); setHandoffNote(event.currentTarget.elements.note.value); } setTasks(current => current.map(item => item.id === taskId ? { ...item, owner: newOwner } : item)); setDialog(null); setToast(`Responsibility passed to ${newOwner}. Execution stays on Alex’s Mac.`); }}><p>Give a teammate the next move, with the context attached.</p><label className="p-field">Next responsible teammate<select value={newOwner} onChange={event => setNewOwner(event.target.value)}><option>Maya</option><option>Alex</option></select></label><label className="p-field">Handoff note<textarea name="note" required placeholder="What should they pick up next?" defaultValue="Please review the timeout case and verify that retries keep the original payment key." /></label><div className="p-info-row"><Monitor size={22} /><p>Execution stays on <strong>Alex’s Mac</strong>.<br />Workspace and Codex account ownership stay with Alex.</p></div><p className="p-modal-note">Only existing project members are available. This does not grant action-approval rights.</p><div className="p-form-actions"><Button type="button" onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary">Hand off responsibility <ArrowRight size={16} /></Button></div></form></Modal>}
    {dialog === 'help' && <Modal title="Ask a teammate" onClose={() => setDialog(null)}><form onSubmit={event => { event.preventDefault(); const recipient = event.currentTarget.elements.recipient.value; const question = helpQuestion.trim(); setRequests(current => [...current, { id: Date.now(), taskId, taskTitle: task.title, from: 'Maya', to: recipient, question, status: 'open' }]); setHelpQuestion(''); setDialog(null); setToast('Human help request created. No instruction was sent to Codex.'); }}><p>Send a question with a private link to this task.</p><label className="p-field">Teammate<select name="recipient"><option>Alex</option><option>Maya</option></select></label><label className="p-field">Your question<textarea required value={helpQuestion} onChange={event => setHelpQuestion(event.target.value)} placeholder="What would you like their help with?" /></label><div className="p-info-row"><Users size={21} /><p>This goes to a person’s inbox. It does not redirect the agent.</p></div><div className="p-form-actions"><Button type="button" onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={!helpQuestion.trim()}>Send help request <ArrowRight size={16} /></Button></div></form></Modal>}
    {dialog === 'newtask' && <Modal title="Make a start." onClose={() => setDialog(null)}><form onSubmit={event => { event.preventDefault(); const id = `task-${Date.now()}`; setTasks(current => [...current, { id, title: newTask.trim(), owner: 'Maya', description: newObjective.trim(), status: 'Planned', updated: 'Just now' }]); setNewTask(''); setNewObjective(''); setDialog(null); openTask(id); }}><p>Start with a clear objective. Bring teammates in whenever you’re ready.</p><label className="p-field">Task name<input required value={newTask} onChange={event => setNewTask(event.target.value)} placeholder="What are you building?" /></label><label className="p-field">Objective<textarea required value={newObjective} onChange={event => setNewObjective(event.target.value)} placeholder="Describe the outcome and any boundaries." /></label><div className="p-form-grid"><label className="p-field">Shared project<select><option>Storefront</option></select></label><label className="p-field">Execution host<select><option>Alex’s Mac</option></select></label></div><div className="p-info-row"><Cube size={21} /><p>Codex · Alex’s account<br /><span className="p-muted">Provider usage belongs to Alex. No teammate invite required.</span></p></div><div className="p-form-actions"><Button type="button" onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={!newTask.trim() || !newObjective.trim()}>Create task <ArrowRight size={16} /></Button></div></form></Modal>}
    {dialog === 'related' && <Modal title="Related work" onClose={() => setDialog(null)}><form onSubmit={event => { event.preventDefault(); setDialog(null); setToast('Association saved in this sample task. Nothing was posted to GitHub.'); }}><p>Keep an existing issue or pull request connected to the work.</p><label className="p-field">Issue or pull request URL<input type="url" required value={relatedLink} onChange={event => setRelatedLink(event.target.value)} /></label><p className="p-modal-note">Adding a link never publishes the task or posts a comment. Project membership and verified device access still apply.</p><div className="p-form-actions"><Button type="button" onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary">Save association</Button></div></form></Modal>}
  </main>;
}

function CatchUp({ task, responsible, onSource, onChanges, onApproval, onAsk, onStart }) {
  const planned = task.id !== 'checkout';
  return <div className="p-catchup"><div className="p-catchup-meta"><Avatar name={planned ? task.owner : responsible} size="small" /><span>{planned ? task.owner : responsible} · Responsible</span><span>Updated 20s ago</span>{!planned && <SourceLink onClick={() => onSource('summary')}>Sources</SourceLink>}</div><section><h2>The objective</h2><p>{task.description}</p>{!planned && <SourceLink onClick={() => onSource('objective')}>Original request</SourceLink>}</section><section><h2>{planned ? 'The next move' : 'Decided together'}</h2>{planned ? <><p>{task.status === 'Planned' ? 'This task is ready to begin on the shared Storefront project.' : 'This sample task has started on Alex’s Mac. A live agent is not connected in this prototype.'}</p>{task.status === 'Planned' ? <Button variant="primary" onClick={onStart}>Start sample task <ArrowRight size={16} /></Button> : <Status tone="success" icon>Sample task started</Status>}</> : <div className="p-recorded-decision"><CheckCircle size={23} /><div><strong>Reuse the original payment key</strong><p>Maya · Recorded decision · event 28</p></div><SourceLink onClick={() => onSource('decision')}>Source</SourceLink></div>}</section><section><h2>Current plan</h2>{(planned ? ['Clarify the expected behavior', 'Implement the change', 'Review the result together'] : ['Trace failed checkouts', 'Add an idempotent retry', 'Verify duplicate-charge protection']).map((text,i) => <div className="p-plan-row" key={text}>{!planned && i === 0 ? <CheckCircle size={19} /> : <Circle size={17} />}<span>{text}</span><small>{planned ? 'Planned' : i === 0 ? 'Complete' : i === 1 ? 'In progress' : 'Next'}</small></div>)}</section>{!planned && <section><h2>Recent changes</h2><button className="p-catchup-file" onClick={onChanges}><FileCode size={18} /><span>src/checkout/retry.ts</span><span className="p-accent">+2</span><CaretRight size={15} /></button><button className="p-catchup-file" onClick={onChanges}><FileCode size={18} /><span>retry.test.ts</span><span className="p-accent">+8</span><CaretRight size={15} /></button></section>}<section className="p-catchup-bottom"><div><h2>A human perspective helps.</h2><p>Bring the right person into the next decision.</p></div><Button onClick={onAsk}>Ask a teammate <Users size={16} /></Button></section>{!planned && <SourceLink onClick={onApproval}>Review pending action</SourceLink>}</div>;
}
function Activity({ instructions, runtime, canControl, onInterrupt, onResume, onSource, handoffNote, responsible }) {
  return <div className="p-activity"><div className="p-activity-state"><Status tone={runtime.turnStatus === 'running' ? 'success' : 'warning'}>{runtime.turnStatus === 'running' ? 'Codex is working' : runtime.turnStatus === 'interrupt-requested' ? 'Interruption requested · waiting for acknowledgment' : 'Turn interrupted'} · turn {runtime.turn}</Status>{runtime.turnStatus === 'running' ? <Button disabled={runtime.host !== 'connected' || !canControl} onClick={onInterrupt}><Pause size={15} />Interrupt</Button> : runtime.turnStatus === 'interrupted' ? <Button disabled={runtime.host !== 'connected' || !canControl} onClick={onResume}>Start follow-up <ArrowRight size={15} /></Button> : null}</div><p className="p-activity-note">Ordered contributions, with the result of every instruction.</p>{[{name:'Alex',time:'10:32',text:'Recover failed checkouts without charging a customer twice.',source:'objective'},{name:'Codex',time:'10:33',text:'I found the checkout handler. I’m tracing the failure path before adding a retry.'},{name:'Maya',time:'10:35',text:'Keep retries idempotent. Reuse the original payment key.',source:'decision',receipt:true},{name:'Codex',time:'10:36',text:'The retry now reuses the original key. I added a regression test.',source:'test'}].map((item,index)=><article className="p-activity-item" key={index}><Avatar name={item.name} agent={item.name === 'Codex'} /><div><div className="p-byline"><strong>{item.name}</strong><time>{item.time}</time></div><p>{item.text}</p>{item.receipt && <Status icon tone="success">Delivered to Codex · turn 4 · event 28</Status>}{item.source && <SourceLink onClick={() => onSource(item.source)}>Source event</SourceLink>}</div></article>)}{instructions.map(item=><article className="p-activity-item" key={item.id}><Avatar /><div><div className="p-byline"><strong>Maya</strong><time>Just now</time></div><p>{item.text}</p><Status icon tone={item.status === 'Delivered to Codex' ? 'success' : 'warning'}>{item.status} · turn {item.turn}</Status></div></article>)}{handoffNote && <div className="p-handoff-event"><Users size={20} /><div><strong>Responsibility passed to {responsible}</strong><p>{handoffNote}</p><small>Execution remains on Alex’s Mac.</small></div></div>}</div>;
}
