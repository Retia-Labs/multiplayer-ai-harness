import * as sdk from '/vendor/index.mjs';
import {createEndpointAPI} from '/packages/e2ee/endpoint-core.mjs';
import {HttpKeyTransport} from '/packages/e2ee/http-transport.mjs';
import {EncryptedTaskTransport,EncryptedTaskReader,createEncryptedTask} from '/packages/e2ee/task-log.mjs';
const {Endpoint}=createEndpointAPI(sdk);
let endpoint,transport,reader,config;
globalThis.fixture={
  async init(options) {
    config=options;endpoint=await Endpoint.create({...options.endpoint,transport:new HttpKeyTransport(options.endpoint.transport)});
    transport=new EncryptedTaskTransport({url:location.origin,token:options.token});
    let checkpoint;try{checkpoint=JSON.parse(localStorage.getItem(options.task.id));}catch{}
    reader=new EncryptedTaskReader({endpoint,task:options.task,writer:options.writer,checkpoint,
      onStatus:(status)=>{
        document.querySelector('#status').textContent=status.state+(status.code?': '+status.code:'')+' through '+status.seq;
        if(status.state==='caught-up')localStorage.setItem(options.task.id,JSON.stringify(reader.checkpoint()));
      }});
    return endpoint.identity();
  },
  confirm(identity){return endpoint.confirmEndpoint(identity,{confirmed:true});},
  create(payload){return createEncryptedTask(endpoint,transport,{task:config.task,writer:config.writer,payload});},
  async receiveKeys(){return endpoint.open(await endpoint.transport.drain());},
  async reconnect(){
    try {const snapshot=await reader.reconnect(transport);document.querySelector('#task').textContent=JSON.stringify(snapshot,null,2);return snapshot;}
    catch(error){return {error:error.code};}
  },
  checkpoint(){return reader.checkpoint();},
  close(){endpoint.close();}
};
