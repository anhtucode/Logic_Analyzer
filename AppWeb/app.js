"use strict";

const COLORS = ["#ff4058", "#ff9418", "#f2d21a", "#43d34b", "#22c8d8", "#3d9df2", "#a05be8", "#ef57b7"];
const CAPTURE_RATES = [1000, 5000, 10000, 50000, 100000, 500000, 1000000];
const STREAM_RATES = [1000, 5000, 10000, 50000, 100000, 500000];
const MAX_SAMPLES = 8192;
const STREAM_UI_PERIOD_MS = 50;
// Dem phia PC, khong chiem SRAM STM32. Giam backpressure khi JS tam ban.
const SERIAL_BUFFER_BYTES = 1024 * 1024;
const CRC_TABLE = Uint16Array.from({ length: 256 }, (_, value) => {
  let crc = value << 8;
  for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  return crc;
});
const $ = (id) => document.getElementById(id);

const COMMAND = Object.freeze({
  GET_INFO: 0x01, GET_STATUS: 0x02, GET_CONFIG: 0x03, SET_CONFIG: 0x04,
  ARM: 0x05, STOP: 0x06, GET_DATA: 0x07,
  START_STREAM: 0x08, STOP_STREAM: 0x09,
  RUN_SELF_TEST: 0x0a, STOP_SELF_TEST: 0x0b,
});
const RESPONSE = Object.freeze({
  ACK: 0x80, NACK: 0x81, INFO: 0x82, STATUS: 0x83,
  CONFIG: 0x84, DATA: 0x85, STREAM: 0x86,
});
const DEVICE_STATES = ["IDLE", "ARMED", "TRIGGERED", "COMPLETE", "STREAMING", "TIMEOUT", "ERROR"];
const ERROR_NAMES = ["NONE", "INVALID_CONFIG", "BUSY", "DMA", "OVERRUN", "NOT_READY", "BAD_PACKET"];

const state = {
  port: null, reader: null, writer: null, connected: false, reading: false,
  infoSeen: false, configSeen: false, firmwareSupportsSelfTest: false,
  pendingStart: false, mode: "CAPTURE", deviceState: "DISCONNECTED",
  samples: [], sampleRate: 100000, triggerIndex: 0, captureId: 0, flags: 0,
  visible: Array(8).fill(true), selectedChannel: 0,
  cursorA: 0, cursorB: 0, activeCursor: "A", cursorSnap: true,
  interactionMode: "CURSOR", dragging: null, dragCursor: null,
  panAnchorX: 0, panViewStart: 0, panViewEnd: 1,
  viewStart: 0, viewEnd: 1, demo: false, logs: [],
  parser: { buffer: new Uint8Array(65536), read: 0, write: 0 }, sequence: 0, pendingCommand: null,
  statusTimer: null, captureDownload: null, lastStreamNext: null, loadedCaptureId: null,
  stopRequested: false, restartRequested: false,
  selfTestPending: false, selfTestRunRequested: false,
  selfTestRunning: false, selfTestStopRequested: false,
  selfTestStopCapture: false, selfTestMode: 0, selfTestRepeat: false,
  lastStatusAlert: "",
  streamRing: new Uint8Array(MAX_SAMPLES), streamWrite: 0, streamCount: 0,
  streamDirty: false, streamTimer: null, streamAccept: false, streamFault: false,
  streamId: null, lastStreamSequence: null, waveformFrame: null,
};

function formatRate(value) {
  if (value >= 1000000) return (value / 1000000) + " MSa/s";
  if (value >= 1000) return (value / 1000) + " kSa/s";
  return value + " Sa/s";
}

function formatTime(seconds) {
  const abs = Math.abs(seconds);
  if (!Number.isFinite(seconds)) return "—";
  if (abs >= 1) return seconds.toFixed(3) + " s";
  if (abs >= 0.001) return (seconds * 1000).toFixed(3) + " ms";
  if (abs > 0 && abs < 0.000001) return (seconds * 1e9).toFixed(1) + " ns";
  return (seconds * 1e6).toFixed(3) + " µs";
}

function formatFrequency(value) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1e6) return (value / 1e6).toFixed(3) + " MHz";
  if (value >= 1e3) return (value / 1e3).toFixed(3) + " kHz";
  return value.toFixed(3) + " Hz";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function fillRateSelect(select, mode, preferred) {
  const rates = (mode === "STREAM" ? STREAM_RATES : CAPTURE_RATES).filter(rate=>!state.hardwareMaxRate||rate<=state.hardwareMaxRate);
  select.innerHTML = rates.map((rate) =>
    '<option value="' + rate + '">' + formatRate(rate) + "</option>"
  ).join("");
  const fallback = mode === "STREAM" ? 5000 : 100000;
  select.value = String(rates.includes(preferred) ? preferred : rates.includes(fallback) ? fallback : rates[0]);
}

function setSelfTestStatus(text, style = "") {
  const host = $("selfTestStatus");
  host.textContent = text;
  host.classList.remove("running", "error");
  if (style) host.classList.add(style);
}

