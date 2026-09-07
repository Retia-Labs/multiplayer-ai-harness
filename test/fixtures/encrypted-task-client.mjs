import * as sdk from '/vendor/index.mjs';
import {createEndpointAPI} from '/packages/e2ee/endpoint-core.mjs';
import {HttpKeyTransport} from '/packages/e2ee/http-transport.mjs';
import {EncryptedTaskTransport,EncryptedTaskReader,createEncryptedTask} from '/packages/e2ee/task-log.mjs';
import {EnrollmentTransport,announceEndpoint,acceptProjectAccess} from '/packages/e2ee/enrollment.mjs';
const {Endpoint}=createEndpointAPI(sdk);
let endpoint,transport,reader,config,enrollment;
globalThis.fixture={
  async init(options) {
    config=options;endpoint=await Endpoint.create({...options.endpoint,transport:new HttpKeyTransport(options.endpoint.transport)});
    transport=new EncryptedTaskTransport({url:location.origin,token:options.token});
    enrollment=new EnrollmentTransport({url:location.origin,token:options.token});
    let checkpoint;try{checkpoint=JSON.parse(localStorage.getItem(options.task.id));}catch{}
    // Which imported sessions this endpoint was handed is durable trust state, exactly like
    // the checkpoint. Keeping it only in memory means a reopened tab holds the keys to its
    // own history and refuses to read them.
    let admittedSessions=[];try{admittedSessions=JSON.parse(localStorage.getItem(options.task.id+':admitted'))||[];}catch{}
    reader=new EncryptedTaskReader({endpoint,task:options.task,writer:options.writer,checkpoint,admittedSessions,
      onStatus:(status)=>{
        document.querySelector('#status').textContent=status.state+(status.code?': '+status.code:'')+' through '+status.seq;
        if(status.state==='caught-up')localStorage.setItem(options.task.id,JSON.stringify(reader.checkpoint()));
      }});
    return endpoint.identity();
  },
  confirm(identity){return endpoint.confirmEndpoint(identity,{confirmed:true});},
  identity(){return endpoint.identity();},
  announce(teamId){return announceEndpoint(endpoint,enrollment,teamId);},
  // The handoff is what makes an imported session readable, and only its own session ids.
  async accept(handoff,writer){
    const accepted=await acceptProjectAccess(endpoint,{history:handoff},{writer});
    for(const id of accepted.sessions)reader.admittedSessions.add(id);
    localStorage.setItem(config.task.id+':admitted',JSON.stringify([...reader.admittedSessions]));
    return {imported:accepted.imported,sessions:accepted.sessions};
  },
  create(payload){return createEncryptedTask(endpoint,transport,{task:config.task,writer:config.writer,payload});},
  async receiveKeys(){return endpoint.open(await endpoint.transport.drain());},
  async reconnect(){
    try {const snapshot=await reader.reconnect(transport);document.querySelector('#task').textContent=JSON.stringify(snapshot,null,2);return snapshot;}
    catch(error){return {error:error.code};}
  },
  checkpoint(){return reader.checkpoint();},
  close(){endpoint.close();}
};
