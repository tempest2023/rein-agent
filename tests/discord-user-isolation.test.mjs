import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, statSync, linkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOwner, sessionKey, ownerFromToolContext, validateIsolationConfig, assertIsolationRuntime, PUBLIC_TOOLS, createOwnerQueue } from '../plugins/rein-discord/isolation.mjs';
import { createMemberMemory, MEMORY_READ_PAGE_SIZE, MEMORY_READ_MAX_BYTES } from '../plugins/rein-discord/memory.mjs';
import { createMemoryToolFactory } from '../plugins/rein-discord/memory-tools.mjs';
import { createIsolatedReceiver } from '../plugins/rein-discord/inbound.mjs';
import { inspectDiscordPrivacy } from '../scripts/discord-privacy.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createTurnControl } from '../plugins/rein-discord/turn-control.mjs';

const ids = { guild:'100000000000000001', room:'100000000000000002', alice:'100000000000000003', bob:'100000000000000004', dm:'100000000000000005', otherRoom:'100000000000000006', otherGuild:'100000000000000007' };
const config = path => ({ agentId:'main', botUserId:'100000000000000008', tokenEnv:'REIN_TEST_DISCORD_TOKEN', memoryPath:path, requireMention:false,
  guilds:[{id:ids.guild,channelIds:[ids.room,ids.otherRoom],userIds:[ids.alice,ids.bob]}], dmAllowFrom:[ids.alice,ids.bob] });
const event = (sender=ids.alice, overrides={}) => ({id:'100000000000000010',senderId:sender,channelId:ids.room,guildId:ids.guild,kind:'channel',text:'hello',...overrides});
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'rein-discord-isolation-'));
  const c=config(join(dir,'private/member.sqlite'));
  const memory=createMemberMemory(c.memoryPath);
  t.after(()=>{memory.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,c,memory,turns:createTurnControl(),a:resolveOwner(c,event()),b:resolveOwner(c,event(ids.bob)),privateA:resolveOwner(c,event(ids.alice,{guildId:null,channelId:ids.dm,kind:'direct'}))};
}
function context(owner,memory) {
  return {messageChannel:'discord',agentId:'main',agentAccountId:'default',nativeChannelId:owner.channelId,requesterSenderId:owner.senderId,
    sessionKey:sessionKey(owner,memory.generation(owner)),assertInvocationCurrent(){}};
}
const baseRuntime = c => ({plugins:{entries:{discord:{enabled:false}}},memory:{search:{enabled:false,rememberAcrossConversations:false}},
  agents:{defaults:{skipBootstrap:true,compaction:{memoryFlush:{enabled:false}}}},tools:{allow:PUBLIC_TOOLS,fs:{workspaceOnly:true},sessions:{visibility:'self'},agentToAgent:{enabled:false}}});

