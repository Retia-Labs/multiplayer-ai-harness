'use strict';
// Provider-independent task boundary. The host operator supplies project mappings and
// verified creator identities; routing metadata or team ownership never supplies them.
const {DatabaseSync}=require('node:sqlite');
const {createHash}=require('node:crypto');
const {EncryptedTaskReader,EncryptedTaskWriter,routing}=require('../e2ee/task-log.mjs');
const {canonical,roomFor}=require('../protocol/encrypted-task.mjs');
class EncryptedTaskState {
  constructor(file) {
    this.db=new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS encrypted_task_state(id TEXT PRIMARY KEY,state TEXT NOT NULL)');
  }
  load(id) {const r=this.db.prepare('SELECT state FROM encrypted_task_state WHERE id=?').get(id);return r?JSON.parse(r.state):null;}
  save(id,state) {this.db.prepare('INSERT INTO encrypted_task_state VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(id,JSON.stringify(state));}
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
    {type:'task.completed',payload:{outcome:'completed'}}
  ];
}
const fixtureEventId=(taskId,index)=>'ev_'+createHash('sha256').update(taskId+':fixture:'+index).digest('hex').slice(0,32);
module.exports={EncryptedTaskState,EncryptedFixtureHost,fixtureEvents,fixtureEventId};
