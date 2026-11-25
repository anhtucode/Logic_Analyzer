/* Waveform tong hop co oracle doc lap; chay: node Tests/test_protocol_decoders.cjs */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = ['analysis.js','app.js','workbench.js'].map(file => fs.readFileSync(path.join(__dirname, '../AppWeb/'+file), 'utf8')).join('\n')
  .replace(/\ninitialize\(\);\s*$/, '\n');
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    value: '0', checked: false, textContent: '', innerHTML: '',
    classList: { toggle() {} },
  });
  return elements.get(id);
}
const sandbox = {performance: {now:()=>0}, document: { getElementById: element } };
vm.createContext(sandbox);
vm.runInContext(source + `
  globalThis.api = { state, decodeUart, decodeI2c, decodeSpi, i2cEventInfo,
    renderDecodedData, updateDecoderFeedback,
    records, filteredRecords, fillChannelSelect };

`, sandbox);
const a = sandbox.api, s = a.state;
function settings(values) { for (const [id, value] of Object.entries(values)) element(id).value = String(value); }
function use(samples, rate = 100000) { s.samples = samples; s.sampleRate = rate; s.viewEnd = samples.length - 1; for(const id of ['uartEnabled','i2cEnabled','spiEnabled']) element(id).checked=true; }
function values(items, key) { return Array.from(items, item => item[key]); }
function warning(items, text) { return items.warnings.some(message => message.includes(text)); }
settings({...sandbox.LA.DEFAULTS, uartChannel: 0, uartBaud: 10000, i2cScl: 0, i2cSda: 1,
  spiCs: 2, spiClk: 0, spiMosi: 1, spiMiso: 3, spiMode: 0 });
for (const id of ['uartEnabled','spiEnabled','i2cEnabled']) element(id).checked = true;
settings({decodeFilter:'ALL',decodeView:'data',decodeSort:'ascending',decodeSearch:'',decodeChannelFilter:'ALL',decodeStatusFilter:'ALL'});

// SPI: moi nua clock 5 mau; CS setup/hold rieng, du lieu doi o canh setup.
function spiWave(mode, transactions, { half = 5, cutLast = false } = {}) {
  let clock = mode >> 1, cs = 1, mosi = 0, miso = 0;
  const samples = [], samplingEdges = [];
  const hold = (n = half) => {
    const value = clock | (mosi << 1) | (cs << 2) | (miso << 3);
    for (let i = 0; i < n; i++) samples.push(value);
  };
  hold();
  for (const transaction of transactions) {
    cs = 0; hold();
    for (const [outByte, inByte, count = 8] of transaction) {
      for (let bit = 7; bit >= 8 - count; bit--) {
        mosi = (outByte >> bit) & 1; miso = (inByte >> bit) & 1;
        // Setup stable trong muc nghi truoc leading edge cho CPHA=0.
        if (!(mode & 1)) hold();
        clock = 1 - (mode >> 1);
        if (!(mode & 1)) samplingEdges.push(samples.length);
        hold();
        clock = mode >> 1;
        if (mode & 1) samplingEdges.push(samples.length);
        hold();
      }
    }
    if (!cutLast) { cs = 1; hold(); }
  }
  return { samples, samplingEdges };
}
for (let mode = 0; mode < 4; mode++) {
  settings({ spiMode: mode });
  const wave = spiWave(mode, [[[0x55, 0x96], [0xaa, 0x69]], [[0xa5, 0x3c], [0x5a, 0xc3]]]);
  use(wave.samples);
  const result = a.decodeSpi();
  assert.deepEqual(values(result, 'mosi'), [0x55, 0xaa, 0xa5, 0x5a]);
  assert.deepEqual(values(result, 'miso'), [0x96, 0x69, 0x3c, 0xc3]);
  assert.deepEqual(values(result, 'transaction'), [1, 1, 2, 2]);
  assert.deepEqual(values(result, 'index'), [0, 8, 16, 24].map(i => wave.samplingEdges[i]));
  assert.deepEqual(values(result, 'endIndex'), [7, 15, 23, 31].map(i => wave.samplingEdges[i]));
  assert.equal(result.warnings.length, 0);
}
settings({ spiMode: 0 });
use(spiWave(1, [[[0x55, 0xaa]]]).samples);
assert.equal(a.decodeSpi().length, 0); assert(warning(a.decodeSpi(), 'TIMING'));
const resync = spiWave(0, [[[0x55, 0xaa]], [[0xa5, 0x5a]]]).samples;
use(resync.slice(12)); assert.deepEqual(values(a.decodeSpi(), 'mosi'), [0xa5]);
// Tat ca gia tri byte va remap chan; khong chi cac pattern 55/AA.
for (let mode = 0; mode < 4; mode++) {
  settings({ spiMode: mode });
  const bytes = Array.from({ length: 256 }, (_, value) => [value, 255 - value]);
  use(spiWave(mode, [bytes]).samples);
  assert.deepEqual(values(a.decodeSpi(), 'mosi'), bytes.map(pair => pair[0]));
  assert.deepEqual(values(a.decodeSpi(), 'miso'), bytes.map(pair => pair[1]));
}
settings({ spiMode: 0, spiCs: 6, spiClk: 5, spiMosi: 7, spiMiso: 4 });
use(spiWave(0, [[[0xa6, 0x39]]]).samples.map(value =>
  ((value & 1) << 5) | (((value >> 1) & 1) << 7) | (((value >> 2) & 1) << 6) | (((value >> 3) & 1) << 4)));
