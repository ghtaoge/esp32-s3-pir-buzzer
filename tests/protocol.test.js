const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../miniprogram/utils/protocol');
const turn = () => new Promise(resolve => setImmediate(resolve));

test('UTF-8 round-trips Chinese and astral characters without platform codecs', () => {
  const text = '人体感应 · café · 🛰️\u0000';
  assert.equal(P.utf8Decode(P.utf8Encode(text)), text);
  for (const bytes of [[0xc0,0x80],[0xed,0xa0,0x80],[0xf4,0x90,0x80,0x80],[0xe4,0xb8],[0x80],[0xe2,0x28,0xa1]])
    assert.throws(() => P.utf8Decode(Uint8Array.from(bytes)), /UTF-8/);
  assert.equal(P.utf8Decode(P.utf8Encode('\ud800')), '\ufffd');
});

test('all byte boundaries including multibyte splits and multiple frames decode', () => {
  const message = {event:'log',data:{message:'有人移动🛰️'}};
  const bytes = P.encodeFrame(message);
  for (let cut = 0; cut <= bytes.length; cut++) {
    const decoder = new P.LineDecoder();
    assert.deepEqual([...decoder.push(bytes.slice(0,cut)),...decoder.push(bytes.slice(cut))], [message]);
  }
  const decoder = new P.LineDecoder();
  const input = P.utf8Encode('\r\n{"id":1}\r\n{"id":2}\n');
  assert.deepEqual(decoder.push(input), [{id:1},{id:2}]);
});

test('oversize/malformed frames are discarded through LF and buffer stays bounded', () => {
  const errors = [], decoder = new P.LineDecoder({maxBytes:64,onError:e => errors.push(e)});
  const good = P.encodeFrame({id:2});
  assert.equal(decoder.push(new Uint8Array(100000).fill(65)).length,0);
  assert.equal(decoder.buffer.length,64);
  assert.equal(decoder.used,0);
  assert.deepEqual(decoder.push(P.utf8Encode('\n{"id":2}\n')), [{id:2}]);
  assert.deepEqual(decoder.push(P.utf8Encode('[]\nnull\ninvalid\n')), []);
  assert.equal(errors.length,4);
  assert.deepEqual(decoder.push(good), [{id:2}]);
  assert.throws(() => P.encodeFrame({text:'a'.repeat(2048)}), /exceeds/);
  const exact = new P.LineDecoder({maxBytes:8});
  assert.deepEqual(exact.push(P.utf8Encode('{"x":1}\n')), [{x:1}]);
});

test('config validation is strict, atomic, and leaves defaults unchanged', () => {
  for (const patch of [null, [], {beepMs:'3000'}, {beepMs:1.5}, {armed:1}, {sensor:'other'}, {buzzerMode:'other'}, {sound:'speech'}, {sound:1}, {wat:1}, {releaseMs:49}, {toneHz:Infinity}, JSON.parse('{"__proto__":{}}')])
    assert.throws(() => P.validateConfig(patch));
  const merged = P.validateConfig({sensor:'pir',beepMs:100,activeLow:true});
  assert.equal(merged.beepMs,100); assert.equal(merged.cooldownMs,1000);
  assert.equal(P.DEFAULT_CONFIG.beepMs,3000);
  assert.deepEqual(P.validateConfig({}),P.DEFAULT_CONFIG);
  for(const sound of ['single','double','chime','siren']) assert.equal(P.validateConfig({sound}).sound,sound);
  assert.throws(()=>P.validateConfig({sensor:'radar'}),/Invalid sensor/);
  for(const key of ['radarMaxGate','radarMotionThreshold','radarStillThreshold'])
    assert.throws(()=>P.validateConfig({[key]:P.DEFAULT_CONFIG[key]}),/HC-SR505/);
});

test('RPC serializes full writes, correlates ACKs and routes notifications', async () => {
  const writes=[], events=[];
  const client = new P.RpcClient({write:bytes=>{writes.push(JSON.parse(P.utf8Decode(bytes)));},onEvent:(e,d)=>events.push([e,d])});
  const first=client.request('get'), second=client.request('logs',{after:0,limit:5});
  await turn(); assert.equal(writes.length,1);
  client.receive(P.encodeFrame({id:99,session:client.session,ok:true,data:{wrong:true}}));
  client.receive(P.encodeFrame({event:'state',data:{motion:true}}));
  for(const chunk of P.chunkBytes(P.encodeFrame({id:writes[0].id,session:client.session,ok:true,data:{deviceId:'abc'}}),3)) client.receive(chunk);
  assert.deepEqual(await first,{deviceId:'abc'});
  await turn(); assert.equal(writes.length,2);
  client.receive(P.encodeFrame({id:writes[0].id,session:client.session,ok:true,data:{duplicate:true}}));
  client.receive(P.encodeFrame({id:writes[1].id,session:client.session,ok:true,data:{entries:[]}}));
  assert.deepEqual(await second,{entries:[]});
  assert.deepEqual(events,[['state',{motion:true}]]);client.close();
});