function updateSelfTestWiring() {
  const mode = Number($("selfTestProtocol").value);
  const descriptions = {
    1: "Tháo dây PB0 nếu đang nối D0\nPA9 (TX) → PA0 (D0)\nUART 9600 · 8-N-1",
    2: "Tháo dây PB0 nếu đang nối D0\nPB10 (SCL) → PA0 (D0)\nPB11 (SDA) → PA1 (D1)",
    3: "Tháo dây PB0 nếu đang nối D0\nPB13 (SCK) → PA0 (D0)\nPB15 (MOSI) → PA1 (D1)\nBộ phát cũ chỉ có SCK/MOSI.\nKhông đủ để kiểm thử decoder SPI 4 chân.",
  };
  $("selfTestWiring").textContent = descriptions[mode];
}

function prepareSelfTestCapture(mode) {
  setMode("CAPTURE");
  syncRate(mode === 1 ? 100000 : (mode === 2 ? 10000 : 500000));
  /* Giu lai mot doan idle truoc trigger de decoder thay duoc canh START/start bit. */
  $("pretriggerSelect").value = "1";
  $("timeoutSelect").value = "2000";
  $("uartEnabled").checked = mode === 1;
  $("i2cEnabled").checked = mode === 2;
  $("spiEnabled").checked = mode === 3;

  if (mode === 1) {
    $("triggerEdge").value = "1";
    $("triggerChannel").value = "0";
    $("uartChannel").value = "0";
    $("uartBaud").value = "9600";
    $("selectedChannel").value = "0";
  } else if (mode === 2) {
    $("triggerEdge").value = "1";
    $("triggerChannel").value = "1";
    $("i2cScl").value = "0";
    $("i2cSda").value = "1";
    $("selectedChannel").value = "1";
  } else {
    $("triggerEdge").value = "0";
    $("triggerChannel").value = "0";
    $("spiClk").value = "0";
    $("spiMosi").value = "1";
    $("selectedChannel").value = "0";
  }
  updateSelectedChannel();
  refreshAnalysis();
}

async function runSelfTest() {
  if (!state.connected) {
    alert("Hãy kết nối STM32 trước khi chạy Self Test.");
    return;
  }
  if (!state.firmwareSupportsSelfTest) {
    alert("Firmware hiện tại chưa hỗ trợ Self Test an toàn. Hãy build và nạp firmware 1.3 mới.");
    return;
  }
  if (state.selfTestRunning || state.selfTestPending || state.selfTestRunRequested) {
    logEvent("Self Test đang chạy hoặc đang được chuẩn bị.", "error");
    return;
  }

  state.selfTestMode = Number($("selfTestProtocol").value);
  state.selfTestRepeat = $("selfTestRepeat").value === "1";
  state.selfTestPending = true;
  state.selfTestStopRequested = false;
  state.selfTestStopCapture = false;
  prepareSelfTestCapture(state.selfTestMode);
  setSelfTestStatus("ARMING CAPTURE…", "running");
  logEvent("Chuẩn bị Self Test: ARM trước, sau đó mới phát tín hiệu mẫu.");
  await startAcquisition();
}

async function tryRunSelfTest() {
  if (!state.connected || state.pendingCommand || !state.selfTestRunRequested) return;
  const payload = new Uint8Array([state.selfTestMode, state.selfTestRepeat ? 1 : 0]);
  if (await sendCommand(COMMAND.RUN_SELF_TEST, payload)) {
    state.selfTestRunRequested = false;
  }
}

async function stopSelfTest(stopCapture = false) {
  state.selfTestPending = false;
  state.selfTestRunRequested = false;
  state.selfTestStopCapture = state.selfTestStopCapture || stopCapture;
  state.selfTestStopRequested = true;
  setSelfTestStatus("STOPPING…", "running");
  await tryStopSelfTest();
}

async function tryStopSelfTest() {
  if (!state.connected || state.pendingCommand || !state.selfTestStopRequested) return;
  if (await sendCommand(COMMAND.STOP_SELF_TEST)) {
    state.selfTestStopRequested = false;
  }
}

async function connectSerial() {
  if (state.connected) {
    await disconnectSerial();
    return;
  }
  if (!("serial" in navigator)) {
    alert("Web Serial không được hỗ trợ. Hãy dùng Chrome hoặc Edge.");
    return;
  }
  try {
    state.port = await navigator.serial.requestPort();
    await state.port.open({ baudRate: 115200, bufferSize: SERIAL_BUFFER_BYTES });
    state.connected = true;
    state.infoSeen = false;
    state.configSeen = false;
    state.firmwareSupportsSelfTest = false;
    state.pendingCommand = null;
    resetSerialParser();
    state.streamAccept = false;
    state.streamFault = false;
    state.reading = true;
    updateConnectionUi();
    logEvent("Đã kết nối STM32 USB CDC.", "ok");
    readSerialLoop();
    state.statusTimer = setInterval(pollDeviceStatus, 150);
    await sendCommand(COMMAND.GET_INFO);
  } catch (error) {
    logEvent("Không thể kết nối: " + error.message, "error");
  }
}