assert.deepEqual(values(a.decodeSpi(), 'mosi'), [0xa6]);
assert.deepEqual(values(a.decodeSpi(), 'miso'), [0x39]);
settings({ spiCs: 2, spiClk: 0, spiMosi: 1, spiMiso: 3 });
use(spiWave(0, [[[0xf0, 0x0f, 4]], [[0x55, 0xaa]]]).samples);
assert.deepEqual(values(a.decodeSpi(), 'mosi'), [0x55]); assert(warning(a.decodeSpi(), 'INCOMPLETE'));
// Clock khi CS HIGH bi bo qua, giao dich sau van dong bo.
const normal = spiWave(0, [[[0x55, 0xaa]]]);
use([4, 7, 4, 7, 4, ...normal.samples]);
assert.deepEqual(values(a.decodeSpi(), 'mosi'), [0x55]);
// Capture bat dau giua giao dich: khong tu nhan 8 bit tiep theo la byte dau.
use(normal.samples.slice(12));
assert.equal(a.decodeSpi().length, 0); assert(warning(a.decodeSpi(), 'CAPTURE BOUNDARY'));
// Cuoi capture: byte day du co the hien nhung gan CAPTURE END; byte thieu khong duoc hien.
use(spiWave(0, [[[0x55, 0xaa], [0xf0, 0x0f, 4]]], { cutLast: true }).samples);
assert.deepEqual(values(a.decodeSpi(), 'mosi'), [0x55]);
assert.equal(a.decodeSpi()[0].boundary, true); assert(warning(a.decodeSpi(), 'INCOMPLETE'));
// CS va SCK doi cung mau khi assert/deassert: khong xuat byte co ve hop le.
const assertAmbiguous = normal.samples.slice(); assertAmbiguous[5] |= 1;
use(assertAmbiguous); assert.equal(a.decodeSpi().length, 0); assert(warning(a.decodeSpi(), 'TIMING'));
const deassertAmbiguous = normal.samples.slice();
const release = deassertAmbiguous.findIndex((value, i) => i && (value & 4) && !(deassertAmbiguous[i - 1] & 4));
deassertAmbiguous[release] |= 1;
use(deassertAmbiguous); assert.equal(a.decodeSpi().length, 0); assert(warning(a.decodeSpi(), 'TIMING'));
settings({ spiMode: 2 }); use(normal.samples); assert.equal(a.decodeSpi().length, 0);
settings({ spiMode: 0 }); use(spiWave(0, [[[0x55, 0xaa]]], { half: 1 }).samples);
assert(warning(a.decodeSpi(), 'Dưới 8'));
settings({ spiMiso: 1 }); assert(a.decodeSpi().configError); assert.equal(a.decodeSpi().length, 0);
settings({ spiMiso: 3 }); use(Array(30).fill(4)); assert(warning(a.decodeSpi(), 'Chưa thấy CS'));

