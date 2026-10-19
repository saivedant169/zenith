import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';
import postgres from 'postgres';
const FRAME_CAP=262144, EVENT_CAP=128;
const zero=s=>Buffer.from(s+'\0');
function frame(t,p=Buffer.alloc(0)){const b=Buffer.alloc(5+p.length);b[0]=t.charCodeAt(0);b.writeUInt32BE(4+p.length,1);p.copy(b,5);return b;}
const ready=()=>frame('Z',Buffer.from('I'));
function rowDesc(){const f=Buffer.alloc(18);f.writeUInt32BE(23,6);f.writeInt16BE(4,10);f.writeInt32BE(-1,12);return frame('T',Buffer.concat([Buffer.from([0,1]),zero('value'),f]));}
function row(n){const s=Buffer.from(String(n)),h=Buffer.alloc(6);h.writeUInt16BE(1);h.writeInt32BE(s.length,2);return frame('D',Buffer.concat([h,s]));}
function serverError(){return frame('E',Buffer.concat([Buffer.from('S'),zero('ERROR'),Buffer.from('C'),zero('22012'),Buffer.from('M'),zero('fixed diagnostic error'),Buffer.from([0])]));}
class Socket extends Duplex {
 input=Buffer.alloc(0);started=false;closedFrames=0;pending=[];held=null;scheduled=new Set();
 constructor(events,phase){super({allowHalfOpen:false});this.events=events;this.phase=phase;}
 get readyState(){return this.destroyed?'closed':'open';}
 _read(){}
 _destroy(error,done){for(const id of this.scheduled)clearImmediate(id);this.scheduled.clear();done(error);}
 _final(done){this.push(null);done();}
 event(type,more={}){assert(this.events.length<EVENT_CAP);this.events.push({seq:this.events.length,type,phase:this.phase(),...more});}
 later(fn){const id=setImmediate(()=>{this.scheduled.delete(id);if(!this.destroyed)fn();});this.scheduled.add(id);}
 _write(data,_encoding,done){try{
  assert(this.input.length+data.length<=FRAME_CAP);this.input=Buffer.concat([this.input,data]);
  while(this.input.length>=4){
   if(!this.started){const n=this.input.readUInt32BE(0);assert(n>=8&&n<=FRAME_CAP);if(this.input.length<n)break;assert.equal(this.input.readUInt32BE(4),196608);this.input=this.input.subarray(n);this.started=true;this.later(()=>this.push(Buffer.concat([frame('R',Buffer.alloc(4)),frame('S',Buffer.concat([zero('server_version'),zero('17.0')])),frame('S',Buffer.concat([zero('client_encoding'),zero('UTF8')])),frame('K',Buffer.alloc(8)),ready()])));continue;}
   if(this.input.length<5)break;const n=this.input.readUInt32BE(1);assert(n>=4&&n<=FRAME_CAP);if(this.input.length<n+1)break;const m=this.input.subarray(0,n+1);this.input=this.input.subarray(n+1);assert(++this.closedFrames<=64);
   const type=String.fromCharCode(m[0]);if(type==='X')continue;assert.equal(type,'Q');assert.equal(m.at(-1),0);const sql=m.toString('utf8',5,m.length-1);assert(['select 0','select 41','select 42','fixed error'].includes(sql));
   this.event('frontend',{sql,beforeReady:this.held!==null});if(this.held!==null)this.pending.push(sql);else this.answer(sql);
  }done();
 }catch(e){done(e);}}
 answer(sql){assert.equal(this.held,null);this.held=sql;this.later(()=>{const isError=sql==='fixed error';this.push(isError?serverError():Buffer.concat([rowDesc(),row(Number(sql.split(' ')[1])),frame('C',zero('SELECT 1'))]));this.event(isError?'error-sent':'command-complete',{sql});if(sql==='select 0')this.release();});}
 release(){assert.notEqual(this.held,null);const sql=this.held;this.held=null;this.event('ready',{sql});this.push(ready());const next=this.pending.shift();if(next!==undefined)this.answer(next);}
}
async function bounded(p,label){let id;try{return await Promise.race([p,new Promise((_,reject)=>id=setTimeout(()=>reject(new Error('bounded-'+label)),1200))]);}finally{clearTimeout(id);}}
async function event(events,pred,label){const start=performance.now();for(;;){const found=events.find(pred);if(found)return found;assert(performance.now()-start<1000,label);await turn();}}
async function runCase(guarded,errorCase=false){
 const events=[];let phase='warmup',socket,count=0;
 const sql=postgres({host:'127.0.0.1',port:5432,user:'wire-model',database:'wire-model',pass:'',ssl:false,max:1,max_pipeline:100,prepare:false,fetch_types:false,idle_timeout:null,max_lifetime:null,keep_alive:false,no_subscribe:true,connect_timeout:2,socket:()=>{assert.equal(++count,1);return socket=new Socket(events,()=>phase);}});
 try{
  const warm=await bounded(sql.unsafe('select 0').execute(),'warmup');assert.deepEqual(Array.from(warm).map(x=>x.value),[0]);phase='measured';
  const firstSql=errorCase?'fixed error':'select 41',opts=guarded?{onexecute:()=>false}:{};
  const first=sql.unsafe(firstSql,[],opts).execute().then(value=>({ok:true,value}),error=>({ok:false,code:error.code}));
  await event(events,e=>e.phase===phase&&e.type===(errorCase?'error-sent':'command-complete'),'first-response');
  const second=sql.unsafe('select 42',[],opts).execute();
  if(guarded){await turn();await turn();assert(!events.some(e=>e.phase===phase&&e.type==='frontend'&&e.sql==='select 42'),'guarded-query-arrived-before-release');}
  else await event(events,e=>e.phase===phase&&e.type==='frontend'&&e.sql==='select 42','baseline-second');
  assert.equal(socket.held,firstSql);socket.release();
  const secondStart=await event(events,e=>e.phase===phase&&e.type==='frontend'&&e.sql==='select 42','second-start');
  await event(events,e=>e.phase===phase&&e.type==='command-complete'&&e.sql==='select 42','second-response');assert.equal(socket.held,'select 42');socket.release();
  const [a,b]=await bounded(Promise.all([first,second]),'results');if(errorCase){assert.equal(a.ok,false);assert.equal(a.code,'22012');}else{assert.equal(a.ok,true);assert.deepEqual(Array.from(a.value).map(x=>x.value),[41]);}assert.deepEqual(Array.from(b).map(x=>x.value),[42]);
  const firstReady=events.find(e=>e.phase===phase&&e.type==='ready'&&e.sql===firstSql);assert(firstReady);assert.equal(secondStart.seq<firstReady.seq,!guarded);
  return {guarded,errorCase,prepare:false,poolSize:1,fetchTypes:false,networkSockets:0,explicitReadyBarrier:true,secondFrontendBeforeFirstReady:secondStart.seq<firstReady.seq,events};
 }finally{await bounded(sql.end({timeout:.1}),'close');assert(socket.destroyed,'memory-socket-not-closed');}
}
export async function runDiagnostic(){const start=performance.now();const cases=[await runCase(false),await runCase(true),await runCase(true,true)];assert(performance.now()-start<10000);return {kind:'actual-postgresjs-in-memory-simple-query-boundary',version:'3.4.7',acceptanceClaim:false,realPoolerReproduction:false,elapsedMs:Math.round(performance.now()-start),cases};}