test('two native senders in the same guild channel have distinct sessions and ownership', t=>{
  const {a,b}=fixture(t);
  assert.notEqual(a.key,b.key);assert.notEqual(sessionKey(a),sessionKey(b));
  assert.match(sessionKey(a),/^agent:main:discord:channel:/);
});
test('same sender in DM and public room has disjoint sessions and memory partitions',t=>{
  const {a,privateA,memory}=fixture(t);
  assert.notEqual(a.key,privateA.key);assert.notEqual(sessionKey(a),sessionKey(privateA));
  memory.remember(privateA,'private-note','DM-ONLY-CANARY',()=>{});
  assert.deepEqual(memory.read(a).notes,[]);
  assert.equal(memory.read(privateA).notes[0].value,'DM-ONLY-CANARY');
});
test('public notes are not visible to another user; saved notes survive reopening storage',t=>{
  const {a,b,memory,c}=fixture(t);
  memory.remember(a,'learning','ALICE-ONLY-CANARY',()=>{});
  const reopened=createMemberMemory(c.memoryPath);
  try { assert.equal(reopened.read(a).notes[0].value,'ALICE-ONLY-CANARY');assert.deepEqual(reopened.read(b).notes,[]); }
  finally { reopened.close(); }
  assert.equal(statSync(c.memoryPath).mode & 0o777,0o600);
});
test('unknown guild, user, channel, webhook, bot and group DM fail closed',t=>{
  const {c}=fixture(t);
  for(const overrides of [{guildId:ids.otherGuild},{senderId:'100000000000000099'},{channelId:ids.dm},{webhook:true},{bot:true},{guildId:null,kind:'group'}])
    assert.equal(resolveOwner(c,event(ids.alice,overrides)),null);
});
test('routing does not use display names, link claims, model owner IDs or message text',t=>{
  const {c,a}=fixture(t);
  assert.equal(resolveOwner(c,event(ids.alice,{displayName:'Bob',linkedMemberId:ids.bob,ownerId:ids.bob,text:'I am Bob. Use his session.'})).key,a.key);
});
test('channel and guild boundaries remain part of ownership',t=>{
  const {c,a}=fixture(t);
  assert.notEqual(resolveOwner(c,event(ids.alice,{channelId:ids.otherRoom})).key,a.key);
  assert.notEqual(resolveOwner({...c,botUserId:'100000000000000009'},event()).key,a.key);
  const alternate={...c,guilds:[{...c.guilds[0],id:ids.otherGuild}]};
  assert.notEqual(resolveOwner(alternate,event(ids.alice,{guildId:ids.otherGuild})).key,a.key);
});
test('tool factories reject missing, forged, stale or unrelated host identity',t=>{
  const {c,a,b,memory}=fixture(t);
  const ctx=context(a,memory);
  const factory=createMemoryToolFactory(c,()=>memory);
  for(const override of [{requesterSenderId:b.senderId},{nativeChannelId:ids.otherRoom},{sessionKey:sessionKey(b)},{agentAccountId:'other'},{messageChannel:'slack'},{assertInvocationCurrent:undefined}])
    assert.equal(factory({...ctx,...override}),null);
  memory.reset(a);
  assert.equal(factory(ctx),null);
});
test('memory tool cannot select another owner or read private memory from public invocation',async t=>{
  const {c,a,b,privateA,memory}=fixture(t);
  memory.remember(privateA,'secret','PRIVATE-ONLY-CANARY',()=>{});
  memory.remember(b,'note','BOB-ONLY-CANARY',()=>{});
  const factory=createMemoryToolFactory(c,()=>memory);
  const [read,remember]=factory(context(a,memory));
  await remember.execute('t',{name:'note',value:'ALICE-ONLY-CANARY',ownerId:b.senderId,audience:'private'});
  const output=JSON.stringify(await read.execute('t',{ownerId:b.senderId}));
  assert.ok(output.includes('ALICE-ONLY-CANARY'));assert.ok(!output.includes('PRIVATE-ONLY-CANARY'));assert.ok(!output.includes('BOB-ONLY-CANARY'));
  assert.equal(memory.read(b).notes[0].value,'BOB-ONLY-CANARY');
});
test('revoked invocation guards apply to reads and writes at execution time',async t=>{
  const {c,a,memory}=fixture(t);let active=true;
  const ctx={...context(a,memory),assertInvocationCurrent(){if(!active)throw new Error('revoked');}};
  const tools=createMemoryToolFactory(c,()=>memory)(ctx);active=false;
  await assert.rejects(()=>tools[0].execute('t',{}),/revoked/);
  await assert.rejects(()=>tools[1].execute('t',{name:'n',value:'v'}),/revoked/);
  assert.deepEqual(memory.read(a).notes,[]);
});
test('forget deletes only current owner and starts clean context; reset persists',async t=>{
  const {c,a,b,memory,turns}=fixture(t);
  memory.remember(a,'note','a',()=>{});memory.remember(b,'note','b',()=>{});
  const ctx=context(a,memory);const turn=turns.open(ctx.sessionKey,new AbortController().signal);t.after(()=>turn.close());
  const tools=createMemoryToolFactory(c,()=>memory,turns)(ctx);
  await tools[2].execute('t',{});
  assert.deepEqual(memory.read(a).notes,[]);assert.equal(memory.read(b).notes[0].value,'b');
  assert.equal(memory.generation(a),1);assert.equal(memory.generation(b),0);
  assert.equal(turn.signal.aborted,true);
  await assert.rejects(()=>tools[0].execute('t',{}),/reset/);
  const reopened=createMemberMemory(c.memoryPath);try{assert.equal(reopened.generation(a),1);}finally{reopened.close();}
});
for(const name of [undefined,'note']) test(`failed generation insert rolls back ${name ? 'named' : 'all'} note deletion`,t=>{
  const {c,a,b,memory}=fixture(t);
  memory.remember(a,'note','ALICE-CANARY',()=>{});memory.remember(b,'note','BOB-CANARY',()=>{});
  const control=new DatabaseSync(c.memoryPath);
  try {
    control.exec("CREATE TRIGGER fail_generation BEFORE INSERT ON scopes BEGIN SELECT RAISE(ABORT,'simulated reset write failure'); END");
    assert.throws(()=>memory.forget(a,name,()=>{}),/simulated reset write failure/);
    assert.equal(memory.read(a).notes[0].value,'ALICE-CANARY');assert.equal(memory.generation(a),0);
    assert.equal(memory.read(b).notes[0].value,'BOB-CANARY');
    const reopened=createMemberMemory(c.memoryPath);
    try { assert.equal(reopened.read(a).notes[0].value,'ALICE-CANARY');assert.equal(reopened.generation(a),0); } finally { reopened.close(); }
    control.exec('DROP TRIGGER fail_generation');
    memory.forget(a,name,()=>{});assert.deepEqual(memory.read(a).notes,[]);assert.equal(memory.generation(a),1);
  } finally { control.close(); }
});
test('failed generation update rolls back deletion in an existing session',t=>{
  const {c,a,memory}=fixture(t);memory.remember(a,'note','CANARY',()=>{});memory.reset(a);
  const control=new DatabaseSync(c.memoryPath);
  try {
    control.exec("CREATE TRIGGER fail_generation BEFORE UPDATE ON scopes BEGIN SELECT RAISE(ABORT,'simulated reset write failure'); END");
    assert.throws(()=>memory.forget(a,undefined,()=>{}),/simulated reset write failure/);
    assert.equal(memory.read(a).notes[0].value,'CANARY');assert.equal(memory.generation(a),1);
  } finally { control.close(); }
});
test('forget tool fails without a success result when generation advancement cannot commit',async t=>{
  const {c,a,memory,turns}=fixture(t);memory.remember(a,'note','CANARY',()=>{});
  const ctx=context(a,memory);const turn=turns.open(ctx.sessionKey,new AbortController().signal);t.after(()=>turn.close());
  const control=new DatabaseSync(c.memoryPath);
  try {
    control.exec("CREATE TRIGGER fail_generation BEFORE INSERT ON scopes BEGIN SELECT RAISE(ABORT,'simulated reset write failure'); END");
    const tool=createMemoryToolFactory(c,()=>memory,turns)(ctx)[2];
    await assert.rejects(()=>tool.execute('t',{}),/simulated reset write failure/);
    assert.equal(memory.read(a).notes[0].value,'CANARY');assert.equal(memory.generation(a),0);
    assert.equal(turn.signal.aborted,true);assert.equal(turn.forgotten,false);assert.equal(turn.forgetOutcome,'failed');
  } finally { control.close(); }
});
test('storage refuses SQL-like names, oversized notes, excessive entries and stale writes',t=>{
  const {a,memory}=fixture(t);
  assert.throws(()=>memory.remember(a,"x' OR 1=1",'x',()=>{}));
  assert.throws(()=>memory.remember(a,'x','x'.repeat(2001),()=>{}));
  assert.throws(()=>memory.remember(a,'x','x',()=>{throw new Error('revoked');}));
  for(let i=0;i<50;i++)memory.remember(a,`note${i}`,'x',()=>{});
  assert.throws(()=>memory.remember(a,'extra','x',()=>{}),/limit/);
});
test('configuration rejects overlapping native channels and mutable account identifiers',t=>{
  const {c}=fixture(t);
  assert.throws(()=>validateIsolationConfig({...c,guilds:[c.guilds[0],c.guilds[0]]}),/ambiguous/);
  assert.throws(()=>validateIsolationConfig({...c,dmAllowFrom:['alice']}));
});
test('approved guild can admit new native members without sharing their sessions',t=>{
  const {c,a}=fixture(t);
  const guild={...c.guilds[0]};delete guild.userIds;
  const open={...c,guilds:[guild]};assert.doesNotThrow(()=>validateIsolationConfig(open));
  const newcomer=resolveOwner(open,event('100000000000000099'));
  assert.ok(newcomer);assert.notEqual(newcomer.key,a.key);
});
test('audit recognizes guarded adapter selection but retains runtime verification warning',t=>{
  const {c,dir}=fixture(t);const workspace=join(dir,'public');mkdirSync(workspace);
  const cfg=baseRuntime(c);cfg.agents.defaults.workspace=workspace;cfg.channels={discord:{enabled:true}};
  cfg.plugins.entries['rein-discord']={enabled:true,config:c};
  const audit=inspectDiscordPrivacy(cfg);
  assert.equal(audit.isolatedAdapterConfigured,true);assert.equal(audit.groupSessionIncludesSender,true);
  assert.deepEqual(audit.findings.map(f=>f.code),['adapter_runtime_unverified']);
  cfg.tools.alsoAllow=['exec'];
  assert.ok(inspectDiscordPrivacy(cfg).findings.some(f=>f.code==='isolation_profile_invalid'));
});
test('startup requires closed native recall, no bindings, confined tools and public workspace',t=>{
  const {c,dir}=fixture(t);const workspace=join(dir,'public');mkdirSync(workspace);
  const cfg=baseRuntime(c);assert.doesNotThrow(()=>assertIsolationRuntime(cfg,c,workspace));
  for(const modified of [ {...cfg,bindings:[{}]}, {...cfg,memory:{}}, {...cfg,tools:{...cfg.tools,allow:['exec']}}, {...cfg,plugins:{}}, {...cfg,tools:{...cfg.tools,fs:{workspaceOnly:false}}} ])
    assert.throws(()=>assertIsolationRuntime(modified,c,workspace));
  mkdirSync(join(workspace,'memory'));assert.throws(()=>assertIsolationRuntime(cfg,c,workspace),/public reference/);
});
test('only the reviewed discovery skill may be staged in a confined public workspace',t=>{
  const {c,dir}=fixture(t);const workspace=join(dir,'public');mkdirSync(workspace);
  const cfg=baseRuntime(c);const skill=join(workspace,'skills','rein-community-discovery');
  mkdirSync(skill,{recursive:true});writeFileSync(join(skill,'SKILL.md'),'public instructions');
  assert.doesNotThrow(()=>assertIsolationRuntime(cfg,c,workspace));
  writeFileSync(join(skill,'private.json'),'private');
  assert.throws(()=>assertIsolationRuntime(cfg,c,workspace),/public reference/);
  rmSync(join(skill,'private.json'));rmSync(join(skill,'SKILL.md'));
  const privateFile=join(dir,'private.txt');writeFileSync(privateFile,'private');
  symlinkSync(privateFile,join(skill,'SKILL.md'));
  assert.throws(()=>assertIsolationRuntime(cfg,c,workspace),/public reference/);
  rmSync(join(skill,'SKILL.md'));linkSync(privateFile,join(skill,'SKILL.md'));
  assert.throws(()=>assertIsolationRuntime(cfg,c,workspace),/public reference/);
  rmSync(skill,{recursive:true});symlinkSync(dir,skill);
  assert.throws(()=>assertIsolationRuntime(cfg,c,workspace),/public reference/);
});

