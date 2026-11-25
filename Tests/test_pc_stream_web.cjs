/* Chay bang Node.js: node Tests/test_pc_stream_web.cjs
 * Dung parser/handler/ring that cua dashboard, mock DOM va dong ho. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const source = ['analysis.js','app.js','workbench.js'].map(file => fs.readFileSync(path.join(__dirname, '../AppWeb/'+file), 'utf8')).join('\n')
  .replace(/\ninitialize\(\);\s*$/, '\n');
let now = 0, nextTimer = 1, analysisCount = 0, drawCount = 0;
const timers = new Map(), rafs = new Map(), commands = [], logs = [];
const elements = new Map();
const sandbox = {
  Uint8Array, Uint16Array, DataView, performance, structuredClone,
  document: { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: id.includes('Mode') || id === 'modeSelect' ? 'STREAM' :
      (id.includes('Rate') || id === 'rateSelect' ? '500000' : '0'), checked: true });
    return elements.get(id);
  } },
  alert(message) { throw Error(message); },
  setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, due: now + delay }); return id; },
  clearTimeout(id) { timers.delete(id); },
  requestAnimationFrame(fn) { const id = nextTimer++; rafs.set(id, fn); return id; },
  cancelAnimationFrame(id) { rafs.delete(id); },
  analysis() { analysisCount++; }, draw() { drawCount++; },
  recordCommand(command) { commands.push(command); }, recordLog(message) { logs.push(message); },
};
vm.createContext(sandbox);
vm.runInContext(source + `
  const sendCommandActual = sendCommand;
  logEvent = message => recordLog(message);
  updateStats = () => analysis();
  renderDecodedData = renderMeasurements = updateDecoderFeedback = updateCursorInfo =
    updateFooterStatus = updateConnectionUi = setSelfTestStatus = syncRate = () => {};
  drawWaveform = () => draw();
  sendCommand = async command => { recordCommand(command); return true; };
  globalThis.api = { state, STREAM_RATES, crc16Ccitt, buildFrame, parseSerialBytes,
    receiveStreamPacket, handleDeviceFrame, clearSamples, flushStreamView,
    resetSerialParser, refreshAnalysis, pollDeviceStatus, startAcquisition, disconnectSerial,
    sendCommandActual, SERIAL_BUFFER_BYTES };
`, sandbox);
const a = sandbox.api, s = a.state;

function reset(rate = 500000) {
  timers.clear(); rafs.clear(); now = 0; analysisCount = drawCount = 0;
  s.streamTotal=0; s.decoder=null; s.followLive=true; s.streamRing=new Uint8Array(8192);
  commands.length = logs.length = 0;
  a.clearSamples(); a.resetSerialParser();
  Object.assign(s, { mode: 'STREAM', sampleRate: rate, connected: true, deviceState: 'STREAMING',
    streamAccept: true, streamFault: false, streamId: null, lastStreamNext: null,
    lastStreamSequence: null, flags: 0, pendingCommand: null, stopRequested: false,
    restartRequested: false, waveformFrame: null, configSeen: true, selfTestRunning: false,
    selfTestPending: false, selfTestRunRequested: false, selfTestStopRequested: false });
}
function payload(first, options = {}) {
  const count = options.count ?? 1024;
  const p = new Uint8Array(16 + count), v = new DataView(p.buffer);
  v.setUint32(0, options.id ?? 77, true);
  v.setUint32(4, first, true);
  v.setUint32(8, options.rate ?? s.sampleRate, true);
  v.setUint16(12, count, true); v.setUint16(14, options.flags ?? 0, true);
  for (let i = 0; i < count; i++) p[16 + i] = ((first + i) * 29 + ((first + i) >>> 8)) & 255;
  return p;
}
function packet(first, seq, options) { return a.buildFrame(0x86, seq, payload(first, options)); }
function advance(ms) {
  now += ms;
  for (const [id, timer] of Array.from(timers)) {
    if (timer.due <= now) { timers.delete(id); timer.fn(); }
  }
  for (const [id, fn] of Array.from(rafs)) { rafs.delete(id); fn(); }
}
function reference(bytes) {
  let crc = 65535;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 32768) ? 0x1021 : 0)) & 65535;
  }
  return crc;
}

assert.deepEqual(Array.from(a.STREAM_RATES), [1000, 5000, 10000, 50000, 100000, 500000]);
assert.equal(a.SERIAL_BUFFER_BYTES, 1048576);
assert.equal(a.crc16Ccitt(Buffer.from('123456789')), 0x29b1);
for (let i = 0; i < 1049; i += 7) {
  const data = Uint8Array.from({ length: i }, (_, k) => (k * 77) & 255);
  assert.equal(a.crc16Ccitt(data), reference(data));
}

// Moi vi tri chia USB frame, gom ca split magic/header/CRC.
for (let split = 0; split <= 1049; split++) {
  reset(); const frame = packet(0, 255);
  a.parseSerialBytes(frame.subarray(0, split));
  a.parseSerialBytes(frame.subarray(split));
  a.parseSerialBytes(packet(1024, 0));
  assert.equal(s.streamFault, false);
  assert.equal(s.streamCount, 2048);
  advance(50);
  assert.deepEqual(Array.from(s.samples), Array.from(payload(0).subarray(16)).concat(Array.from(payload(1024).subarray(16))));
}

// Burst lon hon parser capacity; window chi giu 8192 mau moi nhat.
reset();
const burst = Buffer.concat(Array.from({ length: 200 }, (_, i) => packet(i * 1024, i & 255)));
a.parseSerialBytes(burst);
assert.equal(s.streamCount, 8192); assert.equal(s.lastStreamNext, 204800);
assert.equal(analysisCount, 0); assert.equal(timers.size, 1);
advance(50);
assert.equal(analysisCount, 1); assert.equal(drawCount, 1);
const expected = Buffer.concat(Array.from({ length: 8 }, (_, i) => payload((192 + i) * 1024).subarray(16)));
assert.deepEqual(Array.from(s.samples), Array.from(expected));
assert.equal(s.parser.buffer.length, 65536);

reset();
const junk = new Uint8Array(100001); junk[junk.length - 1] = 0xa5;
a.parseSerialBytes(junk);
assert.equal(s.parser.write - s.parser.read, 1);
a.parseSerialBytes(packet(0, 0)); assert.equal(s.streamCount, 1024);

// Sai thu tu/ID/CRC/metadata -> dung, giu prefix hop le, khong append them.
for (const bad of [
  () => packet(2048, 1), () => packet(0, 0), () => packet(1024, 2),
  () => packet(1024, 1, { id: 78 }), () => packet(1024, 1, { flags: 1 }),
  () => packet(1024, 1, { rate: 1000000 }), () => packet(1024, 1, { count: 0 }),
  () => packet(1024, 1, { count: 1025 }),
  () => { const p = packet(1024, 1); p[55] ^= 1; return p; },
]) {
  reset(); a.parseSerialBytes(packet(0, 0)); a.parseSerialBytes(bad());
  assert.equal(s.streamFault, true); assert.equal(s.streamAccept, false);
  assert.equal(s.deviceState, 'ERROR'); assert.equal(s.samples.length, 1024);
  a.parseSerialBytes(packet(1024, 1)); assert.equal(s.streamCount, 1024);
  a.handleDeviceFrame(0x80, 9, Uint8Array.of(9, 0, 0, 0));
  assert.equal(s.deviceState, 'ERROR'); assert(s.flags & 1);
  assert(commands.includes(9));
}
reset(); a.parseSerialBytes(packet(1024, 0)); assert(s.streamFault);
reset(); a.parseSerialBytes(packet(0, 0));
const badLength = packet(1024, 1); badLength[5] = 0xff; badLength[6] = 0xff;
a.parseSerialBytes(badLength); assert(s.streamFault);
reset(); a.receiveStreamPacket(new Uint8Array(2), 0); assert(s.streamFault);

// first_sample va sequence wrap deu la modulo.
reset(); a.parseSerialBytes(packet(0, 0));
s.lastStreamNext = 0xfffffc00; s.lastStreamSequence = 254;
a.parseSerialBytes(packet(0xfffffc00, 255)); a.parseSerialBytes(packet(0, 0));
assert.equal(s.streamFault, false); assert.equal(s.lastStreamNext, 1024);
// Clear khong lam mat baseline continuity cua session dang chay.
a.clearSamples(); a.parseSerialBytes(packet(1024, 1)); assert(!s.streamFault);

// Moi rate: xu ly ~1 giay packet, decode/render toi da 20Hz va 1 RAF pending.
for (const rate of a.STREAM_RATES) {
  reset(rate); let first = 0, seq = 0, fraction = 0;
  for (let ms = 0; ms < 1000; ms++) {
    fraction += rate / 1000;
    while (fraction >= 1024) {
      a.parseSerialBytes(packet(first, seq++ & 255)); first += 1024; fraction -= 1024;
    }
    advance(1);
    assert(rafs.size <= 1);
  }
  assert(!s.streamFault); assert(analysisCount <= 20); assert(drawCount <= 20);
}
reset(); a.refreshAnalysis(false); a.refreshAnalysis(false); assert.equal(rafs.size, 1);
a.refreshAnalysis(true); assert.equal(rafs.size, 0);
reset(); a.pollDeviceStatus(); assert(commands.includes(2));
reset(); a.parseSerialBytes(packet(0, 0));
const errorStatus = new Uint8Array(20); errorStatus[0] = 6; errorStatus[1] = 4; errorStatus[2] = 1;
a.handleDeviceFrame(0x83, 3, errorStatus); assert(s.streamFault && s.deviceState === 'ERROR');
for (const [flags, detail] of [[5, 'QUEUE_FULL'], [9, 'DMA_LATE']]) {
  reset();
  const classified = new Uint8Array(errorStatus);
  classified[2] = flags;
  a.handleDeviceFrame(0x83, 3, classified);
  assert(logs.some(message => message.includes(detail)));
  a.handleDeviceFrame(0x80, 4, Uint8Array.of(9, 0, 0, 0));
  assert(logs.some(message => message.includes('ACK STOP_STREAM: IDLE')));
  assert(s.streamFault && s.deviceState === 'ERROR');
}

async function lifecycle() {
  // Start moi xoa sticky error; chi nhan STREAM sau ACK START_STREAM.
  await a.startAcquisition();
  assert(!s.streamFault && !s.streamAccept && s.lastStreamNext === null);
  a.parseSerialBytes(packet(0, 10)); assert.equal(s.streamCount, 0);
  a.handleDeviceFrame(0x80, 7, Uint8Array.of(8, 4, 0, 0));
  a.parseSerialBytes(packet(0, 10)); assert.equal(s.streamCount, 1024);
  await a.disconnectSerial();
  assert(!s.streamAccept); assert.equal(timers.size, 0);
  a.parseSerialBytes(packet(1024, 11)); assert.equal(s.streamCount, 1024);
  assert.equal(s.deviceState, 'DISCONNECTED');

  // USB co the phan hoi truoc khi promise writer.write hoan tat.
  reset(); s.streamFault = true; s.deviceState = 'ERROR';
  s.port = { writable: { getWriter() { return {
    write(frame) {
      a.handleDeviceFrame(0x80, frame[4], Uint8Array.of(9, 0, 0, 0));
      return Promise.resolve();
    }, releaseLock() {},
  }; } } };
  await a.sendCommandActual(9);
  assert(logs.findIndex(message => message.startsWith('TX  STOP_STREAM')) <
    logs.findIndex(message => message.startsWith('ACK STOP_STREAM: IDLE')));
  assert(s.streamFault && s.deviceState === 'ERROR');
  s.port = null;

  // Benchmark parser/ring 512 kB; khong phai benchmark USB/DOM tren board that.
  reset(); const chunks = Buffer.concat(Array.from({ length: 500 }, (_, i) => packet(i * 1024, i & 255)));
  const begin = performance.now(); a.parseSerialBytes(chunks);
  const elapsed = performance.now() - begin;
  assert(!s.streamFault && s.lastStreamNext === 512000);
  console.log('PASS AppWeb stream: CRC, fragmentation, bounded parser/ring, continuity, 20Hz UI, lifecycle');
  console.log(`Parser/ring synthetic: ${(chunks.length / (elapsed / 1000) / 1000000).toFixed(2)} MB/s (${elapsed.toFixed(1)} ms); excludes USB and DOM`);
  return { passed: true, parserMBps: Number((chunks.length / (elapsed / 1000) / 1000000).toFixed(2)),
    note: 'Synthetic parser/ring only; excludes USB and DOM' };
}
module.exports = lifecycle();