function uartWave(bytes, { spb = 10, stop = 1 } = {}) {
  const samples = Array(spb * 12).fill(1);
  for (const value of bytes) {
    samples.push(...Array(spb).fill(0));
    for (let bit = 0; bit < 8; bit++) samples.push(...Array(spb).fill((value >> bit) & 1));
    samples.push(...Array(spb).fill(stop));
  }
  return samples;
}
const message = [0x55, 0xaa, 0x45, 0x54, 0x56, 0x49, 0x45, 0x57, 0x0d, 0x0a];
use(uartWave(message)); assert.deepEqual(values(a.decodeUart(), 'value'), message);
assert.equal(a.decodeUart().warnings.length, 0);
// 1 MHz / 115200 khong nguyen mau/bit; tao tin hieu theo thoi gian that.
settings({ uartBaud: 115200 });
const spb = 1000000 / 115200;
const fractionalUart = Array.from({ length: Math.ceil(spb * (2 + message.length * 10)) }, (_, index) => {
  const symbol = Math.floor(index / spb) - 2;
  if (symbol < 0) return 1;
  const frame = Math.floor(symbol / 10), bit = symbol % 10;
  if (frame >= message.length || bit === 9) return 1;
  return bit === 0 ? 0 : (message[frame] >> (bit - 1)) & 1;
});
use(fractionalUart, 1000000); assert.deepEqual(values(a.decodeUart(), 'value'), message);
// Quet moi pha canh start voi ty so Fs/baud khong nguyen. Moi byte 0..255.
// Jitter co gioi han tao tu cac deadline TX, khong lay tu chi so decoder.
function physicalUart(bytes, rate, phase, seed = 1, jitterUs = 0) {
  const ticksPerBit = rate / 115200;
  const start = 20 + phase, edges = [];
  for (let byte = 0; byte < bytes.length; byte++) {
    for (let symbol = 0; symbol < 10; symbol++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      edges.push({
        time: start + (byte * 10 + symbol) * ticksPerBit +
          (seed / 4294967296) * jitterUs * rate / 1e6,
        level: symbol === 0 ? 0 : symbol === 9 ? 1 : (bytes[byte] >> (symbol - 1)) & 1,
      });
    }
  }
  edges.push({ time: start + bytes.length * 10 * ticksPerBit + jitterUs * rate / 1e6, level: 1 });
  let edge = 0, level = 1;
  return Array.from({ length: Math.ceil(start + (bytes.length * 10 + 2) * ticksPerBit) }, (_, index) => {
    while (edge < edges.length && edges[edge].time <= index) level = edges[edge++].level;
    return level;
  });
}
const allUartBytes = Array.from({ length: 256 }, (_, value) => value);
for (const rate of [500000, 1000000]) {
  for (let phase = 0; phase < 100; phase++) {
    use(physicalUart(allUartBytes, rate, phase / 100), rate);
    assert.deepEqual(values(a.decodeUart(), 'value'), allUartBytes);
    assert(a.decodeUart().every(frame => !frame.framingError));
  }
}
// Regression: decoder cu bi lech muon va sai byte trong nhieu seed nay.
for (let seed = 1; seed <= 100; seed++) {
  use(physicalUart(allUartBytes, 500000, 0, seed, 2), 500000);
  assert.deepEqual(values(a.decodeUart(), 'value'), allUartBytes);
  assert(a.decodeUart().every(frame => !frame.framingError));
}
// Capture giua byte: khong gan nham STOP BIT OK thanh byte da dong bo.
// UART lien tuc khong co idle dai van hien ket qua uoc doan, khong bi bo het.
use(physicalUart(allUartBytes, 500000, 0), 500000);
assert(a.decodeUart().every(frame => frame.unsynchronized));
assert(warning(a.decodeUart(), 'UNSYNC'));
// Regression tu CSV thuc: tai hien dung 82,82,6A(error),0A o dau cua so.
const boundaryFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/uart_capture_boundary.json'), 'utf8'));
let boundaryLevel = boundaryFixture.initialLevel;
const boundarySamples = boundaryFixture.runLengths.flatMap(length => {
  const run = Array(length).fill(boundaryLevel);
  boundaryLevel ^= 1;
  return run;
});
assert.equal(boundarySamples.length, boundaryFixture.sampleCount);
use(boundarySamples, boundaryFixture.sampleRate);
const boundaryFrames = a.decodeUart();
assert.deepEqual(values(boundaryFrames.slice(0, 4), 'value'), [0x82, 0x82, 0x6a, 0x0a]);
assert(boundaryFrames.slice(0, 4).every(frame => frame.unsynchronized));
assert(boundaryFrames[2].framingError);
const uartText = Array.from(Buffer.from('UART TEST 115200\r\n'));
assert.deepEqual(values(boundaryFrames.slice(4), 'value'), uartText);
assert(boundaryFrames.slice(4).every(frame => !frame.unsynchronized && !frame.framingError));
element('uartEnabled').checked = true;
a.renderDecodedData();