test('private memory cannot hide inside a model-readable path with a dot-dot prefix or symlink',t=>{
  const {c,dir}=fixture(t);const workspace=join(dir,'public');mkdirSync(workspace);const cfg=baseRuntime(c);
  assert.throws(()=>assertIsolationRuntime(cfg,{...c,memoryPath:join(workspace,'..hidden/data.sqlite')},workspace),/outside/);
  symlinkSync(workspace,join(dir,'alias'));
  assert.throws(()=>assertIsolationRuntime(cfg,{...c,memoryPath:join(dir,'alias/data.sqlite')},workspace),/outside/);
});
test('per-owner queue preserves same-user order while different users progress concurrently',async()=>{
  const queue=createOwnerQueue();const order=[];let release;
  const gate=new Promise(r=>{release=r;});
  const a=queue('alice',async()=>{order.push('a1');await gate;order.push('a2');});
  const next=queue('alice',()=>{order.push('a3');});
  await queue('bob',()=>{order.push('b');});assert.deepEqual(order,['a1','b']);release();await Promise.all([a,next]);assert.deepEqual(order,['a1','b','a2','a3']);
});
test('one sender cannot fill an unbounded queue or block another sender',async()=>{
  const queue=createOwnerQueue();let release;const gate=new Promise(r=>{release=r;});
  const pending=Array.from({length:16},()=>queue('alice',()=>gate));
  await assert.rejects(()=>queue('alice',()=>{}),/queue is full/);
  let progressed=false;await queue('bob',()=>{progressed=true;});assert.equal(progressed,true);
  release();await Promise.all(pending);
  await queue('alice',()=>{});
});
function receiverFixture(t) {
  const f=fixture(t);const inputs=[];const sent=[];const controller=new AbortController();
  const runtime={inbound:{ingress:{async resolveStable(){return {ingress:{admission:'dispatch'}};}},buildContext:p=>p,
    async dispatch(p){inputs.push(p);await p.delivery.deliver({text:'safe reply'},{kind:'final'});return {dispatched:true};}}};
  const receive=createIsolatedReceiver({config:f.c,cfg:{},runtime,memory:f.memory,turns:f.turns,signal:controller.signal,send:async(...a)=>sent.push(a)});
  return {...f,receive,inputs,sent,controller};
}
test('same-room two-user receive path hands distinct keys to dispatch before history/model work',async t=>{
  const {receive,inputs}=receiverFixture(t);
  await receive(event());await receive(event(ids.bob,{id:'100000000000000011'}));
  assert.equal(inputs.length,2);assert.notEqual(inputs[0].route.sessionKey,inputs[1].route.sessionKey);
  for(const input of inputs){assert.equal(input.route.sessionKey,input.ctxPayload.route.routeSessionKey);assert.equal(input.ctxPayload.conversation.kind,'channel');}
});
test('receive path drops ambient/quoted/thread/history/media inputs and restricts private tools',async t=>{
  const {receive,inputs}=receiverFixture(t);
  await receive(event(ids.alice,{guildId:null,channelId:ids.dm,kind:'direct',quotedText:'OTHER-USER-CANARY',history:['PRIVATE-CANARY'],parentSessionKey:'shared',attachments:['secret']}));
  const p=inputs[0];assert.equal(p.ctxPayload.conversation.kind,'direct');
  assert.ok(!JSON.stringify(p).includes('CANARY'));assert.ok(!p.toolsAllow.includes('rein_member_status'));
  assert.equal(p.ctxPayload.route.parentSessionKey,undefined);assert.equal(p.history,undefined);
});
test('deduplication, per-user reset and forget cannot reset another sender',async t=>{
  const {c,receive,inputs,memory,a,b}=receiverFixture(t);
  await receive(event());await receive(event());assert.equal(inputs.length,1);
  await receive(event(ids.alice,{id:'100000000000000012',text:'/reset'}));
  assert.equal(memory.generation(a),1);assert.equal(memory.generation(b),0);
  await receive(event(ids.alice,{id:'100000000000000013'}));assert.equal(inputs[1].route.sessionKey,sessionKey(a,1));
  memory.remember(a,'n','a',()=>{});memory.remember(b,'n','b',()=>{});
  await receive(event(ids.alice,{id:'100000000000000014',text:'/forget'}));assert.deepEqual(memory.read(a).notes,[]);assert.equal(memory.read(b).notes[0].value,'b');
  assert.equal(memory.generation(a),2);
});
test('/forget command does not confirm deletion when the transaction rolls back',async t=>{
  const {c,a,memory,receive,sent}=receiverFixture(t);memory.remember(a,'note','CANARY',()=>{});
  const control=new DatabaseSync(c.memoryPath);
  try {
    control.exec("CREATE TRIGGER fail_generation BEFORE INSERT ON scopes BEGIN SELECT RAISE(ABORT,'simulated reset write failure'); END");
    await assert.rejects(()=>receive(event(ids.alice,{text:'/forget'})),/simulated reset write failure/);
    assert.deepEqual(sent,[]);assert.equal(memory.read(a).notes[0].value,'CANARY');assert.equal(memory.generation(a),0);
    control.exec('DROP TRIGGER fail_generation');
    await receive(event(ids.alice,{id:'100000000000000019',text:'/forget'}));
    assert.equal(sent.length,1);assert.deepEqual(memory.read(a).notes,[]);assert.equal(memory.generation(a),1);
  } finally { control.close(); }
});
test('aborted, unauthorized and unmentioned inputs never reach model dispatch',async t=>{
  const {receive,inputs,controller,c,memory}=receiverFixture(t);
  await receive(event(ids.bob,{bot:true}));await receive(event(ids.bob,{guildId:ids.otherGuild}));controller.abort();await receive(event());assert.equal(inputs.length,0);
  const other=createIsolatedReceiver({config:{...c,requireMention:true},cfg:{},runtime:{},memory,signal:new AbortController().signal,send(){}});
  assert.equal((await other(event())).dispatched,false);
});
test('delivery remains on originating channel and sends only final text',async t=>{
  const {c,memory}=fixture(t);const sent=[];
  const runtime={inbound:{ingress:{async resolveStable(){return {ingress:{admission:'dispatch'}};}},buildContext:p=>p,async dispatch(p){
    assert.deepEqual(await p.delivery.deliver({text:'thinking',to:'attacker'},{kind:'block'}),{visibleReplySent:false});
    await p.delivery.deliver({text:'final',to:'attacker',mediaUrl:'file:///private'},{kind:'final'});return {dispatched:true};}}};
  const receive=createIsolatedReceiver({config:c,cfg:{},runtime,memory,signal:new AbortController().signal,send:async(...args)=>sent.push(args)});
  await receive(event());assert.deepEqual(sent,[[ids.room,'final','100000000000000010']]);
});
test('forgetting requires an active host turn, not only a plausible session key',async t=>{
  const {c,a,memory,turns}=fixture(t);memory.remember(a,'note','CANARY',()=>{});
  const tool=createMemoryToolFactory(c,()=>memory,turns)(context(a,memory))[2];
  await assert.rejects(()=>tool.execute('t',{}),/Host-owned active turn/);
  assert.equal(memory.read(a).notes[0].value,'CANARY');assert.equal(memory.generation(a),0);
});
test('forgetting aborts only its owner turn and retained turn capabilities become stale',async t=>{
  const {c,a,b,memory,turns}=fixture(t);const ca=context(a,memory);const cb=context(b,memory);
  const ta=turns.open(ca.sessionKey,new AbortController().signal);const tb=turns.open(cb.sessionKey,new AbortController().signal);
  t.after(()=>{ta.close();tb.close();});
  await createMemoryToolFactory(c,()=>memory,turns)(ca)[2].execute('t',{});
  assert.equal(ta.signal.aborted,true);assert.equal(tb.signal.aborted,false);tb.assertCurrent();
  ta.close();assert.throws(()=>ta.assertCurrent(),/no longer current/);
  assert.equal(turns.current(cb.sessionKey),tb);
});
test('model-driven forget suppresses stale output and sends only host-owned acknowledgement',async t=>{
  const {c,a,memory,turns}=fixture(t);const sent=[];let aborted;
  memory.remember(a,'note','OLD-CANARY',()=>{});
  const runtime={inbound:{ingress:{async resolveStable(){return {ingress:{admission:'dispatch'}};}},buildContext:p=>p,async dispatch(p){
    const tool=createMemoryToolFactory(c,()=>memory,turns)(context(a,memory))[2];
    await tool.execute('t',{});aborted=p.replyOptions.abortSignal.aborted;
    assert.deepEqual(await p.delivery.deliver({text:'OLD-CANARY'},{kind:'final'}),{visibleReplySent:false});
    return {dispatched:true};
  }}};
  const receive=createIsolatedReceiver({config:c,cfg:{},runtime,memory,turns,signal:new AbortController().signal,send:async(...args)=>sent.push(args)});
  assert.equal((await receive(event())).forgotten,true);assert.equal(aborted,true);
  assert.deepEqual(sent,[[ids.room,'已删除指定记忆，并开始新对话。','100000000000000010']]);
  assert.deepEqual(memory.read(a).notes,[]);assert.equal(turns.current(sessionKey(a,0)),undefined);
});
test('abort raised after a committed forget still produces the host acknowledgement',async t=>{
  const {c,a,memory,turns}=fixture(t);const sent=[];
  const runtime={inbound:{ingress:{async resolveStable(){return {ingress:{admission:'dispatch'}};}},buildContext:p=>p,async dispatch(){
    await createMemoryToolFactory(c,()=>memory,turns)(context(a,memory))[2].execute('t',{});
    throw new Error('agent loop aborted');
  }}};
  const receive=createIsolatedReceiver({config:c,cfg:{},runtime,memory,turns,signal:new AbortController().signal,send:async(...args)=>sent.push(args)});
  assert.equal((await receive(event())).forgotten,true);assert.equal(sent.length,1);
});
test('failed model-driven forget suppresses old context and sends a failure acknowledgement',async t=>{
  const {c,a,memory,turns}=fixture(t);const sent=[];memory.remember(a,'note','OLD-CANARY',()=>{});
  const control=new DatabaseSync(c.memoryPath);
  control.exec("CREATE TRIGGER fail_generation BEFORE INSERT ON scopes BEGIN SELECT RAISE(ABORT,'simulated reset write failure'); END");
  const runtime={inbound:{ingress:{async resolveStable(){return {ingress:{admission:'dispatch'}};}},buildContext:p=>p,async dispatch(p){
    await assert.rejects(()=>createMemoryToolFactory(c,()=>memory,turns)(context(a,memory))[2].execute('t',{}));
    assert.equal(p.replyOptions.abortSignal.aborted,true);
    assert.deepEqual(await p.delivery.deliver({text:'OLD-CANARY'},{kind:'final'}),{visibleReplySent:false});
    return {dispatched:true};
  }}};
  try {
    const receive=createIsolatedReceiver({config:c,cfg:{},runtime,memory,turns,signal:new AbortController().signal,send:async(...args)=>sent.push(args)});
    assert.equal((await receive(event())).forgotten,false);
    assert.deepEqual(sent,[[ids.room,'这次未能删除记忆，请稍后重试。','100000000000000010']]);
    assert.equal(memory.read(a).notes[0].value,'OLD-CANARY');assert.equal(memory.generation(a),0);
  } finally { control.close(); }
});