async function disconnectSerial() {
  state.streamAccept = false;
  flushStreamView();
  state.reading = false;
  if (state.statusTimer) clearInterval(state.statusTimer);
  state.statusTimer = null;
  try {
    if (state.reader) await state.reader.cancel();
    if (state.port) await state.port.close();
  } catch (error) {
    logEvent("Ngắt kết nối: " + error.message, "error");
  }
  state.reader = null;
  state.writer = null;
  state.port = null;
  state.connected = false;
  state.pendingCommand = null;
  state.pendingStart = false;
  state.stopRequested = false;
  state.restartRequested = false;
  state.selfTestPending = false;
  state.selfTestRunRequested = false;
  state.selfTestRunning = false;
  state.selfTestStopRequested = false;
  state.selfTestStopCapture = false;
  state.firmwareSupportsSelfTest = false;
  resetSerialParser();
  state.deviceState = "DISCONNECTED";
  setSelfTestStatus("OFF");
  updateConnectionUi();
  updateFooterStatus();
}

async function readSerialLoop() {
  while (state.port && state.port.readable && state.reading) {
    const reader = state.port.readable.getReader();
    state.reader = reader;
    try {
      while (state.reading) {
        const result = await reader.read();
        if (result.done) break;
        if (result.value) parseSerialBytes(result.value);
      }
    } catch (error) {
      if (state.reading) {
        if (state.streamAccept) failStream("Lỗi đọc USB: " + error.message);
        else logEvent("Lỗi đọc USB: " + error.message, "error");
      }
    } finally {
      reader.releaseLock();
      if (state.reader === reader) state.reader = null;
    }
  }
}

function crc16Ccitt(data) {
  let crc = 0xffff;
  for (const value of data) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ value) & 0xff]) & 0xffff;
  }
  return crc;
}

function commandName(command) {
  return Object.keys(COMMAND).find((name) => COMMAND[name] === command) || "0x" + command.toString(16);
}

function buildFrame(type, sequence, payload = new Uint8Array()) {
  const frame = new Uint8Array(9 + payload.length);
  const view = new DataView(frame.buffer);
  frame[0] = 0xa5;
  frame[1] = 0x5a;
  frame[2] = 1;
  frame[3] = type;
  frame[4] = sequence;
  view.setUint16(5, payload.length, true);
  frame.set(payload, 7);
  view.setUint16(7 + payload.length, crc16Ccitt(frame.subarray(2, 7 + payload.length)), true);
  return frame;
}

async function sendCommand(command, payload = new Uint8Array(), quiet = false) {
  if (!state.port || !state.port.writable) {
    if (!quiet) logEvent("Chưa kết nối thiết bị.", "error");
    return false;
  }
  if (state.pendingCommand) return false;

  const sequence = state.sequence++ & 0xff;
  const frame = buildFrame(command, sequence, payload);
  state.pendingCommand = { command, sequence, sentAt: performance.now() };
  try {
    const writer = state.port.writable.getWriter();
    state.writer = writer;
    if (!quiet) logEvent("TX  " + commandName(command) + " seq=" + sequence);
    await writer.write(frame);
    writer.releaseLock();
    state.writer = null;
    return true;
  } catch (error) {
    state.pendingCommand = null;
    state.writer = null;
    logEvent("Lỗi gửi lệnh: " + error.message, "error");
    return false;
  }
}

function resetSerialParser() {
  state.parser.read = state.parser.write = 0;
}

function drainSerialFrames() {
  const parser = state.parser;
  const buffer = parser.buffer;
  while (parser.write - parser.read >= 2) {
    const start = parser.read;
    if (buffer[start] !== 0xa5 || buffer[start + 1] !== 0x5a) {
      parser.read++;
      continue;
    }
    if (parser.write - start < 9) break;
    const length = buffer[start + 5] | (buffer[start + 6] << 8);
    if (buffer[start + 2] !== 1 || length > 2048) {
      state.metrics.packetErrors = (state.metrics.packetErrors || 0) + 1;
      if (state.streamAccept) failStream("Header STREAM không hợp lệ.");
      parser.read++;
      continue;
    }
    if (parser.write - start < 9 + length) break;
    const frame = buffer.subarray(start, start + 9 + length);
    parser.read += frame.length;
    const crc = frame[7 + length] | (frame[8 + length] << 8);
    if (crc !== crc16Ccitt(frame.subarray(2, 7 + length))) {
      state.metrics.packetErrors = (state.metrics.packetErrors || 0) + 1;
      if (state.streamAccept) failStream("CRC sai: stream đã bị gián đoạn.");
      else logEvent("RX CRC sai; bỏ packet.", "error");
      continue;
    }
    // Payload chi song den lan compact tiep theo; handler copy ngay vao ring.
    handleDeviceFrame(frame[3], frame[4], frame.subarray(7, 7 + length));
  }
  if (parser.read === parser.write) resetSerialParser();
}

