import { VERSION, TASK_ID, PROJECT_ID, EVENT_ID, canonical, exact, integer, validRecord, roomFor, digest } from '../protocol/encrypted-task.mjs';
export const newId=(prefix)=>prefix+'_'+Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),(v)=>v.toString(16).padStart(2,'0')).join('');
const routeKeys=['version','id','teamId','runtimeId','projectId','creatorUserId'];
export const routing=(task)=>Object.fromEntries(routeKeys.map((key)=>[key,task[key]]));
export class TaskReplayError extends Error { constructor(code) {super(code);this.code=code;} }
const fail=(code)=>{throw new TaskReplayError(code);};
function eventValid(e) {
  if(!exact(e,['type','payload']) || !e.payload || typeof e.payload!=='object' || Array.isArray(e.payload)) return false;
  const p=e.payload;
  switch(e.type) {
    // The provider is optional and is asserted by the host, which is the party that knows:
    // a creator picks one and a host runs one, and the host writes this event.
    case 'task.created':return typeof p.title==='string' && typeof p.objective==='string' &&
      (p.provider===undefined||typeof p.provider==='string');
    case 'message.added':return typeof p.text==='string' && typeof p.id==='string';
    case 'plan.updated':return Array.isArray(p.steps);
    case 'tool.completed':return typeof p.id==='string' && typeof p.name==='string' && Object.hasOwn(p,'arguments') && Object.hasOwn(p,'result');
    case 'diff.updated':return Array.isArray(p.files);
    case 'activity.recorded':return typeof p.description==='string' && Array.isArray(p.paths);
    // A decision is only a decision when someone records it as one. Without this the
    // catch-up view could only infer decisions from messages, which is exactly what #9
    // forbids: never attribute a decision or an approval to a person who did not make one.
    case 'decision.recorded':return typeof p.text==='string' && typeof p.actor==='string' && (p.basis===undefined||typeof p.basis==='string');
    // An approval request is the one pending thing a task log can carry. Without it #9's
    // catch-up view can say what was decided but never that the task is stopped waiting for
    // somebody - and "blocked on you" is the single most useful thing a teammate arriving
    // at an unfamiliar task can be told. Resolution is not a second event type: a
    // decision.recorded whose basis is this id is what answers it, so an approval nobody
    // answered stays visibly outstanding rather than being quietly cleared.
    case 'approval.requested':return typeof p.id==='string' && typeof p.action==='string' &&
      (p.reason===undefined||typeof p.reason==='string') && (p.expiresAt===undefined||integer(p.expiresAt));
    // Asking a named teammate for help, and the answer being that somebody dealt with it.
    //
    // Both halves are written by the host, which is what makes `from` worth reading: the
    // request reaches the host sealed by an endpoint it has verified, so the host states who
    // asked rather than repeating a claim. A client asserting its own name here would make
    // the attribution decorative.
    case 'help.requested':return typeof p.id==='string' && typeof p.question==='string' &&
      typeof p.from==='string' && typeof p.recipient==='string';
    // Resolved and cancelled are different acts by different people - the recipient dealt
    // with it, or the asker withdrew it - so the outcome is recorded rather than inferred
    // from who happened to send it.
    case 'help.settled':return typeof p.id==='string' && typeof p.by==='string' &&
      ['resolved','cancelled'].includes(p.outcome);
    case 'task.completed':return ['completed','failed','cancelled'].includes(p.outcome);
    default:return false;
  }
}
function reduce(state,event) {
  if(!eventValid(event)) fail('unsupported_task_event');
  if(state.events.length===0 && event.type!=='task.created') fail('task_creation_missing');
  if(state.events.length>0 && event.type==='task.created') fail('task_creation_conflict');
  const p=structuredClone(event.payload);
  if(event.type==='task.created') {state.title=p.title;state.objective=p.objective;state.details=p;}
  if(event.type==='message.added') {
    const held=state.messages.find((m)=>m.id===p.id);
    if(held) fail('task_item_conflict');
    state.messages.push(p);
  }
  if(event.type==='plan.updated')state.plan=p;
  if(event.type==='tool.completed')state.tools.push(p);
  if(event.type==='diff.updated')state.diffs=p.files;
  if(event.type==='activity.recorded')state.activity.push(p);
  if(event.type==='help.requested') {
    if(state.help.some((h)=>h.id===p.id)) fail('task_item_conflict');
    state.help.push(p);
  }
  if(event.type==='help.settled') {
    const held=state.help.find((h)=>h.id===p.id);
    if(!held) fail('unknown_help_request');
    if(held.outcome) fail('task_item_conflict');
    held.outcome=p.outcome;held.settledBy=p.by;
  }
  if(event.type==='approval.requested') {
    if(state.approvals.some((a)=>a.id===p.id)) fail('task_item_conflict');
    state.approvals.push(p);
  }
  if(event.type==='decision.recorded')state.decisions.push(p);
  if(event.type==='task.completed')state.outcome=p.outcome;
  state.events.push(structuredClone(event));
}
export class EncryptedTaskTransport {
  constructor({url,token,runtimeId}) {this.url=url;this.token=token;this.runtimeId=runtimeId;}
  async request(path,body) {
    let response;
    for(let attempt=0;attempt<(body===undefined?2:1);attempt++) {
    try {response=await fetch(this.url+'/api/encrypted-tasks'+path,{method:body===undefined?'GET':'POST',
      headers:{Authorization:'Bearer '+this.token,...(this.runtimeId?{'X-Plexus-Runtime':this.runtimeId}:{}),
        ...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
      break;
    } catch {if(attempt===(body===undefined?1:0))fail('relay_unavailable');}
    }
    let value;try {value=await response.json();}catch{fail('invalid_relay_response');}
    if(!response.ok) fail(typeof value.error==='string' && /^[a-z_]{1,64}$/.test(value.error)?value.error:'relay_request_refused');
    return value;
  }
  create(task) {return this.request('',task);}
  list(teamId) {return this.request('?team='+encodeURIComponent(teamId));}
  append(taskId,record) {return this.request('/'+taskId+'/events',record);}
  page(taskId,after=0,through,limit=100) {
    return this.request('/'+taskId+'/events?after='+after+'&limit='+limit+(through===undefined?'':'&through='+through));
  }
}
export async function createEncryptedTask(endpoint,transport,{task,writer,payload}) {
  if(!TASK_ID.test(task.id)||!PROJECT_ID.test(task.projectId)||task.version!==VERSION)fail('invalid_encrypted_task');
  if(!eventValid({type:'task.created',payload}))fail('invalid_task_objective');
  const request=await endpoint.sealControl(writer.user,writer.device,{type:'task.create.v1',task:routing(task),payload});
  const {creatorUserId,...wire}=routing(task);
  return transport.create({...wire,request});
}
export class EncryptedTaskReader {
  constructor({endpoint,task,writer,onStatus=()=>{},checkpoint,admittedSessions}) {
    this.endpoint=endpoint;this.task=routing(task);this.writer=structuredClone(writer);this.onStatus=onStatus;
    // Sessions handed over by an authenticated enrollment handoff, and only those, may be
    // read despite arriving as imports. Empty for a reader that was there from the start.
    this.admittedSessions=new Set(admittedSessions||[]);
    this.floor=checkpoint || {seq:0,hash:null};
    if(!exact(this.floor,['seq','hash']) || !integer(this.floor.seq) ||
      (this.floor.seq===0 ? this.floor.hash!==null : !/^[a-f0-9]{64}$/.test(this.floor.hash)))fail('invalid_local_checkpoint');
    this.floor=structuredClone(this.floor);
    this.seq=0;this.hash=null;this.hashes=new Map();this.ids=new Set();
    this.state={title:null,objective:null,details:null,messages:[],plan:null,tools:[],diffs:[],activity:[],approvals:[],help:[],decisions:[],outcome:null,events:[]};
    this.status={state:'idle',seq:0};this.queue=Promise.resolve();
  }
  setStatus(state,code) {this.status={state,seq:this.seq,...(code?{code}:{})};this.onStatus(this.status);}
  checkpoint() {return {seq:this.seq,hash:this.hash};}
  snapshot() {return structuredClone({...this.state,seq:this.seq,status:this.status});}
  async accept(record) {
    if(!validRecord(record,this.task))fail('invalid_encrypted_record');
    const hash=await digest(record);
    if(record.seq<=this.seq) {if(this.hashes.get(record.seq)!==hash)fail('record_conflict');return;}
    if(record.seq!==this.seq+1)fail('missing_event');
    if(this.ids.has(record.id))fail('event_id_conflict');
    let opened;
    try {opened=await this.endpoint.decryptVerifiedTask(roomFor(this.task.id),{...record.envelope,
      event_id:'$'+record.id,origin_server_ts:record.seq},this.writer,
      {admittedSessions:this.admittedSessions});} catch {fail('task_integrity_failed');}
    const p=opened.content;
    if(opened.type!=='plexus.task.event.v1'||!exact(p,['version','task','seq','eventId','previous','event'])||
      p.version!==VERSION||canonical(p.task)!==canonical(this.task)||p.seq!==record.seq||p.eventId!==record.id||p.previous!==this.hash)fail('task_integrity_failed');
    if(record.seq===this.floor.seq && hash!==this.floor.hash)fail('history_rollback');
    const next=structuredClone(this.state);reduce(next,p.event);
    this.state=next;this.seq=record.seq;this.hash=hash;this.hashes.set(record.seq,hash);this.ids.add(record.id);
  }
  reconnect(transport) {
    const work=this.queue.then(()=>this.replay(transport));this.queue=work.catch(()=>{});return work;
  }
  async replay(transport) {
    this.setStatus('replaying');
    try {
      let through;
      for(;;) {
        const page=await transport.page(this.task.id,this.seq,through);
        if(!page?.task||canonical(routing(page.task))!==canonical(this.task)||!integer(page.head)||!Array.isArray(page.events)||
          page.events.length>100 || !integer(page.nextSeq))fail('invalid_relay_response');
        if(page.head<Math.max(this.seq,this.floor.seq))fail('history_rollback');
        if(through===undefined)through=page.head;
        if(page.head!==through)fail('replay_head_changed');
        const before=this.seq;
        for(const record of page.events){if(record.seq>through)fail('invalid_relay_response');await this.accept(record);}
        if(page.nextSeq!==this.seq)fail('invalid_replay_cursor');
        if(this.seq===through)break;
        if(this.seq===before)fail('missing_event');
      }
      if(this.seq<this.floor.seq)fail('history_rollback');
      this.setStatus('caught-up');return this.snapshot();
    } catch(error) {
      const code=error instanceof TaskReplayError?error.code:'task_integrity_failed';
      this.setStatus('error',code);throw new TaskReplayError(code);
    }
  }
  search(text) {return this.state.events.filter((event)=>canonical(event).includes(text)).map((event)=>structuredClone(event));}
  overlap(paths) {return this.state.activity.flatMap((a)=>a.paths).filter((p)=>paths.includes(p));}
}
export class EncryptedTaskWriter {
  constructor({reader,transport,load,save}) {
    if(typeof load!=='function'||typeof save!=='function')fail('durable_task_state_required');
    this.reader=reader;this.transport=transport;this.save=save;this.saved=load()||{};
    if(this.saved.checkpoint)this.reader.floor=this.saved.checkpoint;
    this.queue=Promise.resolve();
  }
  append(event,id) {
    if(!EVENT_ID.test(id))return Promise.reject(new TaskReplayError('stable_event_id_required'));
    // Serialize before any SDK awaits: one task has one authoritative writing host.
    const work=this.queue.then(()=>this.write(event,id));this.queue=work.catch(()=>{});return work;
  }
  async resume() {
    if(this.saved.pending) {
      const pending=this.saved.pending;
      this.save(this.saved);
      await this.transport.append(this.reader.task.id,pending);
      await this.reader.reconnect(this.transport);
      this.saved={checkpoint:this.reader.checkpoint()};this.save(this.saved);
    } else await this.reader.reconnect(this.transport);
  }
  async write(event,id) {
    await this.resume();
    if(this.reader.ids.has(id)) {
      const existingIndex=[...this.reader.ids].indexOf(id);
      if(canonical(this.reader.state.events[existingIndex])!==canonical(event))fail('event_id_conflict');
      return {duplicate:true,seq:existingIndex+1};
    }
    const next=structuredClone(this.reader.state);reduce(next,event);
    const seq=this.reader.seq+1;
    const envelope=await this.reader.endpoint.encryptTask(roomFor(this.reader.task.id),'plexus.task.event.v1',
      {version:VERSION,task:this.reader.task,seq,eventId:id,previous:this.reader.hash,event});
    const record={version:VERSION,id,seq,envelope};
    if(!validRecord(record,this.reader.task))fail('invalid_encrypted_record');
    this.saved={checkpoint:this.reader.checkpoint(),pending:record};this.save(this.saved);
    const result=await this.transport.append(this.reader.task.id,record);
    await this.reader.accept(record);
    this.saved={checkpoint:this.reader.checkpoint()};this.save(this.saved);
    return result;
  }
}