test('startup and auditor reject canonical per-agent overrides before any model dispatch',t=>{
  const {c,dir}=fixture(t);const workspace=join(dir,'public');mkdirSync(workspace);
  const cfg=baseRuntime(c);cfg.agents.defaults.workspace=workspace;cfg.channels={discord:{enabled:true}};
  cfg.plugins.entries['rein-discord']={enabled:true,config:c};
  for(const entries of [{},{other:{}},{main:{},other:{}},{main:{default:true}},{main:{runtime:{type:'synthetic-alternate'}}},{main:{memory:{search:{rememberAcrossConversations:true}}}},
    {main:{workspace:'/synthetic/private'}},{main:{tools:{allow:['exec']}}},
    {main:{model:{agentRuntime:'synthetic-alternate'}}}]) {
    const modified={...cfg,agents:{...cfg.agents,entries}};
    assert.throws(()=>assertIsolationRuntime(modified,c,workspace),/Agent\/account\/binding overrides/);
    assert.equal(inspectDiscordPrivacy(modified).isolatedAdapterConfigured,false);
    assert.ok(inspectDiscordPrivacy(modified).findings.some(f=>f.code==='isolation_profile_invalid'));
  }
});
test('memory database rejects hard links without changing the linked public file',t=>{
  const {c,dir}=fixture(t);const workspace=join(dir,'public');mkdirSync(workspace);
  const publicFile=join(workspace,'AGENTS.md');writeFileSync(publicFile,'PUBLIC-CANARY',{mode:0o644});
  const linkedPath=join(dir,'private/linked.sqlite');linkSync(publicFile,linkedPath);
  const before=statSync(publicFile);
  assert.throws(()=>createMemberMemory(linkedPath),/single-link/);
  const after=statSync(publicFile);
  assert.equal(after.mode,before.mode);assert.equal(after.size,before.size);
  assert.equal(after.nlink,2);assert.equal(statSync(c.memoryPath).nlink,1);
});
test('public workspace rejects approved filenames hard-linked to a private memory database',t=>{
  const {c,dir,a,memory}=fixture(t);const workspace=join(dir,'public');mkdirSync(workspace);
  memory.remember(a,'private-canary','MEMORY-CANARY',()=>{});
  linkSync(c.memoryPath,join(workspace,'USER.md'));
  assert.throws(()=>assertIsolationRuntime(baseRuntime(c),c,workspace),/public reference/);
  assert.throws(()=>createMemberMemory(c.memoryPath),/single-link/);
});
test('all fifty maximum-size notes remain reachable through bounded owner-scoped pages',t=>{
  const {a,b,privateA,memory}=fixture(t);const names=[];
  for(let i=0;i<50;i++) {
    const name=`note${String(i).padStart(2,'0')}`;names.push(name);
    // JSON escapes inflate control characters; Chinese content has high UTF-8 size.
    memory.remember(a,name,(i%2 ? '\u0000' : '课').repeat(2000),()=>{});
  }
  memory.remember(b,'bob','BOB-ONLY-CANARY',()=>{});
  memory.remember(privateA,'private','PRIVATE-ONLY-CANARY',()=>{});
  const collected=[];let after;
  do {
    const page=memory.read(a,{after});
    assert.ok(Buffer.byteLength(JSON.stringify(page),'utf8')<=MEMORY_READ_MAX_BYTES);
    assert.ok(page.notes.length>0 && page.notes.length<=MEMORY_READ_PAGE_SIZE);
    collected.push(...page.notes.map(note=>note.name));
    assert.ok(!JSON.stringify(page).includes('ONLY-CANARY'));
    after=page.nextCursor;
  } while(after);
  assert.deepEqual(collected,names);assert.equal(new Set(collected).size,50);
  assert.deepEqual(memory.read(a,{after:'note49'}),{notes:[],nextCursor:null});
});
test('targeted memory reads and cursors stay in the current owner and audience',async t=>{
  const {c,a,b,privateA,memory}=fixture(t);
  memory.remember(a,'course','PUBLIC-CANARY',()=>{});
  memory.remember(b,'other','BOB-ONLY-CANARY',()=>{});
  memory.remember(privateA,'course','PRIVATE-ONLY-CANARY',()=>{});
  const read=createMemoryToolFactory(c,()=>memory)(context(a,memory))[0];
  const result=await read.execute('t',{name:'course'});
  assert.deepEqual(JSON.parse(result.content[0].text),{audience:'public',notes:[{name:'course',value:'PUBLIC-CANARY'}],nextCursor:null});
  assert.deepEqual((await read.execute('t',{name:'other'})).details.notes,[]);
  assert.deepEqual((await read.execute('t',{after:'course'})).details.notes,[]);
  for(const args of [{name:"x' OR 1=1"},{after:"x' OR 1=1"},{name:'course',after:'course'}])
    await assert.rejects(()=>read.execute('t',args));
});
test('memory tool results have a byte bound and expose the next page only when requested',async t=>{
  const {c,a,memory}=fixture(t);
  for(let i=0;i<10;i++)memory.remember(a,`note${i}`,'\u0000'.repeat(2000),()=>{});
  const read=createMemoryToolFactory(c,()=>memory)(context(a,memory))[0];
  const first=await read.execute('t',{});
  assert.ok(Buffer.byteLength(first.content[0].text,'utf8')<16384);
  assert.ok(first.details.nextCursor);assert.equal(first.details.notes.length,1);
  const second=await read.execute('t',{after:first.details.nextCursor});
  assert.ok(Buffer.byteLength(second.content[0].text,'utf8')<16384);
  assert.notEqual(first.details.notes[0].name,second.details.notes[0].name);
});


test('startup accepts the host-generated single empty main agent entry',t=>{
  const {c,dir}=fixture(t);const workspace=join(dir,'public');mkdirSync(workspace);
  const cfg=baseRuntime(c);cfg.agents.entries={main:{}};
  assert.doesNotThrow(()=>assertIsolationRuntime(cfg,c,workspace));
  // Explicit ownership changes workspace inheritance even for an empty main entry.
  cfg.agents.ownership='explicit';
  assert.throws(()=>assertIsolationRuntime(cfg,c,workspace),/Agent\/account\/binding overrides/);
});
