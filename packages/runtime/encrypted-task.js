'use strict';
// Provider-independent task boundary. The host operator supplies project mappings and
// verified creator identities; routing metadata or team ownership never supplies them.
const {DatabaseSync}=require('node:sqlite');
const {createHash}=require('node:crypto');
const {EncryptedTaskReader,EncryptedTaskWriter,routing}=require('../e2ee/task-log.mjs');
const {handOffHistory}=require('../e2ee/enrollment.mjs');
const {canonical,roomFor,TASK_ID}=require('../protocol/encrypted-task.mjs');
class EncryptedTaskState {
  constructor(file) {
    this.db=new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS encrypted_task_state(id TEXT PRIMARY KEY,state TEXT NOT NULL)');
  }
  load(id) {const r=this.db.prepare('SELECT state FROM encrypted_task_state WHERE id=?').get(id);return r?JSON.parse(r.state):null;}
  save(id,state) {this.db.prepare('INSERT INTO encrypted_task_state VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(id,JSON.stringify(state));}
  // Task checkpoints predate authority replacement. Enumerate those durable IDs,
  // so a restarted host can rotate every known room even when the relay omits it.
  taskIds() {return this.db.prepare('SELECT id FROM encrypted_task_state').all().map(row=>row.id).filter(id=>TASK_ID.test(id));}
  saveMany(entries) {
    this.db.exec('BEGIN IMMEDIATE');
    try { for (const [id, state] of entries) this.save(id, state); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(){this.db.close();}
}
class EncryptedFixtureHost {
  constructor({runtime,endpoint,transport,state,projects,creators}) {
    if(!runtime.encryptedTasksOnly)throw new Error('encrypted_runtime_required');
    Object.assign(this,{runtime,endpoint,transport,state,projects,creators});
  }
  async open(task) {
    if(this.runtime.teamId!==task.teamId||this.runtime.id!==task.runtimeId)throw new Error('foreign_runtime');
    const project=this.projects.get(task.projectId);
    if(!project || !this.runtime.projects.has(project))throw new Error('project_not_authorized');
    const expected=this.creators.get(task.creatorUserId);
    if(!expected)throw new Error('task_creator_unverified');
    // Record the room before any SDK operation can share its first session. A crash
    // before event one must not leave an untracked session available after removal.
    if(!this.state.load(task.id))this.state.save(task.id,{});
    const reader=new EncryptedTaskReader({endpoint:this.endpoint,task,writer:this.endpoint.identity()});
    const writer=new EncryptedTaskWriter({reader,transport:this.transport,load:()=>this.state.load(task.id),save:(value)=>this.state.save(task.id,value)});
    await writer.resume();
    let objective;
    if(reader.seq===0 && !writer.saved.pending) {
      let event;try{event=await this.endpoint.openControl([task.request]);}catch{throw new Error('task_request_integrity_failed');}
      if(event.sender!==expected.user||event.senderDevice!==expected.device||event.senderKey!==expected.curve25519||
        event.content?.type!=='task.create.v1'||canonical(event.content.task)!==canonical(routing(task)))throw new Error('task_request_integrity_failed');
      objective=event.content.payload;
      await this.endpoint.shareVerifiedTaskKey(roomFor(task.id),[this.endpoint.identity(),expected]);
    } else objective=reader.state.details;
    return {reader,writer,objective};
  }
  // The host writes the log, so the host owns the group session. A project grant made
  // on a client is only half of joining: until the writing host re-shares to the new
  // member set, a newly granted reader can replay history it was handed and nothing
  // written afterwards. Rotating here is what makes removal mean something too.
  // Handing a joining teammate the history of a task this host wrote. Only the writer
  // may do this: an exported session states its sender keys as claimed metadata, so a
  // handoff from anyone else is a forgery waiting to be believed.
  async handOff(task,member) {
    if(this.runtime.teamId!==task.teamId||this.runtime.id!==task.runtimeId)throw new Error('foreign_runtime');
    return handOffHistory(this.endpoint,{teamId:task.teamId,projectId:task.projectId,member,taskIds:[task.id]});
  }
  async admit(task,members,{rotate=false}={}) {
    if(!Array.isArray(members)||!members.length)throw new Error('task_members_required');
    if(this.runtime.teamId!==task.teamId||this.runtime.id!==task.runtimeId)throw new Error('foreign_runtime');
    return this.endpoint.shareVerifiedTaskKey(roomFor(task.id),[this.endpoint.identity(),...members],{rotate});
  }
}
function fixtureEvents(payload) {
  return [
    {type:'task.created',payload},
    {type:'message.added',payload:{id:'request',role:'user',text:payload.objective}},
    {type:'plan.updated',payload:{steps:[{text:payload.fixture.plan,status:'completed'}]}},
    {type:'tool.completed',payload:{id:'fixture-tool',name:'fixture.read',arguments:{path:payload.fixture.path},result:{text:payload.fixture.result}}},
    {type:'diff.updated',payload:{files:[{path:payload.fixture.path,patch:payload.fixture.diff}]}},
    {type:'activity.recorded',payload:{description:payload.fixture.activity,paths:[payload.fixture.path]}},
    {type:'message.added',payload:{id:'answer',role:'assistant',text:payload.fixture.answer}},
    // The fixture ends with a turn finishing, not with the task being declared done: only a
    // person records the second, and this history has no person in it.
    {type:'turn.completed',payload:{status:'completed'}}
  ];
}
const fixtureEventId=(taskId,index)=>'ev_'+createHash('sha256').update(taskId+':fixture:'+index).digest('hex').slice(0,32);
module.exports={EncryptedTaskState,EncryptedFixtureHost,fixtureEvents,fixtureEventId};
