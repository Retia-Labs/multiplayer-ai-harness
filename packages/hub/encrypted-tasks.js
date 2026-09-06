'use strict';
const { TASK_ID, PROJECT_ID, VERSION, canonical, exact, validRequest, validRecord, matrixUser, integer } = require('../protocol/encrypted-task.mjs');
const problem = (code, status=400) => Object.assign(new Error(code), {code,status});
class EncryptedTasks {
  constructor(store) {
    this.store=store; this.db=store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS encrypted_tasks(id TEXT PRIMARY KEY, team_id TEXT NOT NULL, runtime_id TEXT NOT NULL, project_id TEXT NOT NULL, creator_id TEXT NOT NULL, version INTEGER NOT NULL, request TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS encrypted_task_events(task_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(task_id,seq), UNIQUE(task_id,event_id));
      CREATE INDEX IF NOT EXISTS encrypted_tasks_team ON encrypted_tasks(team_id,runtime_id);
    `);
  }
  get(id) {
    const r=this.db.prepare('SELECT * FROM encrypted_tasks WHERE id=?').get(id);
    return r ? {version:r.version,id:r.id,teamId:r.team_id,runtimeId:r.runtime_id,projectId:r.project_id,creatorUserId:r.creator_id,request:JSON.parse(r.request)} : null;
  }
  head(id) { return this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM encrypted_task_events WHERE task_id=?').get(id).seq; }
  create(value,user) {
    if (!exact(value,['version','id','teamId','runtimeId','projectId','request']) || value.version!==VERSION ||
      !TASK_ID.test(value.id) || !PROJECT_ID.test(value.projectId) || typeof value.teamId!=='string' || typeof value.runtimeId!=='string' ||
      !validRequest(value.request,matrixUser(user.id))) throw problem('invalid_encrypted_task');
    if (!this.store.membership(value.teamId,user.id)) throw problem('not_a_member',403);
    const pairing=this.store.runtimePairing(value.runtimeId);
    if (!pairing || pairing.teamId!==value.teamId) throw problem('foreign_runtime',403);
    if (this.store.getRuntime(value.runtimeId)?.taskProtocol!=='encrypted-v1') throw problem('encrypted_runtime_required',409);
    if (this.store.getThread(value.id)) throw problem('task_id_conflict',409);
    const existing=this.get(value.id);
    const task={...value,creatorUserId:user.id};
    if (existing) {
      if (canonical(task)!==canonical(existing)) throw problem('task_id_conflict',409);
      return {task:existing,duplicate:true};
    }
    this.db.prepare('INSERT INTO encrypted_tasks VALUES (?,?,?,?,?,?,?)').run(value.id,value.teamId,value.runtimeId,value.projectId,user.id,VERSION,canonical(value.request));
    return {task,duplicate:false};
  }
  append(task,record) {
    if (!validRecord(record,task)) throw problem('invalid_encrypted_record');
    const encoded=canonical(record);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const duplicate=this.db.prepare('SELECT record FROM encrypted_task_events WHERE task_id=? AND event_id=?').get(task.id,record.id);
      if (duplicate) {
        if (duplicate.record!==encoded) throw problem('event_id_conflict',409);
        this.db.exec('COMMIT'); return {seq:record.seq,duplicate:true};
      }
      if (record.seq!==this.head(task.id)+1) throw problem('sequence_conflict',409);
      this.db.prepare('INSERT INTO encrypted_task_events VALUES (?,?,?,?)').run(task.id,record.seq,record.id,encoded);
      this.db.exec('COMMIT'); return {seq:record.seq,duplicate:false};
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  principal(req) {
    const header=req.headers.authorization || '';
    const token=header.startsWith('Bearer ') ? header.slice(7) : '';
    const runtimeId=req.headers['x-plexus-runtime'];
    if (runtimeId) {
      const pairing=this.store.runtimePairing(runtimeId);
      if (!pairing || !this.store.runtimeCredentialMatches(runtimeId,token)) throw problem('runtime_authentication_failed',401);
      return {runtimeId,teamId:pairing.teamId};
    }
    const user=this.store.userByToken(token);
    if (!user) throw problem('unauthenticated',401);
    return {user};
  }
  authorize(principal,task) {
    if (principal.runtimeId) {
      if (principal.runtimeId!==task.runtimeId || principal.teamId!==task.teamId) throw problem('foreign_runtime',403);
    } else if (!this.store.membership(task.teamId,principal.user.id)) throw problem('not_a_member',403);
  }
  async handle(req,res,url) {
    const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try {
      const principal=this.principal(req);
      const parts=url.pathname.split('/').filter(Boolean);
      if (parts.length===2 && req.method==='GET') {
        const teamId=url.searchParams.get('team');
        if (principal.runtimeId ? teamId!==principal.teamId : !this.store.membership(teamId,principal.user.id)) throw problem('not_a_member',403);
        const rows=principal.runtimeId ? this.db.prepare('SELECT id FROM encrypted_tasks WHERE team_id=? AND runtime_id=?').all(teamId,principal.runtimeId) :
          this.db.prepare('SELECT id FROM encrypted_tasks WHERE team_id=?').all(teamId);
        return reply(200,{tasks:rows.map(({id})=>this.get(id))});
      }
      let body;
      if (req.method==='POST') {
        let size=0; const chunks=[];
        for await(const chunk of req) {size+=chunk.length;if(size>1024*1024)throw problem('record_too_large',413);chunks.push(chunk);}
        try {body=JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw problem('invalid_encrypted_record');}
        // Membership may have changed while the upload was arriving.
        const current=this.principal(req);
        if (current.runtimeId!==principal.runtimeId || current.user?.id!==principal.user?.id) throw problem('unauthenticated',401);
      }
      if(parts.length===2 && req.method==='POST') {
        if(!principal.user) throw problem('client_required',403);
        return reply(200,this.create(body,principal.user));
      }
      if(parts.length!==4 || parts[3]!=='events' || !TASK_ID.test(parts[2])) throw problem('encrypted_route_required',404);
      const task=this.get(parts[2]); if(!task) throw problem('unknown_encrypted_task',404);
      this.authorize(this.principal(req),task);
      if(req.method==='POST') {
        if(!principal.runtimeId) throw problem('owning_runtime_required',403);
        return reply(200,this.append(task,body));
      }
      if(req.method!=='GET') throw problem('method_not_allowed',405);
      const number=(name,def)=>url.searchParams.has(name) ? Number(url.searchParams.get(name)) : def;
      const after=number('after',0),limit=number('limit',100),head=this.head(task.id),through=number('through',head);
      if(![after,through,limit].every(integer) || limit<1 || limit>100 || through>head || after>through) throw problem('invalid_replay_cursor');
      const events=this.db.prepare('SELECT record FROM encrypted_task_events WHERE task_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?').all(task.id,after,through,limit).map((r)=>JSON.parse(r.record));
      return reply(200,{task,events,head:through,nextSeq:events.at(-1)?.seq ?? after});
    } catch(error) {
      // Never reflect request bodies, SDK errors, paths or arbitrary exception messages.
      reply(error.status || 400,{error:error.code || 'encrypted_request_refused'});
    }
  }
}
module.exports={EncryptedTasks};
