'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomBytes}=require('node:crypto');
const {Hub}=require('../packages/hub/server');
const {Runtime}=require('../packages/runtime');
const {Endpoint}=require('../packages/e2ee/endpoint');
const {KeyDirectory,KeyTransport}=require('../packages/e2ee/key-transport');
const {EncryptedTaskReader,EncryptedTaskWriter,EncryptedTaskTransport,createEncryptedTask,newId,routing}=require('../packages/e2ee/task-log.mjs');
const {roomFor,matrixUser,canonical}=require('../packages/protocol/encrypted-task.mjs');
const {EncryptedTaskState,EncryptedFixtureHost,fixtureEvents,fixtureEventId}=require('../packages/runtime/encrypted-task');
const waitFor=async(fn)=>{for(let n=0;n<200;n++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw new Error('fixture_timeout');};
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'plexus-encrypted-task-'));
const canary='PRIVATE_'+randomBytes(16).toString('hex'),logs=[],results=[];
const pass=(name)=>{results.push({name,status:'pass'});console.log('PASS '+name);};
let hub,runtime,client,host,state,socket;const extra=[];
(async()=>{
  hub=new Hub({dbFile:path.join(tmp,'hub.sqlite'),log:(...args)=>logs.push(args)});
  let addr=await hub.listen();let url='http://127.0.0.1:'+addr.port;
  const project=path.join(tmp,canary+'-workspace');fs.mkdirSync(project);
  runtime=new Runtime({hubUrl:url.replace('http','ws'),userName:'host',dataDir:path.join(tmp,'runtime'),projects:[project],encryptedTasksOnly:true});await runtime.start();
  let welcome;const messages=[];
  socket=new WebSocket(url.replace('http','ws'));
  socket.onopen=()=>socket.send(JSON.stringify({type:'hello',name:'creator'}));
  socket.onmessage=({data})=>{const m=JSON.parse(data);messages.push(m);if(m.type==='welcome')welcome=m;};
  await waitFor(()=>welcome&&hub.pendingPairings.size);
  socket.send(JSON.stringify({type:'team/create',name:'Fixture team'}));await waitFor(()=>messages.some(m=>m.type==='team'));
  const team=messages.find(m=>m.type==='team').team;
  socket.send(JSON.stringify({type:'runtime/pair',teamId:team.id,code:runtime.pairingCode}));await waitFor(()=>runtime.teamId===team.id);
  const account=hub.store.userById(welcome.user.id);
  const transport=new EncryptedTaskTransport({url,token:account.token});
  const hostTransport=new EncryptedTaskTransport({url,token:runtime.runtimeToken,runtimeId:runtime.id});
  const directory=new KeyDirectory(),keyTransport=new KeyTransport(directory);
  client=await Endpoint.create({user:matrixUser(account.id),device:'CLIENT',transport:keyTransport});
  host=await Endpoint.create({user:matrixUser(runtime.id),device:'HOST',transport:keyTransport});
  for(const ep of[client,host])for(const peer of[client,host])await ep.confirmEndpoint(peer.identity(),{confirmed:true});
  const task={version:1,id:newId('et'),teamId:team.id,runtimeId:runtime.id,projectId:newId('ep'),creatorUserId:account.id};
  const payload={title:canary+' title',objective:canary+' objective',fixture:{plan:canary+' plan',path:canary+'/file.txt',result:canary+' output',diff:canary+' diff',activity:canary+' activity',answer:canary+' answer'}};
  const created=await createEncryptedTask(client,transport,{task,writer:host.identity(),payload});
  assert.equal((await transport.create((({creatorUserId,...r})=>r)(created.task))).duplicate,true);
  assert.equal((await transport.list(team.id)).tasks.length,1);
  state=new EncryptedTaskState(path.join(tmp,'task-outbox.sqlite'));
  const fixtureHost=new EncryptedFixtureHost({runtime,endpoint:host,transport:hostTransport,state,projects:new Map([[task.projectId,project]]),creators:new Map([[account.id,client.identity()]])});
  const opened=await fixtureHost.open(created.task);
  assert.deepEqual(opened.objective,payload);
  await client.open(directory.drain(client.user,client.device));
  const events=fixtureEvents(opened.objective);
  await opened.writer.append(events[0],fixtureEventId(task.id,0));
  await opened.writer.append(events[1],fixtureEventId(task.id,1));
  const reader=new EncryptedTaskReader({endpoint:client,task,writer:host.identity()});
  await reader.reconnect(transport);assert.equal(reader.seq,2);assert.equal(reader.state.title,payload.title);
  for(let i=2;i<events.length;i++)await opened.writer.append(events[i],fixtureEventId(task.id,i));
  await Promise.all([reader.reconnect(transport),reader.reconnect(transport)]);
  assert.deepEqual(reader.state.events,events);assert.equal(reader.state.outcome,'completed');
  assert.equal(reader.search(canary).length,7);assert.deepEqual(reader.overlap([payload.fixture.path]),[payload.fixture.path]);
  pass('enrolled client creates an opaque task through the real paired hub; full fixture is reconstructed at endpoints');

  const all=(await transport.page(task.id)).events;
  assert.equal((await hostTransport.append(task.id,all[0])).duplicate,true);
  const conflict=structuredClone(all[0]);conflict.envelope.content.ciphertext=all[1].envelope.content.ciphertext;
  await assert.rejects(()=>hostTransport.append(task.id,conflict),/event_id_conflict/);
  await assert.rejects(()=>transport.append(task.id,all[0]),/owning_runtime_required/);
  assert.equal(hub.encryptedTasks.head(task.id),events.length);
  const cold=new EncryptedTaskReader({endpoint:client,task,writer:host.identity()});
  await cold.reconnect({page:(id,after,through)=>transport.page(id,after,through,2)});
  assert.deepEqual(cold.state,reader.state);
  await cold.accept(all[0]);assert.equal(cold.seq,8);
  pass('pagination, cold replay, concurrent reconnect and duplicate append/delivery preserve exactly one full history');

  const extraEvent={type:'activity.recorded',payload:{description:canary+' after ack loss',paths:[]}},extraId=newId('ev');
  let drop=true;
  opened.writer.transport={page:hostTransport.page.bind(hostTransport),append:async(...args)=>{const result=await hostTransport.append(...args);if(drop){drop=false;throw new Error('relay_unavailable');}return result;}};
  await assert.rejects(()=>opened.writer.append(extraEvent,extraId),/relay_unavailable/);
  assert.ok(state.load(task.id).pending);
  state.close();state=new EncryptedTaskState(path.join(tmp,'task-outbox.sqlite'));
  fixtureHost.state=state;
  const resumed=new EncryptedTaskWriter({reader:new EncryptedTaskReader({endpoint:host,task,writer:host.identity()}),transport:hostTransport,
    load:()=>state.load(task.id),save:(v)=>state.save(task.id,v)});
  assert.equal((await resumed.append(extraEvent,extraId)).duplicate,true);
  assert.equal(hub.encryptedTasks.head(task.id),9);
  pass('lost append acknowledgment and writer-state restart retry the exact durable ciphertext without duplicate events');

  const adversary=async(change,code)=>{
    const check=new EncryptedTaskReader({endpoint:client,task,writer:host.identity()});
    const page=await transport.page(task.id);change(page);
    await assert.rejects(()=>check.reconnect({page:async()=>page}),new RegExp(code));
    assert.equal(check.status.state,'error');
  };
  await adversary(p=>p.events.splice(2,1),'missing_event');
  await adversary(p=>{p.events[0].envelope.content.ciphertext=p.events[1].envelope.content.ciphertext;},'task_integrity_failed');
  await adversary(p=>{p.events[1].seq=1;},'record_conflict');
  await adversary(p=>{p.events[0].version=99;},'invalid_encrypted_record');
  await adversary(p=>{p.task.projectId=newId('ep');},'invalid_relay_response');
  const previous=reader.snapshot();await assert.rejects(()=>reader.reconnect({page:async()=>({task:created.task,head:1,nextSeq:1,events:[]})}),/history_rollback/);
  assert.equal(reader.state.title,previous.title);assert.equal(reader.seq,previous.seq);assert.equal(reader.status.state,'error');
  await reader.reconnect(transport);assert.equal(reader.seq,9);
  pass('missing, tampered, conflicting, wrong-task and unsupported records are visible errors; rollback preserves accepted history');

  const rogue=await Endpoint.create({user:host.user,device:'OTHER_DEVICE',transport:keyTransport});extra.push(rogue);
  await rogue.confirmEndpoint(client.identity(),{confirmed:true});
  await rogue.confirmEndpoint(rogue.identity(),{confirmed:true});
  await client.confirmEndpoint(rogue.identity(),{confirmed:true});
  await rogue.shareVerifiedTaskKey(roomFor(task.id),[rogue.identity(),client.identity()]);
  await client.open(directory.drain(client.user,client.device));
  const forgedEnvelope=await rogue.encryptTask(roomFor(task.id),'plexus.task.event.v1',{
    version:1,task:routing(task),seq:1,eventId:all[0].id,previous:null,event:events[0]});
  await adversary(p=>{p.events[0].envelope=forgedEnvelope;},'task_integrity_failed');
  // Imported keys can claim another device's public fingerprints. Provenance must
  // remain untrusted even though both the ciphertext and those claims are well formed.
  const victim=await Endpoint.create({user:'@import_verifier:plexus.local',device:'VERIFY',transport:keyTransport});extra.push(victim);
  await victim.confirmEndpoint(host.identity(),{confirmed:true});
  const forgedKeys=JSON.parse(await rogue.machine.exportRoomKeys(()=>true));
  for(const key of forgedKeys){key.sender_key=host.identity().curve25519;key.sender_claimed_keys={ed25519:host.identity().ed25519};}
  await victim.machine.importExportedRoomKeys(JSON.stringify(forgedKeys),()=>{});
  const importedForgery=structuredClone(forgedEnvelope);importedForgery.content.sender_key=host.identity().curve25519;importedForgery.content.device_id=host.device;
  const victimReader=new EncryptedTaskReader({endpoint:victim,task,writer:host.identity()});
  const forgedPage=await transport.page(task.id);forgedPage.events[0].envelope=importedForgery;
  await assert.rejects(()=>victimReader.reconnect({page:async()=>forgedPage}),/task_integrity_failed/);
  const substituted={...created.task,id:newId('et')};
  const {creatorUserId:ignored,...substitutedWire}=substituted;
  await transport.create(substitutedWire);
  await assert.rejects(()=>fixtureHost.open(substituted),/task_request_integrity_failed/);
  await assert.rejects(()=>transport.page(task.id,0,undefined,-1),/invalid_replay_cursor/);
  await assert.rejects(()=>transport.page(task.id,0,999),/invalid_replay_cursor/);
  pass('another verified device cannot impersonate the pinned writer; creation requests cannot be transplanted to another task');

  const outsider=hub.store.createAccount('outsider');
  await assert.rejects(()=>new EncryptedTaskTransport({url,token:outsider.token}).page(task.id),/not_a_member/);
  await assert.rejects(()=>new EncryptedTaskTransport({url,token:'bad'}).page(task.id),/unauthenticated/);
  await assert.rejects(()=>new EncryptedTaskTransport({url,token:runtime.runtimeToken,runtimeId:'rt_other'}).page(task.id),/runtime_authentication_failed/);
  const rawTask={...created.task};delete rawTask.creatorUserId;
  await assert.rejects(()=>transport.create({...rawTask,id:newId('et'),title:canary}),/invalid_encrypted_task/);
  await assert.rejects(()=>hostTransport.append(task.id,{...all[0],plaintext:canary}),/invalid_encrypted_record/);
  const badBody=await fetch(url+'/api/encrypted-tasks',{method:'POST',headers:{Authorization:'Bearer '+account.token},body:'bad '+canary});
  assert.ok(!(await badBody.text()).includes(canary));
  assert.equal(hub.store.getThread(task.id),null);assert.equal(hub.activity.has(task.id),false);
  assert.deepEqual(hub.store.getRuntime(runtime.id).projects,[]);
  await assert.rejects(()=>runtime.dispatch({method:'thread/start',cwd:project}),/encrypted_route_required/);
  assert.ok(!JSON.stringify(hub.store.listThreads(team.id)).includes(task.id));
  const legacy=await fetch(url+'/api/threads/'+task.id+'/events',{headers:{Authorization:'Bearer '+account.token}});
  assert.equal((await legacy.json()).error,'encrypted_route_required');
  const before=messages.length;socket.send(JSON.stringify({type:'command',id:'plaintext-fallback',threadId:task.id,command:{method:'turn/start',input:canary}}));
  await waitFor(()=>messages.slice(before).some(m=>m.type==='error'));assert.equal(messages.slice(before).find(m=>m.type==='error').code,'encrypted_route_required');
  pass('team/runtime authorization and explicit no-plaintext routes reject cross-team access and disable server content projections');

  socket.close();await waitFor(()=>socket.readyState===3);socket=null;
  const oldPort=addr.port;await hub.close();hub=new Hub({dbFile:path.join(tmp,'hub.sqlite'),log:(...args)=>logs.push(args)});await hub.listen(oldPort);
  await reader.reconnect(transport);assert.equal(reader.seq,9);assert.equal(reader.state.tools[0].result.text,payload.fixture.result);
  assert.equal(hub.encryptedTasks.head(task.id),9);
  pass('relay restart preserves ciphertext and a reconnect restores all task fields');

  const dump=JSON.stringify({tasks:hub.encryptedTasks.get(task.id),records:await transport.page(task.id),logs,activity:[...hub.activity],commands:[...hub.commandLog]});
  assert.ok(!dump.includes(canary));
  for(const name of['hub.sqlite','hub.sqlite-wal','task-outbox.sqlite','task-outbox.sqlite-wal']){const file=path.join(tmp,name);if(fs.existsSync(file))assert.ok(!fs.readFileSync(file).includes(Buffer.from(canary)),name+' leaked task content');}
  hub.store.removeMember(team.id,account.id);await assert.rejects(()=>transport.page(task.id),/not_a_member/);
  hub.store.unpairRuntime(runtime.id);await assert.rejects(()=>hostTransport.page(task.id),/runtime_authentication_failed/);
  pass('relay database/WAL, errors, logs and caches contain no canary; revoked membership and unpaired hosts lose access');

  const out=path.join(__dirname,'..','.artifacts','encrypted-task');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'acceptance.json'),JSON.stringify({ranAt:new Date().toISOString(),results},null,2));
  console.log(results.length+' encrypted task checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{socket?.close();runtime?.stop();if(hub)await hub.close();client?.close();host?.close();for(const e of extra)e.close();state?.close();});
