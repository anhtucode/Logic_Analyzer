const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const LA = require('../AppWeb/analysis.js');
const cfg = { uartBaud: 10000, spiEnabled: true, i2cEnabled: true };
function uart(bytes, spb = 10, parity = 'none', stops = 1, width = 8, order = 'lsb') {
  const out = Array(spb * 12).fill(1);
  for (const value of bytes) {
    out.push(...Array(spb).fill(0)); let ones = 0;
    for (let i = 0; i < width; i++) { const b = (value >> (order==='lsb'?i:width-1-i)) & 1; ones += b; out.push(...Array(spb).fill(b)); }
    if (parity !== 'none') out.push(...Array(spb).fill((ones & 1) ^ (parity === 'odd' ? 1 : 0)));
    out.push(...Array(spb * stops).fill(1));
  }
  return out;
}
const wave = uart([0x55, 0xaa, 0x52]);
const reference = LA.decode(wave, 100000, cfg).getRecords().filter(r => r.kind === 'FRAME');
assert.deepEqual(reference.map(r => r.value), [0x55, 0xaa, 0x52]);
for (let split = 1; split < wave.length; split++) {
  const d = new LA.Decoder(100000, cfg);
  d.feed(wave.slice(0, split)); d.feed(wave.slice(split)); d.finish();
  assert.deepEqual(d.getRecords().filter(r => r.kind === 'FRAME').map(r => [r.value, r.index, r.endIndex]),
    reference.map(r => [r.value, r.index, r.endIndex]));
}
const formatted = LA.decode(uart([0x42, 0x55], 10, 'even', 2, 7), 100000,
  { uartBaud: 10000, uartDataBits: 7, uartParity: 'even', uartStopBits: 2 });
assert.deepEqual(formatted.getRecords().filter(r => r.kind === 'FRAME').map(r => [r.value, r.parityError, r.framingError]), [[0x42, false, false], [0x55, false, false]]);
const parityBad = uart([0x42], 10, 'even', 2, 7); parityBad.fill(1, 200, 210);
assert(LA.decode(parityBad, 100000, { uartBaud: 10000, uartDataBits: 7, uartParity: 'even', uartStopBits: 2 })
  .getRecords().some(r => r.parityError));
for(const width of[5,6,7,8,9])for(const parity of['none','even','odd'])for(const stops of[1,1.5,2])for(const order of['lsb','msb']) {
  const expected=[0,1,0x55&((1<<width)-1),(1<<width)-1];
  const result=LA.decode(uart(expected,10,parity,stops,width,order),100000,{uartBaud:10000,uartDataBits:width,uartParity:parity,uartStopBits:stops,uartBitOrder:order}).getRecords().filter(r=>r.kind==='FRAME');
  assert.deepEqual(result.map(r=>r.value),expected);assert(result.every(r=>!r.parityError&&!r.framingError));
}
const rx=uart([0x55,0xaa]),tx=uart([0x12,0xab]);
const duplex=LA.decode(rx.map((b,i)=>b|(tx[i]<<1)),100000,{uartBaud:10000,uartTxChannel:1}).getRecords();
assert.deepEqual(duplex.filter(r=>r.role==='RX').map(r=>r.value),[0x55,0xaa]);
assert.deepEqual(duplex.filter(r=>r.role==='TX').map(r=>r.value),[0x12,0xab]);
const d = new LA.Decoder(100000, cfg); d.feed(wave.slice(0, 140)); d.gap(140, 'test', null);
d.feed(wave, 200); d.finish();
assert(d.getRecords().some(r => r.kind === 'GAP'));
assert(!d.getRecords().some(r => r.kind === 'FRAME' && r.startIndex < 140 && r.endIndex >= 200));
const ring = new LA.Ring(8); ring.append(Uint8Array.from([0,1,2,3,4,5])); ring.append(Uint8Array.from([6,7,8,9]));
assert.deepEqual(Array.from(ring.snapshot().samples), [2,3,4,5,6,7,8,9]); assert.equal(ring.snapshot().first, 2);
assert.throws(() => ring.append(Uint8Array.of(10), 20));
const pulse = Array(10000).fill(0); pulse[4444] = 1;
assert(LA.bins(pulse, 0, 0, 9999, 100).some(bin => bin.lo === 0 && bin.hi === 1));
const square = Array.from({length: 1000}, (_, i) => i % 20 < 10 ? 0 : 1);
const m = LA.measure(square, 100000, 0);
assert(Math.abs(m.frequency - 5000) < 1e-8); assert.equal(m.duty, 50); assert(Math.abs(m.high - .0001) < 1e-12);
assert.equal(LA.measure(Array(100).fill(1), 100000, 0).frequency, null);
assert.equal(LA.statistics(Array(200000).fill(1)).mean, 1);
assert(LA.vcd([0,1,1,0], 1000000, Array.from({length:8},(_,i)=>({name:'D'+i}))).includes('#1000\n1!'));
const session = {version:2,samples:[0,1],sampleRate:100000,sampleOrigin:100,triggerIndex:null,mode:'STREAM'};
assert.equal(LA.validateSession(session).sampleOrigin, 100);
assert.throws(()=>LA.validateSession({...session,samples:[256]}));
assert.throws(()=>LA.validateSession({...session,triggerIndex:10}));
assert.throws(()=>LA.validateSession({...session,view:[0,100]}));
assert.throws(()=>LA.validateSession({...session,visible:[true]}));
assert.throws(()=>LA.validateSession({...session,decoderRecords:[{protocol:'SPI'}]}));
assert.equal(LA.validateSession({version:1,samples:[0,255],sampleRate:1000}).triggerIndex,null);