function parseSerialBytes(bytes) {
  state.metrics.bytes += bytes.length;
  const parser = state.parser;
  let offset = 0;
  while (offset < bytes.length) {
    if (parser.read) {
      parser.buffer.copyWithin(0, parser.read, parser.write);
      parser.write -= parser.read;
      parser.read = 0;
    }
    const count = Math.min(bytes.length - offset, parser.buffer.length - parser.write);
    parser.buffer.set(bytes.subarray(offset, offset + count), parser.write);
    parser.write += count;
    offset += count;
    drainSerialFrames();
  }
}

function clearPending(type, sequence) {
  if (type === RESPONSE.STREAM) return;
  if (state.pendingCommand && state.pendingCommand.sequence === sequence) {
    const command = state.pendingCommand.command;
    state.pendingCommand = null;
    return command;
  }
  return null;
}

function applyStatus(payload) {
  if (payload.length !== 20) throw new Error("STATUS length không hợp lệ");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const status = {
    state: payload[0], error: payload[1], flags: view.getUint16(2, true),
    captureId: view.getUint32(4, true), validSamples: view.getUint16(8, true),
    triggerIndex: view.getUint16(10, true), rate: view.getUint32(12, true),
    droppedBlocks: view.getUint32(16, true),
  };
  state.deviceState = DEVICE_STATES[status.state] || "UNKNOWN";
  state.actualDeviceState = state.deviceState;
  state.deviceRate = status.rate;
  state.deviceFlags = status.flags;
  state.deviceDroppedBlocks = status.droppedBlocks;
  if (!state.samples.length) {
    state.flags = status.flags;
    state.sampleRate = status.rate || state.sampleRate;
    state.captureId = status.captureId;
  }
  if ((state.streamAccept || state.mode === "STREAM") && status.state === 6) {
    failStream("Thiết bị báo " + (ERROR_NAMES[status.error] || status.error) +
      streamOverrunDetail(status.flags) + "; dropped blocks=" + status.droppedBlocks);
  }
  if (state.streamFault) {
    state.deviceState = "ERROR";
    state.flags |= 1;
  }
  if (status.state === 5 || status.state === 6) {
    const signature = status.state + ":" + status.error + ":" + status.flags;
    if (signature !== state.lastStatusAlert) {
      state.lastStatusAlert = signature;
      logEvent("STATUS " + (DEVICE_STATES[status.state] || status.state) +
        " · " + (ERROR_NAMES[status.error] || status.error) +
        " · flags=0x" + status.flags.toString(16).padStart(4, "0"), "error");
    }
  } else {
    state.lastStatusAlert = "";
  }
  syncRate(status.rate);
  updateFooterStatus();
  return status;
}

function applyConfig(payload) {
  if (payload.length !== 20) throw new Error("CONFIG length không hợp lệ");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const mode = payload[0] === 1 ? "STREAM" : "CAPTURE";
  setMode(mode);
  const rate = view.getUint32(12, true) || view.getUint32(8, true);
  state.depth = view.getUint16(4, true);
  if ($("depthSelect")) $("depthSelect").value = String(state.depth);
  state.requestedRate = view.getUint32(8, true);
  state.deviceConfig = {triggerType: payload[1] === 0 ? "2" : payload[1] === 2 ? "1" : "0", channel: payload[2], pretrigger: payload[3]};
  if (!state.samples.length) { state.sampleRate = rate; state.captureConfig = {...state.deviceConfig}; }
  state.deviceRate = rate;
  syncRate(rate);
  $("triggerChannel").value = String(payload[2]);
  $("pretriggerSelect").value = String(payload[3]);
  $("timeoutSelect").value = String(view.getUint32(16, true));
  const edge = payload[1] === 0 ? "2" : (payload[1] === 2 ? "1" : "0");
  $("triggerEdge").value = edge;
  state.configSeen = true;
  refreshAnalysis();
}

function requestCaptureChunk(status) {
  if (status.validSamples === 0 || state.loadedCaptureId === status.captureId) return;
  if (!state.captureDownload || state.captureDownload.id !== status.captureId) {
    state.captureDownload = {
      id: status.captureId, total: status.validSamples, offset: 0,
      trigger: status.triggerIndex, rate: status.rate, flags: status.flags, samples: [],
    };
  }
  if (state.pendingCommand) return;
  const download = state.captureDownload;
  const count = Math.min(512, download.total - download.offset);
  if (count <= 0) return;
  const request = new Uint8Array(4);
  const view = new DataView(request.buffer);
  view.setUint16(0, download.offset, true);
  view.setUint16(2, count, true);
  sendCommand(COMMAND.GET_DATA, request, true);
}

function receiveDataPacket(payload) {
  if (payload.length < 16) throw new Error("DATA packet quá ngắn");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const id = view.getUint32(0, true);
  const offset = view.getUint16(4, true);
  const count = view.getUint16(6, true);
  if (payload.length !== 16 + count) throw new Error("DATA count không khớp");
  if (!state.captureDownload || state.captureDownload.id !== id) return;

  const download = state.captureDownload;
  if (offset !== download.offset) {
    logEvent("DATA sai offset: nhận " + offset + ", cần " + download.offset, "error");
    return;
  }
  download.samples.push(...payload.subarray(16));
  download.offset += count;
  if (download.offset < download.total) {
    requestCaptureChunk({
      captureId: download.id, validSamples: download.total,
      triggerIndex: download.trigger, rate: download.rate, flags: download.flags,
    });
  } else {
    receiveCapture({
      id: download.id, rate: download.rate, trigger: download.trigger, flags: download.flags,
    }, download.samples);
    state.loadedCaptureId = download.id;
    state.captureDownload = null;
  }
}

