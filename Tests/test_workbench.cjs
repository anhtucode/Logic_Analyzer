/* Strict DOM/canvas contract harness, not a browser layout or USB hardware test. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');
const root = path.join(__dirname, '../AppWeb');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
const elements = new Map(), listeners = new Map(), drawings = [], downloads = [], alerts = [];
const classList = () => { const set = new Set(); return {add(...v){v.forEach(x=>set.add(x));},remove(...v){v.forEach(x=>set.delete(x));},contains:v=>set.has(v),toggle(v,on){if(on===undefined)on=!set.has(v);on?set.add(v):set.delete(v);return on;}}; };
function canvasContext() {return new Proxy({}, {get(target,key){return target[key] || ((...args)=>{assert(args.every(v=>typeof v!=='number'||Number.isFinite(v)),key+' received nonfinite');drawings.push([key,...args]);});},set(target,key,value){target[key]=value;return true;}});}
function makeElement(id,tag='',attrs='') {
  let content='',value='';const handlers={};
  const el={id,tagName:tag.toUpperCase(),style:{setProperty(){}},dataset:{},checked:/\bchecked\b/.test(attrs),disabled:false,textContent:'',classList:classList(),
    clientWidth:900,clientHeight:300,scrollTop:0,scrollHeight:500,offsetWidth:230,offsetHeight:60,options:[],
    parentElement:{clientWidth:900},addEventListener(k,fn){handlers[k]=fn;},handlers,
    getBoundingClientRect(){return {left:0,top:0,width:900,height:600};},getContext:canvasContext,setPointerCapture(){},hasPointerCapture(){return false;},
    showModal(){this.open=true;},close(){this.open=false;},click(){handlers.click?.({target:el});},matches(){return false;},toBlob(fn){fn(new Blob(['png']));}};
  Object.defineProperty(el,'innerHTML',{get:()=>content,set(v){content=v;for(const m of v.matchAll(/id="([^"]+)"/g))if(!elements.has(m[1]))elements.set(m[1],makeElement(m[1]));if(tag==='select'){el.options=[...v.matchAll(/<option(?:\s+value="([^"]*)")?[^>]*>([^<]*)/g)].map(m=>({value:m[1]??m[2]}));value=el.options[0]?.value||'';}}});
  Object.defineProperty(el,'value',{get:()=>value,set(v){value=String(v);}});
  const initial=attrs.match(/\bvalue="([^"]*)"/);if(initial)value=initial[1];return el;
}
for(const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
  const [,tag,attrs,id]=match;assert(!elements.has(id),'duplicate HTML id '+id);const el=makeElement(id,tag,attrs);elements.set(id,el);
  if(tag==='select'){const body=html.slice(match.index+match[0].length).split('</select>')[0];el.innerHTML=body;const selected=body.match(/<option(?:\s+value="([^"]*)")?[^>]*\bselected[^>]*>([^<]*)/);if(selected)el.value=selected[1]??selected[2];}
}
const el=id=>{assert(elements.has(id),'missing DOM element '+id);return elements.get(id);};
const panels=new Map(['.wave-card','.analysis-card','.canvas-wrap','.left-panel'].map(s=>[s,makeElement(s)]));
const body={classList:classList()},doc={body,documentElement:{style:{setProperty(){}}},getElementById:el,
  querySelector(s){if(s==='dialog[open]')return [...elements.values()].find(e=>e.open);return panels.get(s);},
  querySelectorAll(){return [];},addEventListener(k,fn){listeners.set(k,fn);},createElement(tag){return makeElement('',tag);}};
let timer=0;const timers=new Map();
const sandbox={document:doc,performance,Uint8Array,Uint16Array,DataView,structuredClone,Blob,
  window:{devicePixelRatio:1,addEventListener(){}},navigator:{},localStorage:{getItem:()=>null,setItem(){}},
  ResizeObserver:class {observe(){}},setTimeout(fn){timers.set(++timer,fn);return timer;},clearTimeout(id){timers.delete(id);},
  setInterval:()=>1,clearInterval(){},requestAnimationFrame(fn){timers.set(++timer,fn);return timer;},cancelAnimationFrame(id){timers.delete(id);},
  alert:message=>alerts.push(message),confirm:()=>true,URL:{createObjectURL:()=>'',revokeObjectURL(){}},console};
vm.createContext(sandbox);
for(const name of ['analysis.js','app.js','workbench.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),sandbox,{filename:name});
vm.runInContext(`globalThis.api={state,clearSamples,receiveCapture,receiveStream,flushStreamView,setFollow,records,
  sessionData,loadCaptureFile,measureChannel,sampleTime,zoom,selectEvent,filteredRecords,drawWaveform,
  decoderConfig,applyDecoderConfig,saveCapture,exportData,makeConfigPayload,updateFooterStatus};
  globalThis.setupWorkerForTest=setupMeasurementWorker;
  globalThis.renderTableForTest=renderDecodedData;
  downloadBlob=(content,name,type)=>globalThis.downloads.push({content,name,type});`,sandbox);
sandbox.downloads=downloads;const a=sandbox.api,s=a.state;
assert.equal(s.samples.length,0);assert.equal(s.triggerIndex,null);assert(drawings.length>0,'actual render code executed');
assert(!html.includes('sideModeSelect'));assert(!html.includes('data-tab="protocol"'));
assert.deepEqual(Array.from(el('pcBufferSelect').options,x=>x.value),['8192','65536','262144','1048576']);
el('uartEnabled').checked=false;
s.captureConfig={triggerType:'2',channel:0,pretrigger:50};a.receiveCapture({rate:100000,id:5,flags:0,trigger:16},Array.from({length:100},(_,i)=>i%10<5?0:1));
assert.equal(s.triggerIndex,null);assert.equal(a.sampleTime(10),.0001);
s.captureConfig.triggerType='1';a.receiveCapture({rate:100000,id:6,flags:0,trigger:16},s.samples);
assert.equal(a.sampleTime(16),0);assert.equal(s.triggerIndex,16);
s.depth=2048;assert.equal(new DataView(a.makeConfigPayload('CAPTURE',100000).buffer).getUint16(4,true),2048);
s.channels[0].name='RX';s.order.reverse();a.drawWaveform();assert.equal(s.samples[0],0,'display order does not remap bits');
s.cursorA=1;s.cursorB=90;s.viewStart=5;s.viewEnd=35;const saved=a.sessionData();assert(sandbox.LA.validateSession(JSON.parse(JSON.stringify(saved))));
const before=s.samples;
module.exports=(async()=>{
  await a.loadCaptureFile({text:async()=>JSON.stringify({...saved,samples:[-1]})});assert.equal(s.samples,before,'invalid load is atomic');
  s.actualDeviceState='ARMED';await a.loadCaptureFile({text:async()=>JSON.stringify(saved)});assert.equal(s.samples,before,'live load is blocked');s.actualDeviceState='IDLE';
  await a.loadCaptureFile({text:async()=>JSON.stringify(saved)});assert.equal(s.channels[0].name,'RX');assert.equal(s.viewStart,5);assert.equal(s.triggerIndex,16);
  const base=a.sessionData();base.mode='STREAM';base.triggerIndex=null;s.decoder=null;s.streamTotal=0;s.followLive=true;a.clearSamples();s.streamRing=new Uint8Array(8192);
  a.receiveStream({rate:100000,id:1},Uint8Array.from({length:1024},(_,i)=>i&1));a.flushStreamView();assert.equal(s.sampleOrigin,0);assert.equal(s.triggerIndex,null);
  s.cursorA=10;s.viewStart=100;s.viewEnd=300;a.setFollow(false);const frozen=s.samples,origin=s.sampleOrigin;
  for(let i=0;i<12;i++)a.receiveStream({rate:100000,id:1},new Uint8Array(1024));a.flushStreamView();
  assert.equal(s.samples,frozen);assert.equal(s.sampleOrigin,origin);assert.equal(s.streamTotal,13312);
  a.setFollow(true);assert.equal(s.sampleOrigin,5120);assert.equal(s.viewEnd-s.viewStart,200);assert.equal(s.cursorA,10-5120,'absolute cursor retained/expired');
  assert.equal(a.sampleTime(0),.0512);assert.equal(s.triggerIndex,null);
  a.setFollow(false);s.frozenRecords=null;el('uartBaud').value='9600';el('uartEnabled').checked=true;
  const frozenIds=Array.from(a.records(),r=>r.id);
  a.receiveStream({rate:100000,id:1},new Uint8Array(1024));
  assert.deepEqual(Array.from(a.records(),r=>r.id),frozenIds,'paused config replay stays on frozen raw');
  a.setFollow(true);el('uartEnabled').checked=false;
  a.exportData('raw');a.exportData('vcd');a.exportData('measurements');a.saveCapture();assert.equal(downloads.length,4);assert(downloads[0].content.includes('sample_absolute'));
  assert(sandbox.LA.validateSession(JSON.parse(downloads[3].content)));
  // Device synchronization must not reinterpret already loaded raw samples.
  const status=new Uint8Array(20);new DataView(status.buffer).setUint32(12,500000,true);
  vm.runInContext('globalThis.applyStatusForTest=applyStatus;',sandbox);sandbox.applyStatusForTest(status);
  assert.equal(s.sampleRate,100000);assert.equal(s.deviceRate,500000);
  s.actualDeviceState='STREAMING';a.updateFooterStatus();assert(el('rateSelect').disabled);assert(el('loadBtn').disabled);
  // UI fixtures exercise bounded rows and filters, never enter the product source.
  s.dataMode='CAPTURE';s.sampleOrigin=0;s.samples=Uint8Array.from({length:100},(_,i)=>i&1);el('uartEnabled').checked=true;
  s.frozenRecords=Array.from({length:6000},(_,i)=>({id:'ui:'+i,protocol:'UART',kind:'FRAME',status:'OK',channel:0,index:i%80,startIndex:i%80,endIndex:i%80+10,width:8,value:65,unsynchronized:false,framingError:false}));
  sandbox.renderTableForTest();assert.equal(a.filteredRecords().length,6000);assert((el('decodedTableBody').innerHTML.match(/data-event=/g)||[]).length<80);
  el('decodeStatusFilter').value='ERROR';assert.equal(a.filteredRecords().length,0);el('decodeStatusFilter').value='ALL';
  el('decodeSearch').value='0x41';assert.equal(a.filteredRecords().length,6000);el('decodeSearch').value='';
  el('decodeFormat').value='binary';sandbox.renderTableForTest();assert(el('decodedTableBody').innerHTML.includes('0b01000001'));el('decodeFormat').value='hex';
  a.selectEvent('ui:1',true);assert.equal(s.selectedEvent,'ui:1');assert.equal(s.cursorA,1);
  // Worker response for an older raw snapshot must not overwrite current stats.
  let posted=null,worker=null;
  sandbox.Worker=class {constructor(){worker=this;}postMessage(data){posted=data;}terminate(){}};
  sandbox.setupWorkerForTest();s.frozenRecords=null;s.measureJob=null;s.asyncMeasurements=null;s.dataMode='STREAM';s.streamAccept=true;
  a.measureChannel(0);const stale=posted;s.samples=s.samples.slice();worker.onmessage({data:{id:stale.id,measurements:[]}});
  assert.equal(s.asyncMeasurements,null);assert.notEqual(posted.id,stale.id);
  const calculated=Array.from({length:8},(_,ch)=>sandbox.LA.measure(s.samples,s.sampleRate,ch));
  worker.onmessage({data:{id:posted.id,measurements:calculated}});assert(Math.abs(a.measureChannel(0).frequency-50000)<1e-8);
  const exporting=a.exportData('measurements');assert.equal(posted.id,'export');worker.onmessage({data:{id:'export',measurements:calculated}});await exporting;assert.equal(downloads.length,5);
  console.log('PASS workbench: strict HTML IDs, initialization/canvas, trigger/no-trigger, depth, atomic session load, streaming pause/live/timeline, exports, control lock');
  return {passed:true,drawCalls:drawings.length,exports:downloads.length};
})();