// Independent bus oracle: CS setup/hold, stable data on sample edge, 16-bit LSB.
function spi(words, width=8, lsb=false, active=0) {
  let clk=0,cs=1-active,out=0,incoming=0;const samples=[];
  const hold=()=>{for(let i=0;i<5;i++)samples.push(clk|(out<<1)|(cs<<2)|(incoming<<3));};hold();cs=active;hold();
  for(const [mosi,miso]of words)for(let k=0;k<width;k++){const pos=lsb?k:width-1-k;out=Math.floor(mosi/2**pos)%2;incoming=Math.floor(miso/2**pos)%2;hold();clk=1;hold();clk=0;hold();}
  cs=1-active;hold();return samples;
}
function i2c() {
  let scl=1,sda=1;const samples=[];const hold=()=>{for(let i=0;i<5;i++)samples.push(scl|(sda<<1));};hold();sda=0;hold();scl=0;hold();
  for(const [value,ack]of[[0xa0,0],[0x55,0],[0xaa,1]])for(const b of[...Array.from({length:8},(_,i)=>(value>>(7-i))&1),ack]){sda=b;hold();scl=1;hold();scl=0;hold();}
  sda=0;hold();scl=1;hold();sda=1;hold();return samples;
}
for(const [name,bus,config]of[
  ['SPI',spi([[0x55,0xaa],[0xa5,0x5a]]),{uartEnabled:false,spiEnabled:true}],
  ['SPI16',spi([[0x1234,0xabcd]],16,true,1),{uartEnabled:false,spiEnabled:true,spiWordSize:16,spiBitOrder:'lsb',spiCsActive:1}],
  ['SPI32',spi([[0x89abcdef,0xfedcba98]],32),{uartEnabled:false,spiEnabled:true,spiWordSize:32}],
  ['I2C',i2c(),{uartEnabled:false,i2cEnabled:true,i2cScl:0,i2cSda:1}]
]) {
  const baseline=LA.decode(bus,100000,config).getRecords();
  for(let split=1;split<bus.length;split++) {
    const engine=new LA.Decoder(100000,config);engine.feed(bus.slice(0,split));engine.feed(bus.slice(split));engine.finish();
    assert.deepEqual(engine.getRecords(),baseline,name+' split='+split);
  }
  if(name==='SPI16')assert.deepEqual(baseline.filter(r=>r.kind==='WORD').map(r=>[r.mosi,r.miso]),[[0x1234,0xabcd]]);
  if(name==='SPI32')assert.deepEqual(baseline.filter(r=>r.kind==='WORD').map(r=>[r.mosi,r.miso]),[[0x89abcdef,0xfedcba98]]);
  if(name==='I2C'){assert.deepEqual(baseline.filter(r=>['ADDRESS','DATA'].includes(r.kind)).map(r=>[r.value,r.ack]),[[0xa0,true],[0x55,true],[0xaa,false]]);assert.equal(baseline.filter(r=>r.status==='ERROR').length,0,'NACK is not an error');}
}
const longDecoder=new LA.Decoder(100000,{uartBaud:10000},'long',100);
for(let i=0;i<1000;i++)longDecoder.feed(wave);
assert(longDecoder.records.length<=200);assert(longDecoder.getRecords().length<=100);
let workerReply=null;const workerScope={self:{postMessage:reply=>workerReply=reply},importScripts(){workerScope.LA=LA;}};
vm.createContext(workerScope);vm.runInContext(fs.readFileSync(path.join(__dirname,'../AppWeb/analysis_worker.js'),'utf8'),workerScope);
workerScope.self.onmessage({data:{id:17,samples:square,rate:100000,from:0,to:square.length}});
assert.equal(workerReply.id,17);assert.equal(workerReply.measurements.length,8);assert.equal(workerReply.measurements[0].frequency,5000);
console.log('PASS analysis: incremental UART/all splits, formats/parity, gaps, ring, pulse-preserving bins, measurements, session/VCD');
module.exports = {passed:true};