function streamOverrunDetail(flags) {
  if (flags & 4) return " · QUEUE_FULL: queue 8 block đầy, đường truyền chưa lấy dữ liệu kịp";
  if (flags & 8) return " · DMA_LATE: CPU chưa xử lý kịp nửa DMA trước khi bị ghi đè";
  return "";
}

function failStream(message) {
  if (state.streamFault) return;
  state.streamFault = true;
  state.streamAccept = false;
  state.deviceState = "ERROR";
  state.flags |= 1;
  state.metrics.errors++; state.metrics.gaps++;
  state.gaps = [{index: state.streamTotal, missing: null, reason: message}];
  if (state.decoder) state.decoder.gap(state.streamTotal, message, null);
  flushStreamView();
  logEvent("STREAM không hợp lệ: " + message + " Nhấn Start để thu phiên mới.", "error");
  requestStop(false);
  refreshAnalysis(false);
}

function receiveStreamPacket(payload, sequence) {
  if (!state.streamAccept || state.streamFault) return;
  if (payload.length < 16) {
    failStream("STREAM packet quá ngắn.");
    return;
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const info = {
    id: view.getUint32(0, true), first: view.getUint32(4, true),
    rate: view.getUint32(8, true), count: view.getUint16(12, true),
    flags: view.getUint16(14, true),
  };
  if (!info.count || info.count > 1024 || payload.length !== 16 + info.count ||
      !STREAM_RATES.includes(info.rate) || info.rate !== state.sampleRate || info.flags) {
    failStream("Metadata STREAM không hợp lệ hoặc có cờ lỗi.");
    return;
  }
  if (state.lastStreamNext === null) {
    if (info.first !== 0) {
      failStream("Thiếu block đầu tiên.");
      return;
    }
    state.streamId = info.id;
    logEvent("Nhận STREAM #" + info.id + ": " + info.count + " mẫu/block @ " +
      formatRate(info.rate), "ok");
  } else if (info.id !== state.streamId || info.first !== state.lastStreamNext ||
             sequence !== ((state.lastStreamSequence + 1) & 0xff)) {
    if (sequence !== ((state.lastStreamSequence + 1) & 0xff)) state.metrics.sequenceGaps = (state.metrics.sequenceGaps || 0) + 1;
    failStream("Sai stream ID/sequence/sample index; cần sample " +
      state.lastStreamNext + ", nhận " + info.first + ".");
    return;
  }
  state.lastStreamNext = (info.first + info.count) >>> 0;
  state.lastStreamSequence = sequence;
  state.flags = info.flags;
  receiveStream(info, payload.subarray(16));
}

function handleDeviceFrame(type, sequence, payload) {
  const command = clearPending(type, sequence);
  let startAfterStop = false;
  let stopCaptureAfterSelfTest = false;
  try {
    if (type === RESPONSE.INFO) {
      if (payload.length !== 10) throw new Error("INFO length không hợp lệ");
      state.infoSeen = true;
      state.hardwareMaxDepth = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(4, true);
      state.hardwareMaxRate = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(6, true);
      if ($("depthSelect")) for (const option of $("depthSelect").options || []) option.disabled = Number(option.value) > state.hardwareMaxDepth;
      state.firmwareSupportsSelfTest = payload[0] > 1 || (payload[0] === 1 && payload[1] >= 3);
      logEvent("RX INFO firmware " + payload[0] + "." + payload[1] + ", " + payload[2] + " kênh", "ok");
      sendCommand(COMMAND.GET_STATUS, new Uint8Array(), true);
    } else if (type === RESPONSE.STATUS) {
      const status = applyStatus(payload);
      if ((status.state === 5 || status.state === 6) &&
          (state.selfTestRunning || state.selfTestPending || state.selfTestRunRequested)) {
        stopSelfTest(false);
      }
      if (!state.configSeen) {
        sendCommand(COMMAND.GET_CONFIG, new Uint8Array(), true);
      } else if (status.state === 3) {
        requestCaptureChunk(status);
      }
    } else if (type === RESPONSE.CONFIG) {
      applyConfig(payload);
      logEvent("Đã đồng bộ cấu hình từ STM32.", "ok");
    } else if (type === RESPONSE.ACK || type === RESPONSE.NACK) {
      if (payload.length !== 4) throw new Error("ACK/NACK length không hợp lệ");
      const acknowledged = payload[0];
      const deviceState = payload[1];
      const error = payload[2];
      const wasStarting = state.pendingStart;
      state.deviceState = DEVICE_STATES[deviceState] || state.deviceState;
      state.actualDeviceState = state.deviceState;
      if (state.streamFault) state.deviceState = "ERROR";
      if (type === RESPONSE.NACK) {
        state.pendingStart = false;
        logEvent("NACK " + commandName(acknowledged) + ": " + (ERROR_NAMES[error] || error), "error");
        if (acknowledged === COMMAND.RUN_SELF_TEST) {
          state.selfTestPending = false;
          state.selfTestRunRequested = false;
          state.selfTestRunning = false;
          setSelfTestStatus("ERROR: " + (ERROR_NAMES[error] || error), "error");
        } else if (acknowledged === COMMAND.STOP_SELF_TEST) {
          state.selfTestStopRequested = false;
          setSelfTestStatus("STOP ERROR", "error");
        } else if (acknowledged === COMMAND.ARM && state.selfTestPending) {
          state.selfTestPending = false;
          setSelfTestStatus("ARM ERROR", "error");
        }
        if (acknowledged === COMMAND.SET_CONFIG && error === 2 && wasStarting) {
          logEvent("Thiết bị đang bận; web sẽ Stop rồi Start lại.");
          requestStop(true);
        }
      } else {
        const reportedState = DEVICE_STATES[deviceState] || "UNKNOWN";
        logEvent("ACK " + commandName(acknowledged) + ": " + reportedState +
          (state.streamFault ? " · Web giữ ERROR của phiên trước" : ""), "ok");
        if (acknowledged === COMMAND.START_STREAM && !state.streamFault) {
          state.streamAccept = true;
        }
        if (acknowledged === COMMAND.STOP_STREAM) {
          state.streamAccept = false;
          if (state.decoder) state.decoder.finish();
          flushStreamView();
          refreshAnalysis();
        }
        if (acknowledged === COMMAND.SET_CONFIG && state.pendingStart) {
          sendCommand(state.mode === "STREAM" ? COMMAND.START_STREAM : COMMAND.ARM);
        } else if (acknowledged === COMMAND.ARM && state.selfTestPending) {
          state.selfTestPending = false;
          state.selfTestRunRequested = true;
          setSelfTestStatus("WAITING TO TRANSMIT…", "running");
        } else if (acknowledged === COMMAND.RUN_SELF_TEST) {
          state.selfTestRunning = true;
          setSelfTestStatus(state.selfTestRepeat ? "RUNNING · REPEAT" : "RUNNING · ONE SHOT", "running");
        } else if (acknowledged === COMMAND.STOP_SELF_TEST) {
          state.selfTestRunning = false;
          state.selfTestStopRequested = false;
          setSelfTestStatus("OFF");
          stopCaptureAfterSelfTest = state.selfTestStopCapture;
          state.selfTestStopCapture = false;
        } else if ((acknowledged === COMMAND.STOP || acknowledged === COMMAND.STOP_STREAM) &&
                   state.restartRequested) {
          state.restartRequested = false;
          startAfterStop = true;
        } else if (acknowledged === COMMAND.STOP || acknowledged === COMMAND.STOP_STREAM) {
          state.selfTestRunning = false;
          state.selfTestPending = false;
          state.selfTestRunRequested = false;
          setSelfTestStatus("OFF");
        }
      }
      updateFooterStatus();
    } else if (type === RESPONSE.DATA) {
      receiveDataPacket(payload);
    } else if (type === RESPONSE.STREAM) {
      receiveStreamPacket(payload, sequence);
    } else {
      logEvent("RX packet type 0x" + type.toString(16) + " không hỗ trợ.", "error");
    }
  } catch (error) {
    state.pendingStart = false;
    logEvent("Lỗi giải mã packet: " + error.message, "error");
  }

  if (command === COMMAND.ARM || command === COMMAND.START_STREAM) {
    state.pendingStart = false;
  }
  if (startAfterStop && !state.pendingCommand) {
    setTimeout(startAcquisition, 0);
    return;
  }
  if (stopCaptureAfterSelfTest && !state.pendingCommand) {
    setTimeout(() => requestStop(false), 0);
    return;
  }
  if (state.selfTestRunRequested && !state.pendingCommand) {
    tryRunSelfTest();
    return;
  }
  if (state.selfTestStopRequested && !state.pendingCommand) {
    tryStopSelfTest();
    return;
  }
  if (state.stopRequested && !state.pendingCommand) trySendStop();
}

function makeConfigPayload(mode, rate) {
  const payload = new Uint8Array(20);
  const view = new DataView(payload.buffer);
  const edge = $("triggerEdge").value;
  payload[0] = mode === "STREAM" ? 1 : 0;
  payload[1] = edge === "2" ? 0 : (edge === "0" ? 1 : 2);
  payload[2] = Number($("triggerChannel").value);
  payload[3] = Number($("pretriggerSelect").value);
  view.setUint16(4, state.depth || MAX_SAMPLES, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, rate, true);
  view.setUint32(12, 0, true);
  view.setUint32(16, Number($("timeoutSelect").value), true);
  return payload;
}

async function startAcquisition() {
  if (!state.connected) {
    alert("Hãy kết nối STM32 trước khi START.");
    return;
  }
  const mode = $("modeSelect").value;
  const rate = Number($("rateSelect").value);
  if (["ARMED", "TRIGGERED", "STREAMING"].includes(state.deviceState)) {
    logEvent("Đang thu dữ liệu; web sẽ Stop rồi Start lại.");
    requestStop(true);
    return;
  }
  if (state.pendingCommand) {
    logEvent("Thiết bị đang xử lý lệnh trước.", "error");
    return;
  }
  state.mode = mode;
  state.stopRequested = false;
  state.restartRequested = false;
  state.pendingStart = true;
  state.deviceState = "CONFIGURING";
  state.sampleRate = rate;
  state.requestedRate = rate;
  state.dataRequestedRate = rate; state.dataDepth = state.depth;
  state.actualDeviceState = "CONFIGURING";
  state.dataMode = mode;
  state.captureConfig = {triggerType: $("triggerEdge").value, channel: Number($("triggerChannel").value), pretrigger: Number($("pretriggerSelect").value)};
  state.streamTotal = 0; state.decoder = null; state.decoderKey = "";
  state.gaps = []; state.followLive = true; state.metrics = {bytes:0,samples:0,packets:0,errors:0,gaps:0,evicted:0,since:performance.now()};
  const pcCapacity = Number($("pcBufferSelect")?.value) || MAX_SAMPLES;
  state.streamRing = new Uint8Array(pcCapacity);
  state.loadedCaptureId = null;
  state.demo = false;
  state.streamAccept = false;
  state.streamFault = false;
  state.streamId = state.lastStreamSequence = state.lastStreamNext = null;
  clearSamples();
  refreshAnalysis();
  updateFooterStatus();
  if (!await sendCommand(COMMAND.SET_CONFIG, makeConfigPayload(mode, rate))) {
    state.pendingStart = false;
  }
}

async function stopAcquisition() {
  if (state.selfTestRunning || state.selfTestPending || state.selfTestRunRequested) {
    await stopSelfTest(true);
  } else {
    await requestStop(false);
  }
}

async function requestStop(restart) {
  state.pendingStart = false;
  state.restartRequested = restart;
  state.stopRequested = true;
  await trySendStop();
}

async function trySendStop() {
  if (!state.connected || state.pendingCommand || !state.stopRequested) return;
  state.stopRequested = false;
  if (!await sendCommand(state.mode === "STREAM" ? COMMAND.STOP_STREAM : COMMAND.STOP)) {
    state.stopRequested = true;
  }
}

function pollDeviceStatus() {
  if (!state.connected) return;
  if (state.pendingCommand) {
    if (performance.now() - state.pendingCommand.sentAt > 2000) {
      const timedOutCommand = state.pendingCommand.command;
      logEvent("Timeout chờ phản hồi " + commandName(timedOutCommand), "error");
      state.pendingCommand = null;
      state.pendingStart = false;
      if (timedOutCommand === COMMAND.RUN_SELF_TEST || timedOutCommand === COMMAND.STOP_SELF_TEST) {
        state.selfTestPending = false;
        state.selfTestRunRequested = false;
        state.selfTestRunning = false;
        state.selfTestStopRequested = false;
        setSelfTestStatus("COMMAND TIMEOUT", "error");
      }
    } else {
      return;
    }
  }
  if (state.selfTestStopRequested) {
    tryStopSelfTest();
    return;
  }
  if (state.selfTestRunRequested) {
    tryRunSelfTest();
    return;
  }
  if (state.stopRequested) {
    trySendStop();
    return;
  }
  if (["ARMED", "TRIGGERED", "STREAMING"].includes(state.deviceState)) {
    sendCommand(COMMAND.GET_STATUS, new Uint8Array(), true);
  }
}

function i2cEventInfo(event) {
  if (event.unsupported) return "UNSUPPORTED · địa chỉ 10 bit";
  const ack = event.ack ? "ACK" : "NACK";
  if (event.kind === "ADDRESS") return "Address 0x" + event.address.toString(16).padStart(2, "0").toUpperCase() +
    " · " + (event.read ? "Read" : "Write") + " · " + ack;
  return event.value === null ? "—" : ack;
}

function hexByte(value) {
  return "0x" + value.toString(16).padStart(2, "0").toUpperCase();
}

function refreshAnalysis(redraw = true) {
  updateDecoderFeedback();
  updateStats();
  renderDecodedData();
  renderMeasurements();
  updateCursorInfo();
  updateFooterStatus();
  if (redraw) {
    if (state.waveformFrame !== null) cancelAnimationFrame(state.waveformFrame);
    state.waveformFrame = null;
    drawWaveform();
  } else if (state.waveformFrame === null) {
    state.waveformFrame = requestAnimationFrame(() => {
      state.waveformFrame = null;
      drawWaveform();
    });
  }
}

function updateConnectionUi() {
  if (!state.connected) state.actualDeviceState = "DISCONNECTED";
  $("connectBtn").classList.toggle("connected", state.connected);
  $("connectBtn").classList.toggle("disconnected", !state.connected);
  $("connectionText").textContent = state.connected ? "Connected" : "Kết nối";
}

function sampleToX(index, left, width) {
  return left + (index - state.viewStart) * width / Math.max(1, state.viewEnd - state.viewStart);
}

function xToSample(x, left, width) {
  const ratio = Math.max(0, Math.min(1, (x - left) / width));
  return Math.round(state.viewStart + ratio * (state.viewEnd - state.viewStart));
}

function isEdgeAt(index, channel, type = "any") {
  if (index <= 0 || index >= state.samples.length) return false;
  const previous = (state.samples[index - 1] >> channel) & 1;
  const current = (state.samples[index] >> channel) & 1;
  if (previous === current) return false;
  if (type === "rising") return previous === 0 && current === 1;
  if (type === "falling") return previous === 1 && current === 0;
  return true;
}

function nearestEdge(sample, channel, type = "any") {
  if (state.samples.length < 2) return sample;
  const origin = Math.max(1, Math.min(state.samples.length - 1, Math.round(sample)));
  for (let distance = 0; distance < state.samples.length; distance++) {
    const before = origin - distance;
    const after = origin + distance;
    if (before >= 1 && isEdgeAt(before, channel, type)) return before;
    if (after < state.samples.length && after !== before && isEdgeAt(after, channel, type)) return after;
  }
  return sample;
}

function setActiveCursor(cursor) {
  state.activeCursor = cursor;
  $("cursorAPill").classList.toggle("active", cursor === "A");
  $("cursorBPill").classList.toggle("active", cursor === "B");
}

function setCursorSample(sample, center = false, forceSnap = false) {
  if (!state.samples.length) return;
  let target = Math.max(0, Math.min(state.samples.length - 1, Math.round(sample)));
  if (forceSnap || state.cursorSnap) target = nearestEdge(target, state.selectedChannel, "any");
  if (state.activeCursor === "A") state.cursorA = target;
  else state.cursorB = target;
  if (center) centerViewOn(target);
  updateCursorInfo();
  drawWaveform();
}

function centerViewOn(sample) {
  const maximum = Math.max(1, state.samples.length - 1);
  const span = Math.min(maximum, Math.max(1, state.viewEnd - state.viewStart));
  state.viewStart = Math.max(0, sample - span / 2);
  state.viewEnd = Math.min(maximum, state.viewStart + span);
  state.viewStart = Math.max(0, state.viewEnd - span);
}

function navigateEdge(direction) {
  if (!state.samples.length) return;
  const channel = state.selectedChannel;
  const type = $("edgeNavType").value;
  const current = state.activeCursor === "A" ? state.cursorA : state.cursorB;
  for (let index = current + direction; index > 0 && index < state.samples.length; index += direction) {
    if (isEdgeAt(index, channel, type)) {
      const snapBefore = state.cursorSnap;
      state.cursorSnap = false;
      setCursorSample(index, true, false);
      state.cursorSnap = snapBefore;
      return;
    }
  }
  logEvent("Không còn " + (type === "rising" ? "cạnh lên" : type === "falling" ? "cạnh xuống" : "cạnh") +
    " theo hướng đã chọn trên D" + channel + ".");
}

function pulseAt(sample, channel) {
  if (!state.samples.length) return null;
  const index = Math.max(0, Math.min(state.samples.length - 1, Math.round(sample)));
  const level = (state.samples[index] >> channel) & 1;
  let start = index;
  let end = index;
  while (start > 0 && (((state.samples[start - 1] >> channel) & 1) === level)) start--;
  while (end + 1 < state.samples.length && (((state.samples[end + 1] >> channel) & 1) === level)) end++;
  return {
    level, start, end,
    duration: (end - start + 1) / state.sampleRate,
    clippedStart: start === 0,
    clippedEnd: end === state.samples.length - 1,
  };
}

function drawMarker(context, sample, label, color, left, width, top, bottom, textColor = "#fff") {
  if (sample < state.viewStart || sample > state.viewEnd) return;
  const x = sampleToX(sample, left, width);
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  context.setLineDash([5, 4]);
  context.beginPath(); context.moveTo(x, top); context.lineTo(x, bottom); context.stroke();
  context.setLineDash([]);
  context.fillStyle = color;
  context.beginPath(); context.roundRect(x - 10, top - 14, 20, 18, 5); context.fill();
  context.fillStyle = textColor;
  context.textAlign = "center";
  context.font = "bold 11px Segoe UI";
  context.fillText(label, x, top - 5);
}

function downloadBlob(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  URL.revokeObjectURL(url);
}

function resetDashboard() {
  if (state.selfTestRunning || state.selfTestPending || state.selfTestRunRequested) {
    stopSelfTest(false);
  }
  if (state.connected && ["ARMED", "TRIGGERED", "STREAMING"].includes(state.deviceState)) {
    requestStop(false);
  }
  clearSamples();
  state.demo = false;
  state.loadedCaptureId = null;
  state.captureId = 0;
  if (!state.connected) state.deviceState = "DISCONNECTED";
  refreshAnalysis();
  logEvent("Đã xóa dữ liệu waveform trên dashboard.");
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      $(button.dataset.tab + "Tab").classList.add("active");
    });
  });
}