test('early ACK does not start the next request until its write completes', async () => {
  let release, writes=0;
  const client = new P.RpcClient({write:bytes=>{writes++;const req=JSON.parse(P.utf8Decode(bytes));client.receive(P.encodeFrame({id:req.id,session:req.session,ok:true,data:req.op}));return new Promise(resolve=>{release=resolve;});}});
  const a=client.request('get'), b=client.request('time',{epochMs:1});
  await turn();assert.equal(writes,1);release();assert.equal(await a,'get');
  await turn();assert.equal(writes,2);release();assert.equal(await b,'time');client.close();
});

test('device rejection is returned without losing a healthy connection', async () => {
  const client = new P.RpcClient({write:bytes=>{const req=JSON.parse(P.utf8Decode(bytes));client.receive(P.encodeFrame({id:req.id,session:req.session,ok:false,error:'invalid_config',message:'bad setting'}));}});
  await assert.rejects(client.request('set',{config:{beepMs:0}}), {code:'invalid_config'});
  assert.equal(client.closed,false);client.close();
});

test('write failure rejects queued mutations and never retries them', async () => {
  let writes=0;
  const client = new P.RpcClient({write:()=>{writes++;throw new Error('disconnected');}});
  await Promise.all([assert.rejects(client.request('set',{config:{muted:true}}),/disconnected/),assert.rejects(client.request('clear'),/disconnected/)]);
  assert.equal(writes,1);assert.equal(client.closed,true);
});

test('timeout also bounds a hung write, closes the session and rejects queued work', async () => {
  let writes=0, fatal=0;
  const client = new P.RpcClient({timeoutMs:20,write:()=>{writes++;return new Promise(()=>{});},onFatal:()=>fatal++});
  await Promise.all([assert.rejects(client.request('clear'),/timed out/),assert.rejects(client.request('get'),/timed out/)]);
  assert.equal(writes,1);assert.equal(fatal,1);assert.equal(client.closed,true);
});

test('command queue and protocol errors fail predictably', async () => {
  const client = new P.RpcClient({maxQueue:2,write:()=>{}});
  const a=assert.rejects(client.request('get'),/Malformed response/);
  const b=assert.rejects(client.request('get'),/Malformed response/);
  await assert.rejects(client.request('get'),/queue is full/);
  client.receive(P.encodeFrame({id:1,session:client.session,ok:'yes'}));await Promise.all([a,b]);
  const other=new P.RpcClient({write:()=>{}});
  await assert.rejects(other.request('get',{id:7}),/Reserved/);
  other.close();
});

test('reconnected sessions ignore stale ACKs even when IDs restart at one', async () => {
  const old=new P.RpcClient({write:()=>{}}), fresh=new P.RpcClient({write:()=>{}});
  assert.match(fresh.session,/^[0-9a-f]{16}$/);assert.notEqual(old.session,fresh.session);
  let settled=false;
  const task=fresh.request('clear').then(result=>{settled=true;return result;});
  await turn();
  fresh.receive(P.encodeFrame({id:1,session:old.session,ok:true,data:{stale:true}}));
  fresh.receive(P.encodeFrame({id:1,ok:true,data:{legacy:true}}));
  await turn();assert.equal(settled,false);
  fresh.receive(P.encodeFrame({id:1,session:fresh.session,ok:true,data:{current:true}}));
  assert.deepEqual(await task,{current:true});old.close();fresh.close();
});

test('20-byte chunking preserves nonzero-offset byte views', () => {
  const bytes=new Uint8Array(80).map((_,i)=>i), view=bytes.subarray(7,64);
  const chunks=P.chunkBytes(view);
  assert(chunks.every(x=>x.length<=20));
  assert.deepEqual(Uint8Array.from(chunks.flatMap(x=>Array.from(x))),view);
});
