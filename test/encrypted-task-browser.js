'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomBytes}=require('node:crypto');const {chromium}=require('playwright-core');
const {Hub}=require('../packages/hub/server'),{Runtime}=require('../packages/runtime');
const {Endpoint}=require('../packages/e2ee/endpoint'),{ExperimentRelay}=require('../packages/e2ee/experiment-relay');
const {HttpKeyTransport}=require('../packages/e2ee/http-transport.mjs');
const {EncryptedTaskTransport,newId}=require('../packages/e2ee/task-log.mjs');
const {matrixUser}=require('../packages/protocol/encrypted-task.mjs');
const {EncryptedTaskState,EncryptedFixtureHost,fixtureEvents,fixtureEventId}=require('../packages/runtime/encrypted-task');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'plexus-task-browser-')),root=path.join(__dirname,'..'),web=path.join(tmp,'web');
let hub,keyRelay,runtime,host,browser,state,socket;
const waitFor=async(fn)=>{for(let n=0;n<200;n++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw new Error('fixture_timeout');};
(async()=>{
  for(const name of [...Hub.SHARED_MODULES].map(name=>'packages/'+name).concat('packages/e2ee/http-transport.mjs')){
    fs.mkdirSync(path.dirname(path.join(web,name)),{recursive:true});fs.copyFileSync(path.join(root,name),path.join(web,name));
  }
  fs.cpSync(path.join(root,'node_modules/@matrix-org/matrix-sdk-crypto-wasm'),path.join(web,'vendor'),{recursive:true});
  fs.copyFileSync(path.join(__dirname,'fixtures/encrypted-task-client.html'),path.join(web,'index.html'));
  fs.copyFileSync(path.join(__dirname,'fixtures/encrypted-task-client.mjs'),path.join(web,'fixture.mjs'));
  hub=new Hub({dbFile:path.join(tmp,'relay.sqlite'),staticDir:web});const addr=await hub.listen();const url='http://127.0.0.1:'+addr.port;
  keyRelay=new ExperimentRelay(path.join(tmp,'keys.sqlite'));await keyRelay.listen();
  const user=hub.store.createAccount('browser fixture'),team=hub.store.createTeam('fixture',user.id);
  const project=path.join(tmp,'project');fs.mkdirSync(project);
  runtime=new Runtime({hubUrl:url.replace('http','ws'),userName:'host',dataDir:path.join(tmp,'runtime'),projects:[project],encryptedTasksOnly:true});await runtime.start();
  await waitFor(()=>hub.pendingPairings.size);
  socket=new WebSocket(url.replace('http','ws'));let welcome=false;
  socket.onopen=()=>socket.send(JSON.stringify({type:'hello',token:user.token}));
  socket.onmessage=({data})=>{if(JSON.parse(data).type==='welcome')welcome=true;};
  await waitFor(()=>welcome);
  socket.send(JSON.stringify({type:'runtime/pair',teamId:team.id,code:runtime.pairingCode}));
  await waitFor(()=>runtime.teamId===team.id);
  host=await Endpoint.create({user:matrixUser(runtime.id),device:'HOST',transport:new HttpKeyTransport(keyRelay.enroll(matrixUser(runtime.id),'HOST'))});
  const task={version:1,id:newId('et'),teamId:team.id,runtimeId:runtime.id,projectId:newId('ep'),creatorUserId:user.id};
  const cfg={endpoint:{user:matrixUser(user.id),device:'BROWSER',storeName:'fixture',storeKey:[...randomBytes(32)],transport:keyRelay.enroll(matrixUser(user.id),'BROWSER')},token:user.token,task,writer:host.identity()};
  const launch=async()=>{
    browser=await chromium.launchPersistentContext(path.join(tmp,'profile'),{executablePath:process.env.CHROMIUM_PATH||undefined,headless:true});
    const page=browser.pages()[0];await page.goto(url);await page.waitForFunction(()=>globalThis.fixture);
    const identity=await page.evaluate(c=>fixture.init(c),cfg);return {page,identity};
  };
  let {page,identity}=await launch();
  await page.evaluate(teamId=>fixture.bootstrap(teamId),team.id);
  await page.evaluate(id=>fixture.confirm(id),host.identity());
  await host.confirmEndpoint(identity,{confirmed:true});await host.confirmEndpoint(host.identity(),{confirmed:true});
  const secret='BROWSER_PRIVATE_'+randomBytes(16).toString('hex');
  const payload={title:secret+' title',objective:secret+' objective',fixture:{plan:secret+' plan',path:secret+'/file',result:secret+' result',diff:secret+' diff',activity:secret+' activity',answer:secret+' answer'}};
  const created=await page.evaluate(value=>fixture.create(value),payload);
  state=new EncryptedTaskState(path.join(tmp,'outbox.sqlite'));
  const transport=new EncryptedTaskTransport({url,token:runtime.runtimeToken,runtimeId:runtime.id});
  const adapter=new EncryptedFixtureHost({runtime,endpoint:host,transport,state,projects:new Map([[task.projectId,project]]),creators:new Map([[user.id,identity]])});
  const opened=await adapter.open(created.task);const events=fixtureEvents(opened.objective);
  await page.evaluate(()=>fixture.receiveKeys());
  await opened.writer.append(events[0],fixtureEventId(task.id,0));
  let view=await page.evaluate(()=>fixture.reconnect());assert.equal(view.title,payload.title);assert.equal(view.seq,1);
  await page.evaluate(()=>fixture.close());await browser.close();browser=null;
  for(let i=1;i<events.length;i++)await opened.writer.append(events[i],fixtureEventId(task.id,i));
  const relaunched=await launch();page=relaunched.page;assert.deepEqual(relaunched.identity,identity);
  view=await page.evaluate(()=>fixture.reconnect());assert.equal(view.seq,8);assert.deepEqual(view.events,events);
  assert.match(await page.textContent('#status'),/caught-up/);assert.ok((await page.textContent('#task')).includes(payload.fixture.diff));
  console.log('PASS browser IndexedDB restart reconstructs the entire task, including events written while disconnected');

  const original=await page.textContent('#task');
  await page.route('**/api/encrypted-tasks/**/events?*',async route=>{
    const response=await route.fetch();const body=await response.json();body.head=0;body.nextSeq=0;body.events=[];
    await route.fulfill({response,json:body});
  });
  const refused=await page.evaluate(()=>fixture.reconnect());assert.equal(refused.error,'history_rollback');
  assert.match(await page.textContent('#status'),/error: history_rollback/);
  assert.equal(await page.textContent('#task'),original);
  await page.unrouteAll();
  view=await page.evaluate(()=>fixture.reconnect());assert.equal(view.seq,8);
  console.log('PASS browser displays rollback failure and preserves rendered history, then recovers on a valid reconnect');

  const dump=JSON.stringify({task:hub.encryptedTasks.get(task.id),events:await transport.page(task.id),keyRelay:keyRelay.evidence()});
  assert.ok(!dump.includes(secret));
  for(const file of['relay.sqlite','relay.sqlite-wal','keys.sqlite','keys.sqlite-wal']){
    const target=path.join(tmp,file);if(fs.existsSync(target))assert.ok(!fs.readFileSync(target).includes(Buffer.from(secret)));
  }
  const out=path.join(root,'.artifacts/encrypted-task');fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:path.join(out,'browser-fixture.png')});
  // Persist only pass/fail facts, not the canary-bearing snapshot or screenshot.
  fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify({ranAt:new Date().toISOString(),browser:await page.evaluate(()=>navigator.userAgent),checks:3,status:'pass'},null,2));
  console.log('PASS browser-to-host content is absent from task/key relay storage');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{socket?.close();if(browser)await browser.close();runtime?.stop();host?.close();state?.close();if(hub)await hub.close();if(keyRelay)await keyRelay.close();});