assert(element('decodedTableBody').innerHTML.includes('STOP BIT OK'));
assert(element('decodedTableBody').innerHTML.includes('UNSYNC'));
assert.equal(a.records().filter(r=>r.protocol==='UART'&&r.kind==='FRAME'&&r.unsynchronized).length,4);
element('uartEnabled').checked = false;
settings({ uartBaud: 10000 });
use([1, 1, 0, 1, ...Array(10).fill(1), ...uartWave([0x55])]);
assert.deepEqual(values(a.decodeUart(), 'value'), [0x55]);
use(uartWave([0x55], { stop: 0 })); assert.equal(a.decodeUart()[0].framingError, true);
use(uartWave([0x55]).slice(0, -7));
assert.equal(a.decodeUart().length, 0); assert(warning(a.decodeUart(), 'INCOMPLETE'));
use(uartWave([0x55]).slice(0, 25)); assert.equal(a.decodeUart().length, 0);
use(uartWave([0x55], { spb: 4 }), 40000); assert(warning(a.decodeUart(), 'Dưới 8'));
use(uartWave([0x55], { spb: 2 }), 20000); assert(a.decodeUart().configError);
// Idle HIGH/LOW dai khong sinh byte; remap RX sang D5.
use(Array(400).fill(1)); assert.equal(a.decodeUart().length, 0);
use(Array(400).fill(0)); assert.equal(a.decodeUart().length, 0);
settings({ uartChannel: 5 }); use(uartWave([0xa6]).map(value => value << 5));
assert.deepEqual(values(a.decodeUart(), 'value'), [0xa6]); settings({ uartChannel: 0 });

