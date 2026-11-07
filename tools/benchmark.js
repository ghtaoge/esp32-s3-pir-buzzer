const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const P=require('../miniprogram/utils/protocol');
async function main(){
  const payload={event:'state',data:{motion:true,present:true,sounding:false,phase:'waiting_release',uptimeMs:100000,triggerCount:99,freeHeap:100000}};
  const chunks=P.chunkBytes(P.encodeFrame(payload));
  const decoder=new P.LineDecoder({onError:error=>{throw error;}});
  // Warm the code paths before measuring retained memory.
  for(let n=0;n<1000;n++)for(const chunk of chunks)decoder.push(chunk);
  if(global.gc)global.gc();
  const before=process.memoryUsage().heapUsed;
  let frames=0;
  const started=performance.now();
  for(let n=0;n<100000;n++)for(const chunk of chunks)frames+=decoder.push(chunk).length;
  const elapsed=performance.now()-started;
  if(global.gc)global.gc();
  const retained=process.memoryUsage().heapUsed-before;
  assert.equal(frames,100000);assert.equal(decoder.used,0);assert.equal(decoder.buffer.length,2048);
  assert(retained<8*1024*1024,'Unbounded retained memory in decoder');
  console.log(JSON.stringify({workload:'100000 telemetry frames in 20-byte fragments',frames,elapsedMs:Math.round(elapsed),framesPerSecond:Math.round(frames*1000/elapsed),retainedHeapBytes:retained,decoderCapacityBytes:decoder.buffer.length,gcAvailable:!!global.gc}));
  let requests=0;
  const rpc=new P.RpcClient({write:bytes=>{
    requests++;
    const request=JSON.parse(P.utf8Decode(bytes));
    for(const part of P.chunkBytes(P.encodeFrame({id:request.id,session:request.session,ok:true,data:{ok:true}})))rpc.receive(part);
  }});
  const rpcStarted=performance.now();
  for(let n=0;n<10000;n++)await rpc.request('get');
  assert.equal(requests,10000);assert.equal(rpc.queue.length,0);assert.equal(rpc.pending,null);
  console.log(JSON.stringify({workload:'10000 serialized in-memory RPC transactions',requests,elapsedMs:Math.round(performance.now()-rpcStarted),pending:0,queued:0}));
  rpc.close();
  console.log('NOTE: these are host-side software measurements, not BLE radio, flash latency or physical sensor response measurements.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