function i2cBuilder() {
  const samples = []; let scl = 1, sda = 1;
  const hold = () => { for (let i = 0; i < 5; i++) samples.push(scl | (sda << 1)); };
  const start = () => { scl = 0; hold(); sda = 1; hold(); scl = 1; hold(); sda = 0; hold(); };
  const byte = (value, ack = true) => {
    for (let bit = 7; bit >= -1; bit--) {
      scl = 0; hold(); sda = bit < 0 ? (ack ? 0 : 1) : (value >> bit) & 1; hold();
      scl = 1; hold(); scl = 0; hold();
    }
  };
  const stop = () => { scl = 0; hold(); sda = 0; hold(); scl = 1; hold(); sda = 1; hold(); };
  hold(); return { samples, start, byte, stop };
}
const bus = i2cBuilder(); bus.start(); bus.byte(0xa0); bus.byte(0x55); bus.byte(0xaa); bus.stop();
use(bus.samples); let events = a.decodeI2c();
assert.deepEqual(values(events, 'kind'), ['START', 'ADDRESS', 'DATA', 'DATA', 'STOP']);
assert.deepEqual(Array.from(events.filter(event => event.value !== null), event => event.value), [0xa0, 0x55, 0xaa]);
assert.equal(events[1].address, 0x50); assert.equal(events[1].read, false);
assert.equal(events[1].ack, true); assert.equal(events.warnings.length, 0);
element('i2cEnabled').checked = true;
a.renderDecodedData();  a.updateDecoderFeedback();
assert(element('decodedTableBody').innerHTML.includes('Address 0x50 · Write · ACK'));
assert(a.records().some(r=>r.kind==='ADDRESS'&&r.address===0x50&&r.ack));
element('i2cEnabled').checked = false;
assert(a.i2cEventInfo(events[1]).includes('Address 0x50 · Write · ACK'));
const restart = i2cBuilder(); restart.start(); restart.byte(0xa0); restart.byte(0x11);
restart.start(); restart.byte(0xa1); restart.byte(0x42, false); restart.stop();
use(restart.samples); events = a.decodeI2c();
assert(events.some(event => event.kind === 'RESTART'));
assert(events.some(event => event.kind === 'ADDRESS' && event.read));
assert(events.some(event => event.kind === 'DATA' && !event.ack));
assert.equal(events.warnings.length, 0);
// Truong hop cu bi nhan nham STOP: rising SCL va rising SDA cung mau.
use([3, 1, 0, 3]); events = a.decodeI2c();
assert.deepEqual(values(events, 'kind'), ['START']); assert(warning(events, 'TIMING'));
use(bus.samples.slice(22)); assert.equal(a.decodeI2c().length, 0); assert(warning(a.decodeI2c(), 'CAPTURE BOUNDARY'));
use(bus.samples.slice(0, 58)); assert(warning(a.decodeI2c(), 'INCOMPLETE'));
const ten = i2cBuilder(); ten.start(); ten.byte(0xf0); ten.byte(0x12); ten.stop();
use(ten.samples); events = a.decodeI2c();
assert(warning(events, 'UNSUPPORTED')); assert.deepEqual(values(events, 'kind'), ['START', 'ADDRESS', 'STOP']);
assert(events[1].unsupported); assert.equal(events[1].address, null);
settings({ i2cSda: 0 }); assert(a.decodeI2c().configError); settings({ i2cSda: 1 });

// Cache invalidation khi doi snapshot, sample rate va settings; render dung chung ket qua.
settings({ spiMode: 0 }); use(normal.samples);
assert.equal(a.decodeSpi(), a.decodeSpi());
s.samples = normal.samples.slice(); const fresh = a.decodeSpi();
settings({ spiMiso: 4 }); assert.notEqual(fresh, a.decodeSpi()); settings({ spiMiso: 3 });
element('spiEnabled').checked = true;
a.renderDecodedData();  a.updateDecoderFeedback();
assert(element('decodedTableBody').innerHTML.includes('MOSI 0x55 / MISO 0xAA'));
assert(a.records().some(r=>r.kind==='WORD'&&r.mosi===0x55&&r.miso===0xaa));
assert(element('decodedTableBody').innerHTML.includes('data-sample="' + normal.samplingEdges[0] + '"'));
assert.equal(a.records().filter(r=>r.protocol==='SPI'&&r.kind==='WORD').length,1);
settings({ spiMiso: 1 }); a.updateDecoderFeedback();
assert(element('spiDecodeStatus').textContent.includes('khác nhau'));

console.log('PASS decoders: SPI four modes/CS/MOSI/MISO/boundaries, UART 8N1, I2C 7-bit/ACK/restart/timing, shared records/table/cache');
module.exports = { passed: true, protocols: ['UART 8N1', 'I2C 7-bit', 'SPI modes 0–3, four channels'] };
