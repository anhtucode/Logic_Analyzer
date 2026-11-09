"use strict";

const COLORS = ["#ff4058", "#ff9418", "#f2d21a", "#43d34b", "#22c8d8", "#3d9df2", "#a05be8", "#ef57b7"];
const CAPTURE_RATES = [1000, 5000, 10000, 50000, 100000, 500000, 1000000];
const STREAM_RATES = [1000, 5000, 10000];
const MAX_SAMPLES = 8192;
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
  parser: { buffer: [] }, sequence: 0, pendingCommand: null,
  statusTimer: null, captureDownload: null, lastStreamNext: null, loadedCaptureId: null,
  stopRequested: false, restartRequested: false,
  selfTestPending: false, selfTestRunRequested: false,
  selfTestRunning: false, selfTestStopRequested: false,
  selfTestStopCapture: false, selfTestMode: 0, selfTestRepeat: false,
  lastStatusAlert: "",
};

function formatRate(value) {
  if (value >= 1000000) return (value / 1000000) + " MSa/s";
  if (value >= 1000) return (value / 1000) + " kSa/s";
  return value + " Sa/s";
}

function formatTime(seconds) {
  const abs = Math.abs(seconds);
  if (abs >= 1) return seconds.toFixed(3) + " s";
  if (abs >= 0.001) return (seconds * 1000).toFixed(3) + " ms";
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

function logEvent(message, type = "info") {
  const now = new Date().toLocaleTimeString("vi-VN", {
    hour12: false, hour: "2-digit", minute: "2-digit",
    second: "2-digit", fractionalSecondDigits: 3,
  });
  state.logs.push({ time: now, message, type });
  if (state.logs.length > 300) state.logs.shift();
  renderLogs();
}

function renderLogs() {
  const host = $("eventLog");
  host.innerHTML = state.logs.map((item) =>
    '<div class="event-row ' + item.type + '">[' + item.time + "] " + escapeHtml(item.message) + "</div>"
  ).join("");
  if ($("autoScroll").checked) host.scrollTop = host.scrollHeight;
}

function fillRateSelect(select, mode, preferred) {
  const rates = mode === "STREAM" ? STREAM_RATES : CAPTURE_RATES;
  select.innerHTML = rates.map((rate) =>
    '<option value="' + rate + '">' + formatRate(rate) + "</option>"
  ).join("");
  select.value = String(rates.includes(preferred) ? preferred : (mode === "STREAM" ? 5000 : 100000));
}

function fillChannelSelect(select, selected = 0) {
  select.innerHTML = Array.from({ length: 8 }, (_, channel) =>
    '<option value="' + channel + '">D' + channel + "</option>"
  ).join("");
  select.value = String(selected);
}

function buildChannelControls() {
  $("channelList").innerHTML = Array.from({ length: 8 }, (_, channel) =>
    '<div class="channel-row">' +
      '<input class="channel-visible" data-channel="' + channel + '" type="checkbox" checked>' +
      '<span class="color-dot" style="background:' + COLORS[channel] + '"></span>' +
      '<span class="channel-name"><b>D' + channel + '</b><small>PA' + channel + '</small></span>' +
      '<i id="logicA' + channel + '" class="logic-state">—</i>' +
      '<i id="logicB' + channel + '" class="logic-state">—</i>' +
    "</div>"
  ).join("");

  document.querySelectorAll(".channel-visible").forEach((box) => {
    box.addEventListener("change", () => {
      const channel = Number(box.dataset.channel);
      state.visible[channel] = box.checked;
      updateStats();
      drawWaveform();
    });
  });

}

function clearSamples() {
  state.samples = [];
  state.triggerIndex = 0;
  state.cursorA = 0;
  state.cursorB = 0;
  state.viewStart = 0;
  state.viewEnd = 1;
  state.captureDownload = null;
  state.lastStreamNext = null;
}

function setMode(mode, source = null) {
  state.mode = mode;
  if (source !== $("modeSelect")) $("modeSelect").value = mode;
  if (source !== $("sideModeSelect")) $("sideModeSelect").value = mode;
  const sourceRate = source === $("sideModeSelect") ? $("sideRateSelect") : $("rateSelect");
  const preferred = Number(sourceRate.value) || state.sampleRate;
  fillRateSelect($("rateSelect"), mode, preferred);
  fillRateSelect($("sideRateSelect"), mode, preferred);
  $("sideRateSelect").value = $("rateSelect").value;
  const capture = mode === "CAPTURE";
  $("pretriggerSelect").disabled = !capture;
  $("timeoutSelect").disabled = !capture;
  $("triggerChannel").disabled = !capture;
  $("triggerEdge").disabled = !capture;
  updateFooterStatus();
}

function syncRate(value, source = null) {
  if (source !== $("rateSelect")) $("rateSelect").value = String(value);
  if (source !== $("sideRateSelect")) $("sideRateSelect").value = String(value);
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
    3: "Tháo dây PB0 nếu đang nối D0\nPB13 (SCK) → PA0 (D0)\nPB15 (MOSI) → PA1 (D1)",
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
    await state.port.open({ baudRate: 115200, bufferSize: 16384 });
    state.connected = true;
    state.infoSeen = false;
    state.configSeen = false;
    state.firmwareSupportsSelfTest = false;
    state.pendingCommand = null;
    state.parser.buffer = [];
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
  state.parser.buffer = [];
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
      if (state.reading) logEvent("Lỗi đọc USB: " + error.message, "error");
    } finally {
      reader.releaseLock();
      if (state.reader === reader) state.reader = null;
    }
  }
}

function crc16Ccitt(data) {
  let crc = 0xffff;
  for (const value of data) {
    crc ^= value << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
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
    await writer.write(frame);
    writer.releaseLock();
    state.writer = null;
    if (!quiet) logEvent("TX  " + commandName(command) + " seq=" + sequence);
    return true;
  } catch (error) {
    state.pendingCommand = null;
    state.writer = null;
    logEvent("Lỗi gửi lệnh: " + error.message, "error");
    return false;
  }
}

function parseSerialBytes(bytes) {
  state.parser.buffer.push(...bytes);
  const buffer = state.parser.buffer;

  while (buffer.length >= 2) {
    while (buffer.length >= 2 && (buffer[0] !== 0xa5 || buffer[1] !== 0x5a)) buffer.shift();
    if (buffer.length < 9) return;
    if (buffer[2] !== 1) {
      buffer.splice(0, 2);
      continue;
    }

    const payloadLength = buffer[5] | (buffer[6] << 8);
    if (payloadLength > 2048) {
      buffer.splice(0, 2);
      continue;
    }
    const frameLength = 9 + payloadLength;
    if (buffer.length < frameLength) return;

    const frame = Uint8Array.from(buffer.slice(0, frameLength));
    const receivedCrc = frame[7 + payloadLength] | (frame[8 + payloadLength] << 8);
    const calculatedCrc = crc16Ccitt(frame.subarray(2, 7 + payloadLength));
    buffer.splice(0, frameLength);
    if (receivedCrc !== calculatedCrc) {
      logEvent("RX CRC sai; bỏ packet.", "error");
      continue;
    }
    handleDeviceFrame(frame[3], frame[4], frame.subarray(7, 7 + payloadLength));
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
  state.flags = status.flags;
  state.sampleRate = status.rate || state.sampleRate;
  state.captureId = status.captureId;
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
  syncRate(state.sampleRate);
  updateFooterStatus();
  return status;
}

function applyConfig(payload) {
  if (payload.length !== 20) throw new Error("CONFIG length không hợp lệ");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const mode = payload[0] === 1 ? "STREAM" : "CAPTURE";
  setMode(mode);
  const rate = view.getUint32(12, true) || view.getUint32(8, true);
  state.sampleRate = rate;
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

function receiveStreamPacket(payload) {
  if (payload.length < 16) throw new Error("STREAM packet quá ngắn");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const info = {
    id: view.getUint32(0, true), first: view.getUint32(4, true),
    rate: view.getUint32(8, true), count: view.getUint16(12, true),
    flags: view.getUint16(14, true),
  };
  if (payload.length !== 16 + info.count) throw new Error("STREAM count không khớp");
  if (state.lastStreamNext === null) {
    logEvent("Nhận STREAM #" + info.id + ": " + info.count + " mẫu/block @ " +
      formatRate(info.rate), "ok");
  } else if (info.first !== state.lastStreamNext) {
    logEvent("Mất block stream: cần sample " + state.lastStreamNext + ", nhận " + info.first, "error");
  }
  state.lastStreamNext = info.first + info.count;
  state.flags = info.flags;
  receiveStream(info, Array.from(payload.subarray(16)));
}

function handleDeviceFrame(type, sequence, payload) {
  const command = clearPending(type, sequence);
  let startAfterStop = false;
  let stopCaptureAfterSelfTest = false;
  try {
    if (type === RESPONSE.INFO) {
      if (payload.length !== 10) throw new Error("INFO length không hợp lệ");
      state.infoSeen = true;
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
        logEvent("ACK " + commandName(acknowledged) + ": " + state.deviceState, "ok");
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
      receiveStreamPacket(payload);
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
  view.setUint16(4, MAX_SAMPLES, true);
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
  state.loadedCaptureId = null;
  state.demo = false;
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
  if (["ARMED", "TRIGGERED"].includes(state.deviceState)) {
    sendCommand(COMMAND.GET_STATUS, new Uint8Array(), true);
  }
}

function receiveCapture(info, payload) {
  state.samples = payload;
  state.sampleRate = info.rate;
  state.triggerIndex = Math.min(info.trigger, payload.length - 1);
  state.captureId = info.id;
  state.flags = info.flags;
  state.demo = false;
  state.deviceState = info.flags ? "ERROR" : "COMPLETE";
  state.viewStart = 0;
  state.viewEnd = Math.max(1, payload.length - 1);
  state.cursorA = Math.round(payload.length * 0.35);
  state.cursorB = Math.round(payload.length * 0.70);
  logEvent("Capture #" + info.id + ": " + payload.length.toLocaleString() + " mẫu @ " + formatRate(info.rate), info.flags ? "error" : "ok");
  refreshAnalysis();
  if (!state.selfTestRepeat &&
      (state.selfTestRunning || state.selfTestPending || state.selfTestRunRequested)) {
    stopSelfTest(false);
  }
}

function receiveStream(info, payload) {
  state.sampleRate = info.rate;
  state.samples.push(...payload);
  if (state.samples.length > MAX_SAMPLES) state.samples.splice(0, state.samples.length - MAX_SAMPLES);
  state.triggerIndex = Math.max(0, state.samples.length - 1);
  state.viewStart = 0;
  state.viewEnd = Math.max(1, state.samples.length - 1);
  state.cursorA = Math.round(state.samples.length * 0.35);
  state.cursorB = Math.round(state.samples.length * 0.70);
  state.demo = false;
  state.deviceState = "STREAMING";
  refreshAnalysis(false);
}

function measureChannel(channel) {
  const rising = [];
  let highCount = 0;
  let transitions = 0;
  for (let index = 1; index < state.samples.length; index++) {
    const previous = (state.samples[index - 1] >> channel) & 1;
    const current = (state.samples[index] >> channel) & 1;
    if (current) highCount++;
    if (current !== previous) transitions++;
    if (!previous && current) rising.push(index);
  }
  if (state.samples.length && ((state.samples[0] >> channel) & 1)) highCount++;
  if (rising.length < 2) {
    return { frequency: null, period: null, duty: state.samples.length ? highCount * 100 / state.samples.length : null, high: null, low: null, transitions };
  }
  const periods = [];
  for (let i = 1; i < Math.min(rising.length, 20); i++) periods.push(rising[i] - rising[i - 1]);
  const periodSamples = periods.reduce((a, b) => a + b, 0) / periods.length;
  const period = periodSamples / state.sampleRate;
  let falling = null;
  for (let i = rising[0] + 1; i < rising[1]; i++) {
    if (((state.samples[i - 1] >> channel) & 1) && !((state.samples[i] >> channel) & 1)) {
      falling = i; break;
    }
  }
  const high = falling === null ? null : (falling - rising[0]) / state.sampleRate;
  return {
    frequency: 1 / period, period,
    duty: high === null ? null : high * 100 / period,
    high, low: high === null ? null : period - high, transitions,
  };
}

function decodeUart() {
  const channel = Number($("uartChannel").value);
  const baud = Number($("uartBaud").value);
  const samplesPerBit = state.sampleRate / baud;
  const frames = [];
  if (samplesPerBit < 3) return frames;
  let index = 1;
  while (index < state.samples.length) {
    const previous = (state.samples[index - 1] >> channel) & 1;
    const current = (state.samples[index] >> channel) & 1;
    if (previous === 1 && current === 0) {
      /*
       * Xac nhan day thuc su la start bit. Mot glitch ngan khi UART duoc
       * khoi tao lai co the tao canh xuong, nhung giua start bit se da ve 1.
       */
      const startSample = Math.round(index + 0.5 * samplesPerBit);
      if (startSample >= state.samples.length) break;
      if (((state.samples[startSample] >> channel) & 1) !== 0) {
        index++;
        continue;
      }
      let value = 0;
      let valid = true;
      for (let bit = 0; bit < 8; bit++) {
        const sampleIndex = Math.round(index + (1.5 + bit) * samplesPerBit);
        if (sampleIndex >= state.samples.length) { valid = false; break; }
        value |= ((state.samples[sampleIndex] >> channel) & 1) << bit;
      }
      if (!valid) break;
      const stopIndex = Math.round(index + 9.5 * samplesPerBit);
      const framingError = stopIndex >= state.samples.length || (((state.samples[stopIndex] >> channel) & 1) === 0);
      frames.push({
        index, value, framingError,
        endIndex: Math.min(state.samples.length - 1, Math.round(index + 10 * samplesPerBit)),
      });
      index = Math.max(index + 1, Math.round(index + 10 * samplesPerBit));
    } else index++;
  }
  return frames;
}

function decodeI2c() {
  const sclChannel = Number($("i2cScl").value);
  const sdaChannel = Number($("i2cSda").value);
  const events = [];
  let active = false;
  let bits = [];
  let byteIndex = 0;

  /*
   * Capture cu voi pre-trigger 0% co the bat dau ngay tai mau START:
   * SCL=1, SDA=0. Danh dau START o bien buffer de van doc duoc frame cu;
   * cac capture Self Test moi dung pre-trigger 1% nen se co canh day du.
   */
  if (state.samples.length > 0) {
    const first = state.samples[0];
    const firstScl = (first >> sclChannel) & 1;
    const firstSda = (first >> sdaChannel) & 1;
    if (firstScl === 1 && firstSda === 0) {
      events.push({ index: 0, kind: "START", value: null, boundary: true });
      active = true;
    }
  }

  for (let index = 1; index < state.samples.length; index++) {
    const previous = state.samples[index - 1];
    const current = state.samples[index];
    const sclPrevious = (previous >> sclChannel) & 1;
    const scl = (current >> sclChannel) & 1;
    const sdaPrevious = (previous >> sdaChannel) & 1;
    const sda = (current >> sdaChannel) & 1;

    if (scl && sdaPrevious && !sda) {
      events.push({ index, kind: active ? "RESTART" : "START", value: null });
      active = true;
      bits = [];
      byteIndex = 0;
      continue;
    }
    if (scl && !sdaPrevious && sda) {
      if (active) events.push({ index, kind: "STOP", value: null });
      active = false;
      bits = [];
      continue;
    }
    if (active && !sclPrevious && scl) {
      bits.push(sda);
      if (bits.length === 9) {
        let value = 0;
        for (let bit = 0; bit < 8; bit++) value = (value << 1) | bits[bit];
        events.push({
          index, kind: byteIndex === 0 ? "ADDRESS" : "DATA",
          value, ack: bits[8] === 0,
        });
        bits = [];
        byteIndex++;
      }
    }
  }
  return events;
}

function decodeSpi() {
  const clockChannel = Number($("spiClk").value);
  const dataChannel = Number($("spiMosi").value);
  const words = [];
  let bits = [];
  let startIndex = null;
  for (let index = 1; index < state.samples.length; index++) {
    const clockBefore = (state.samples[index - 1] >> clockChannel) & 1;
    const clockNow = (state.samples[index] >> clockChannel) & 1;
    if (!clockBefore && clockNow) {
      if (bits.length === 0) startIndex = index;
      bits.push((state.samples[index] >> dataChannel) & 1);
      if (bits.length === 8) {
        let value = 0;
        bits.forEach((bit) => { value = (value << 1) | bit; });
        words.push({ index, startIndex, endIndex: index, value });
        bits = [];
        startIndex = null;
      }
    }
  }
  return words;
}

function renderDecodedData() {
  const events = [];
  const enabled = [];

  if ($("uartEnabled").checked) {
    enabled.push("UART");
    decodeUart().forEach((frame) => {
      const printable = frame.value >= 32 && frame.value <= 126 ?
        " · '" + String.fromCharCode(frame.value) + "'" : "";
      events.push({
        index: frame.index, protocol: "UART",
        data: "0x" + frame.value.toString(16).padStart(2, "0").toUpperCase() + printable,
        info: frame.framingError ? "FRAME ERROR" : "OK",
      });
    });
  }
  if ($("i2cEnabled").checked) {
    enabled.push("I²C");
    decodeI2c().forEach((event) => events.push({
      index: event.index, protocol: "I²C",
      data: event.value === null ? event.kind :
        "0x" + event.value.toString(16).padStart(2, "0").toUpperCase(),
      info: event.value === null ? (event.boundary ? "CAPTURE BOUNDARY" : "—") :
        (event.ack ? "ACK" : "NACK"),
    }));
  }
  if ($("spiEnabled").checked) {
    enabled.push("SPI");
    decodeSpi().forEach((word) => events.push({
      index: word.index, protocol: "SPI",
      data: "0x" + word.value.toString(16).padStart(2, "0").toUpperCase(),
      info: "MOSI · Mode 0",
    }));
  }

  events.sort((a, b) => a.index - b.index);
  const badge = $("decodedBadge");
  const single = enabled.length === 1 ? enabled[0] : "ALL";
  badge.textContent = single;
  badge.className = "protocol-tag " +
    (single === "UART" ? "uart" : single === "I²C" ? "i2c" : single === "SPI" ? "spi" : "all");
  $("decodedTitle").textContent = enabled.length ? enabled.join(" + ") : "Decoded Events";
  $("decodedCount").textContent = events.length + " events";
  $("decodedTableBody").innerHTML = events.slice(0, 300).map((event, index) => {
    const time = (event.index - state.triggerIndex) / state.sampleRate;
    const kind = event.protocol === "UART" ? "uart" : event.protocol === "I²C" ? "i2c" : "spi";
    return '<tr data-sample="' + event.index + '"><td>' + (index + 1) +
      "</td><td>" + formatTime(time) + '</td><td><b class="protocol-tag ' + kind + '">' +
      event.protocol + "</b></td><td>" + escapeHtml(event.data) + "</td><td>" +
      escapeHtml(event.info) + "</td></tr>";
  }).join("");
}

function renderMeasurements() {
  $("measurementsBody").innerHTML = Array.from({ length: 8 }, (_, channel) => {
    const item = measureChannel(channel);
    return '<tr><td><span class="color-dot" style="display:inline-block;background:' + COLORS[channel] +
      '"></span> D' + channel + "</td><td>" + formatFrequency(item.frequency) +
      "</td><td>" + (item.period ? formatTime(item.period) : "—") +
      "</td><td>" + (item.duty === null ? "—" : item.duty.toFixed(1) + "%") +
      "</td><td>" + (item.high ? formatTime(item.high) : "—") +
      "</td><td>" + (item.low ? formatTime(item.low) : "—") + "</td></tr>";
  }).join("");
}

function renderProtocolSummary() {
  const sections = [];
  if ($("uartEnabled").checked) {
    const frames = decodeUart();
    sections.push("<h4>UART · D" + $("uartChannel").value + " · " + $("uartBaud").value +
      " baud <small>(" + frames.length + " frames)</small></h4>");
  }
  if ($("i2cEnabled").checked) {
    const events = decodeI2c();
    const rows = events.slice(0, 120).map((event) => {
      const time = formatTime((event.index - state.triggerIndex) / state.sampleRate);
      const data = event.value === null ? "—" :
        "0x" + event.value.toString(16).padStart(2, "0").toUpperCase() +
        " · " + (event.ack ? "ACK" : "NACK");
      return '<tr data-sample="' + event.index + '"><td>' + time + "</td><td>" + event.kind + "</td><td>" + data + "</td></tr>";
    }).join("");
    sections.push("<h4>I²C · SCL D" + $("i2cScl").value + " · SDA D" + $("i2cSda").value +
      " <small>(" + events.length + " events)</small></h4>" +
      "<div class='table-wrap'><table><thead><tr><th>Time</th><th>Event</th><th>Value</th></tr></thead><tbody>" +
      rows + "</tbody></table></div>");
  }
  if ($("spiEnabled").checked) {
    const words = decodeSpi();
    const rows = words.slice(0, 120).map((word, index) => {
      const time = formatTime((word.index - state.triggerIndex) / state.sampleRate);
      return '<tr data-sample="' + word.index + '"><td>' + (index + 1) + "</td><td>" + time + "</td><td>0x" +
        word.value.toString(16).padStart(2, "0").toUpperCase() + "</td></tr>";
    }).join("");
    sections.push("<h4>SPI Mode 0 · CLK D" + $("spiClk").value + " · MOSI D" +
      $("spiMosi").value + " <small>(" + words.length + " words)</small></h4>" +
      "<div class='table-wrap'><table><thead><tr><th>#</th><th>Time</th><th>MOSI</th></tr></thead><tbody>" +
      rows + "</tbody></table></div>");
  }
  $("protocolResults").innerHTML = sections.length
    ? '<div class="protocol-output">' + sections.join("") + "</div>"
    : "Chưa bật protocol decoder.";
}

function refreshAnalysis(redraw = true) {
  updateStats();
  renderDecodedData();
  renderMeasurements();
  renderProtocolSummary();
  updateCursorInfo();
  updateFooterStatus();
  if (redraw) drawWaveform();
  else requestAnimationFrame(drawWaveform);
}

function updateStats() {
  const count = state.samples.length;
  const duration = count > 1 ? count / state.sampleRate : 0;
  $("captureLength").textContent = formatTime(duration);
  $("totalSamples").textContent = count.toLocaleString();
  $("statSampleRate").textContent = formatRate(state.sampleRate);
  $("activeChannels").textContent = state.visible.filter(Boolean).length + " / 8";
  $("dataSize").textContent = (count / 1024).toFixed(1) + " KiB";
  $("captureSummary").textContent = count
    ? (state.deviceState === "STREAMING" ? "Streaming" : "Capture #" + state.captureId) +
      " · " + formatTime(duration) + " · " + count.toLocaleString() +
      " samples · " + formatRate(state.sampleRate)
    : "Chưa có dữ liệu — nhấn Start để thu tín hiệu";
  $("triggerPosition").textContent = $("pretriggerSelect").value + "%";
  $("triggerSource").textContent = "D" + $("triggerChannel").value;
  {
    const edge = $("triggerEdge").value;
    $("triggerMode").textContent = edge === "2" ? "None" :
      (edge === "0" ? "Rising Edge" : "Falling Edge");
  }
  $("triggerTime").textContent = count ? formatTime(state.triggerIndex / state.sampleRate) : "—";
}

function updateSelectedChannel() {
  const channel = Number($("selectedChannel").value);
  state.selectedChannel = channel;
  const measurement = measureChannel(channel);
  const sampleA = state.samples[Math.min(state.cursorA, state.samples.length - 1)] || 0;
  const sampleB = state.samples[Math.min(state.cursorB, state.samples.length - 1)] || 0;
  $("stateAtA").textContent = state.samples.length ? (((sampleA >> channel) & 1) ? "High (1)" : "Low (0)") : "—";
  $("stateAtB").textContent = state.samples.length ? (((sampleB >> channel) & 1) ? "High (1)" : "Low (0)") : "—";
  $("selectedFrequency").textContent = formatFrequency(measurement.frequency);
  $("selectedPeriod").textContent = measurement.period === null ? "—" : formatTime(measurement.period);
  $("selectedDuty").textContent = measurement.duty === null ? "—" : measurement.duty.toFixed(2) + "%";
  $("selectedPulse").textContent = measurement.high === null
    ? "—"
    : formatTime(measurement.high) + " / " + formatTime(measurement.low);
}

function updateCursorInfo() {
  if (!state.samples.length) {
    ["cursorAText", "cursorBText", "deltaText", "frequencyText", "rightCursorA", "rightCursorB", "rightDelta", "rightDeltaFrequency"]
      .forEach((id) => { $(id).textContent = "—"; });
    for (let channel = 0; channel < 8; channel++) {
      [$("logicA" + channel), $("logicB" + channel)].forEach((badge) => {
        badge.textContent = "—";
        badge.classList.remove("high", "low");
      });
    }
    updateSelectedChannel();
    return;
  }
  state.cursorA = Math.max(0, Math.min(state.samples.length - 1, state.cursorA));
  state.cursorB = Math.max(0, Math.min(state.samples.length - 1, state.cursorB));
  const timeA = (state.cursorA - state.triggerIndex) / state.sampleRate;
  const timeB = (state.cursorB - state.triggerIndex) / state.sampleRate;
  const delta = Math.abs(timeB - timeA);
  $("cursorAText").textContent = "t = " + formatTime(timeA);
  $("cursorBText").textContent = "t = " + formatTime(timeB);
  $("deltaText").textContent = "Δt = " + formatTime(delta);
  $("frequencyText").textContent = "f = " + formatFrequency(delta ? 1 / delta : null);
  $("rightCursorA").textContent = formatTime(timeA);
  $("rightCursorB").textContent = formatTime(timeB);
  $("rightDelta").textContent = formatTime(delta);
  $("rightDeltaFrequency").textContent = formatFrequency(delta ? 1 / delta : null);
  $("triggerTimeText").textContent = "Trigger (t = " + formatTime(0) + ")";
  const sampleA = state.samples[state.cursorA];
  const sampleB = state.samples[state.cursorB];
  for (let channel = 0; channel < 8; channel++) {
    const levelA = (sampleA >> channel) & 1;
    const levelB = (sampleB >> channel) & 1;
    const badgeA = $("logicA" + channel);
    const badgeB = $("logicB" + channel);
    badgeA.textContent = String(levelA);
    badgeB.textContent = String(levelB);
    badgeA.classList.toggle("high", levelA === 1);
    badgeA.classList.toggle("low", levelA === 0);
    badgeB.classList.toggle("high", levelB === 1);
    badgeB.classList.toggle("low", levelB === 0);
  }
  updateSelectedChannel();
}

function updateConnectionUi() {
  $("connectBtn").classList.toggle("connected", state.connected);
  $("connectBtn").classList.toggle("disconnected", !state.connected);
  $("connectionText").textContent = state.connected ? "Connected" : "Kết nối";
}

function updateFooterStatus() {
  const mode = state.mode === "CAPTURE" ? "Capture" : "Streaming";
  $("footerStatus").textContent = state.connected
    ? state.deviceState + " · " + mode + " · " + formatRate(Number($("rateSelect").value) || state.sampleRate)
    : "Chưa kết nối — hãy kết nối STM32 USB CDC";
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
  const span = Math.min(maximum, Math.max(20, state.viewEnd - state.viewStart));
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

function setInteractionMode(mode) {
  state.interactionMode = mode;
  $("cursorBtn").classList.toggle("active", mode === "CURSOR");
  $("panBtn").classList.toggle("active", mode === "PAN");
  document.querySelector(".wave-card").classList.toggle("pan-mode", mode === "PAN");
}

function drawOverlayLabel(context, item, left, plotWidth, top, laneHeight) {
  if (item.end < state.viewStart || item.start > state.viewEnd || !state.visible[item.channel]) return;
  const laneTop = top + item.channel * laneHeight;
  const x1 = Math.max(left, sampleToX(item.start, left, plotWidth));
  const x2 = Math.min(left + plotWidth, sampleToX(item.end, left, plotWidth));
  const boxWidth = Math.max(38, x2 - x1);
  const boxX = Math.max(left, Math.min(left + plotWidth - boxWidth, x1));
  const boxY = laneTop + 2;
  context.save();
  context.beginPath();
  context.rect(left, top, plotWidth, laneHeight * 8);
  context.clip();
  context.fillStyle = item.color + "dd";
  context.fillRect(boxX, boxY, boxWidth, 15);
  context.fillStyle = "#fff";
  context.font = "600 9px Segoe UI";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(item.label, boxX + boxWidth / 2, boxY + 7.5, Math.max(32, boxWidth - 4));
  context.restore();
}

function drawProtocolOverlays(context, left, plotWidth, top, laneHeight) {
  const overlays = [];
  if ($("uartEnabled").checked) {
    const channel = Number($("uartChannel").value);
    decodeUart().slice(0, 160).forEach((frame) => overlays.push({
      channel, start: frame.index, end: frame.endIndex,
      label: "UART 0x" + frame.value.toString(16).padStart(2, "0").toUpperCase(), color: "#9954d8",
    }));
  }
  if ($("i2cEnabled").checked) {
    const channel = Number($("i2cSda").value);
    decodeI2c().slice(0, 160).forEach((event) => overlays.push({
      channel, start: event.index, end: event.index + Math.max(1, Math.round((state.viewEnd - state.viewStart) / 80)),
      label: event.value === null ? "I²C " + event.kind : "I²C 0x" + event.value.toString(16).padStart(2, "0").toUpperCase(),
      color: "#0a9b93",
    }));
  }
  if ($("spiEnabled").checked) {
    const channel = Number($("spiMosi").value);
    decodeSpi().slice(0, 160).forEach((word) => overlays.push({
      channel, start: word.startIndex, end: word.endIndex,
      label: "SPI 0x" + word.value.toString(16).padStart(2, "0").toUpperCase(), color: "#d06b16",
    }));
  }
  overlays.forEach((item) => drawOverlayLabel(context, item, left, plotWidth, top, laneHeight));
}

function drawWaveform() {
  const canvas = $("waveCanvas");
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * dpr);
  canvas.height = Math.round(bounds.height * dpr);
  const context = canvas.getContext("2d");
  context.scale(dpr, dpr);
  const width = bounds.width, height = bounds.height;
  const left = 66, right = 14, top = 30, bottom = 20;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const laneHeight = plotHeight / 8;
  context.fillStyle = "#10151d";
  context.fillRect(0, 0, width, height);
  context.font = "11px Segoe UI";
  context.textAlign = "center";
  context.textBaseline = "middle";

  if (!state.samples.length) {
    context.fillStyle = "#8fa0b5";
    context.font = "600 15px Segoe UI";
    context.textAlign = "center";
    context.fillText(state.connected ? "Chưa có dữ liệu — nhấn Start" :
      "Chưa kết nối thiết bị", width / 2, height / 2);
  }

  for (let grid = 0; grid <= 10; grid++) {
    const x = left + grid * plotWidth / 10;
    context.strokeStyle = grid % 5 === 0 ? "#354353" : "#232d39";
    context.lineWidth = grid % 5 === 0 ? 1 : 0.6;
    context.beginPath(); context.moveTo(x, top); context.lineTo(x, height - bottom); context.stroke();
    const sample = Math.round(state.viewStart + grid * (state.viewEnd - state.viewStart) / 10);
    context.fillStyle = "#c7d0dc";
    context.fillText(formatTime((sample - state.triggerIndex) / state.sampleRate), x, 14);
  }

  for (let channel = 0; channel < 8; channel++) {
    const laneTop = top + channel * laneHeight;
    context.strokeStyle = "#26313e";
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(left, laneTop + laneHeight); context.lineTo(width - right, laneTop + laneHeight); context.stroke();
    context.textAlign = "left";
    context.fillStyle = COLORS[channel];
    context.fillRect(13, laneTop + laneHeight / 2 - 7, 14, 14);
    context.fillStyle = "#dce4ee";
    context.font = "bold 12px Segoe UI";
    context.fillText("D" + channel, 34, laneTop + laneHeight / 2);
    if (!state.visible[channel] || !state.samples.length) continue;
    const start = Math.max(0, Math.floor(state.viewStart));
    const end = Math.min(state.samples.length - 1, Math.ceil(state.viewEnd));
    const highY = laneTop + laneHeight * 0.25;
    const lowY = laneTop + laneHeight * 0.72;
    context.strokeStyle = COLORS[channel];
    context.lineWidth = 2;
    context.beginPath();
    let previous = (state.samples[start] >> channel) & 1;
    context.moveTo(sampleToX(start, left, plotWidth), previous ? highY : lowY);
    const step = Math.max(1, Math.floor((end - start) / Math.max(1, plotWidth * 2)));
    for (let index = start + step; index <= end; index += step) {
      const level = (state.samples[index] >> channel) & 1;
      const x = sampleToX(index, left, plotWidth);
      context.lineTo(x, previous ? highY : lowY);
      if (level !== previous) context.lineTo(x, level ? highY : lowY);
      previous = level;
    }
    context.lineTo(sampleToX(end, left, plotWidth), previous ? highY : lowY);
    context.stroke();
  }
  if (state.samples.length) {
    drawProtocolOverlays(context, left, plotWidth, top, laneHeight);
    drawMarker(context, state.triggerIndex, "T", "#20b85a", left, plotWidth, top, height - bottom);
    drawMarker(context, state.cursorA, "A", "#2386eb", left, plotWidth, top, height - bottom);
    drawMarker(context, state.cursorB, "B", "#e1b800", left, plotWidth, top, height - bottom, "#111");
  }
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

function zoom(factor, anchor = (state.viewStart + state.viewEnd) / 2) {
  const current = state.viewEnd - state.viewStart;
  const maximum = Math.max(1, state.samples.length - 1);
  const span = Math.max(20, Math.min(maximum, current * factor));
  const ratio = current > 0 ? (anchor - state.viewStart) / current : 0.5;
  state.viewStart = Math.max(0, anchor - span * ratio);
  state.viewEnd = Math.min(maximum, state.viewStart + span);
  state.viewStart = Math.max(0, state.viewEnd - span);
  drawWaveform();
}

function fitWaveform() {
  state.viewStart = 0;
  state.viewEnd = Math.max(1, state.samples.length - 1);
  drawWaveform();
}

function downloadBlob(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  URL.revokeObjectURL(url);
}

function saveCapture() {
  if (!state.samples.length) return;
  downloadBlob(JSON.stringify({
    version: 1, sampleRate: state.sampleRate, triggerIndex: state.triggerIndex,
    captureId: state.captureId, samples: state.samples,
  }), "capture-" + (state.captureId || "offline") + ".json", "application/json");
}

function exportCsv() {
  if (!state.samples.length) return;
  const rows = ["sample,time_s,D0,D1,D2,D3,D4,D5,D6,D7"];
  state.samples.forEach((sample, index) => {
    const bits = Array.from({ length: 8 }, (_, channel) => (sample >> channel) & 1);
    rows.push([index, (index - state.triggerIndex) / state.sampleRate, ...bits].join(","));
  });
  downloadBlob(rows.join("\n"), "capture-" + (state.captureId || "offline") + ".csv", "text/csv");
}

async function loadCaptureFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.samples) || !Number(data.sampleRate)) throw new Error("File không hợp lệ");
    state.samples = data.samples.map((value) => Number(value) & 0xff).slice(-MAX_SAMPLES);
    state.sampleRate = Number(data.sampleRate);
    state.triggerIndex = Math.min(Number(data.triggerIndex) || 0, state.samples.length - 1);
    state.captureId = Number(data.captureId) || 0;
    state.demo = false;
    state.deviceState = "LOADED";
    fitWaveform();
    refreshAnalysis();
    logEvent("Đã load " + state.samples.length + " mẫu từ file.", "ok");
  } catch (error) {
    alert("Không đọc được file: " + error.message);
  }
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

function setupCanvasInteraction() {
  const canvas = $("waveCanvas");
  const tooltip = $("canvasTooltip");
  const geometry = () => {
    const bounds = canvas.getBoundingClientRect();
    return { bounds, left: 66, width: bounds.width - 80, top: 30, bottom: 20 };
  };

  const updateHover = (event, g, sample, channel) => {
    if (!state.samples.length || channel < 0 || channel > 7) {
      tooltip.classList.add("hidden");
      return;
    }
    const pulse = pulseAt(sample, channel);
    const level = (state.samples[sample] >> channel) & 1;
    const clipped = pulse.clippedStart || pulse.clippedEnd ? "≥ " : "";
    tooltip.innerHTML = "<b>D" + channel + " · Logic " + level + "</b><br>" +
      (level ? "HIGH" : "LOW") + " width: " + clipped + formatTime(pulse.duration) +
      "<br>t = " + formatTime((sample - state.triggerIndex) / state.sampleRate);
    tooltip.classList.remove("hidden");
    const maxLeft = Math.max(4, g.bounds.width - tooltip.offsetWidth - 8);
    const maxTop = Math.max(4, g.bounds.height - tooltip.offsetHeight - 8);
    tooltip.style.left = Math.min(maxLeft, Math.max(4, event.clientX - g.bounds.left + 12)) + "px";
    tooltip.style.top = Math.min(maxTop, Math.max(4, event.clientY - g.bounds.top + 12)) + "px";
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (!state.samples.length) return;
    const g = geometry();
    const x = event.clientX - g.bounds.left;
    const panRequested = state.interactionMode === "PAN" || event.shiftKey || event.button !== 0;
    if (panRequested) {
      state.dragging = "PAN";
      state.panAnchorX = x;
      state.panViewStart = state.viewStart;
      state.panViewEnd = state.viewEnd;
    } else {
      state.dragging = "CURSOR";
      state.dragCursor = Math.abs(x - sampleToX(state.cursorA, g.left, g.width)) <
        Math.abs(x - sampleToX(state.cursorB, g.left, g.width)) ? "A" : "B";
      setActiveCursor(state.dragCursor);
      setCursorSample(xToSample(x, g.left, g.width));
    }
    tooltip.classList.add("hidden");
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    const g = geometry();
    const x = event.clientX - g.bounds.left;
    const y = event.clientY - g.bounds.top;
    const sample = xToSample(x, g.left, g.width);
    const laneHeight = Math.max(1, (g.bounds.height - g.top - g.bottom) / 8);
    const channel = Math.floor((y - g.top) / laneHeight);
    const validChannel = Math.max(0, Math.min(7, channel));
    const level = state.samples.length ? ((state.samples[sample] >> validChannel) & 1) : "—";
    $("footerPointer").textContent = "t: " + formatTime((sample - state.triggerIndex) / state.sampleRate) +
      " · D" + validChannel + " = " + level;

    if (state.dragging === "PAN") {
      const span = state.panViewEnd - state.panViewStart;
      const maximum = Math.max(1, state.samples.length - 1);
      let start = state.panViewStart - (x - state.panAnchorX) * span / Math.max(1, g.width);
      start = Math.max(0, Math.min(maximum - span, start));
      state.viewStart = start;
      state.viewEnd = start + span;
      drawWaveform();
    } else if (state.dragging === "CURSOR") {
      setCursorSample(sample);
    } else {
      updateHover(event, g, sample, channel);
    }
  });
  const endDrag = (event) => {
    state.dragging = null;
    state.dragCursor = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => {
    if (!state.dragging) tooltip.classList.add("hidden");
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const g = geometry();
    const anchor = xToSample(event.clientX - g.bounds.left, g.left, g.width);
    zoom(event.deltaY > 0 ? 1.25 : 0.8, anchor);
  }, { passive: false });
}

function setupEvents() {
  $("connectBtn").addEventListener("click", connectSerial);
  $("startBtn").addEventListener("click", startAcquisition);
  $("stopBtn").addEventListener("click", stopAcquisition);
  $("runSelfTestBtn").addEventListener("click", runSelfTest);
  $("stopSelfTestBtn").addEventListener("click", () => stopSelfTest(false));
  $("selfTestProtocol").addEventListener("change", updateSelfTestWiring);
  $("resetBtn").addEventListener("click", resetDashboard);
  $("saveBtn").addEventListener("click", saveCapture);
  $("loadBtn").addEventListener("click", () => $("loadInput").click());
  $("loadInput").addEventListener("change", (event) => {
    if (event.target.files[0]) loadCaptureFile(event.target.files[0]);
    event.target.value = "";
  });
  $("exportBtn").addEventListener("click", exportCsv);
  $("themeBtn").addEventListener("click", () => {
    document.body.classList.toggle("dark");
    $("themeBtn").textContent = document.body.classList.contains("dark") ? "☾" : "☀";
    drawWaveform();
  });
  $("modeSelect").addEventListener("change", () => setMode($("modeSelect").value, $("modeSelect")));
  $("sideModeSelect").addEventListener("change", () => setMode($("sideModeSelect").value, $("sideModeSelect")));
  $("rateSelect").addEventListener("change", () => syncRate($("rateSelect").value, $("rateSelect")));
  $("sideRateSelect").addEventListener("change", () => syncRate($("sideRateSelect").value, $("sideRateSelect")));
  $("allChannelsBtn").addEventListener("click", () => {
    state.visible.fill(true);
    document.querySelectorAll(".channel-visible").forEach((box) => { box.checked = true; });
    refreshAnalysis();
  });
  $("noChannelsBtn").addEventListener("click", () => {
    state.visible.fill(false);
    document.querySelectorAll(".channel-visible").forEach((box) => { box.checked = false; });
    refreshAnalysis();
  });
  $("zoomInBtn").addEventListener("click", () => zoom(0.65));
  $("zoomOutBtn").addEventListener("click", () => zoom(1.5));
  $("fitBtn").addEventListener("click", fitWaveform);
  $("cursorBtn").addEventListener("click", () => setInteractionMode("CURSOR"));
  $("panBtn").addEventListener("click", () => setInteractionMode("PAN"));
  $("snapBtn").addEventListener("click", () => {
    state.cursorSnap = !state.cursorSnap;
    $("snapBtn").classList.toggle("active", state.cursorSnap);
  });
  $("prevEdgeBtn").addEventListener("click", () => navigateEdge(-1));
  $("nextEdgeBtn").addEventListener("click", () => navigateEdge(1));
  $("cursorAPill").addEventListener("click", () => setActiveCursor("A"));
  $("cursorBPill").addEventListener("click", () => setActiveCursor("B"));
  $("clearLogBtn").addEventListener("click", () => { state.logs = []; renderLogs(); });
  $("selectedChannel").addEventListener("change", updateSelectedChannel);
  [
    "triggerEdge", "triggerChannel", "pretriggerSelect", "uartChannel", "uartBaud",
    "i2cScl", "i2cSda", "spiClk", "spiMosi",
    "uartEnabled", "i2cEnabled", "spiEnabled",
  ].forEach((id) => $(id).addEventListener("change", () => refreshAnalysis()));
  document.querySelector(".analysis-card").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-sample]");
    if (!row) return;
    setCursorSample(Number(row.dataset.sample), true, false);
  });
  window.addEventListener("resize", drawWaveform);
  if (navigator.serial) {
    navigator.serial.addEventListener("disconnect", (event) => {
      if (event.target === state.port) disconnectSerial();
    });
  }
  setupTabs();
  setupCanvasInteraction();
}

function initialize() {
  buildChannelControls();
  ["triggerChannel", "uartChannel", "i2cScl", "i2cSda", "spiClk", "spiMosi", "selectedChannel"]
    .forEach((id) => fillChannelSelect($(id), 0));
  $("i2cSda").value = "1";
  $("spiMosi").value = "1";
  updateSelfTestWiring();
  setSelfTestStatus("OFF");
  fillRateSelect($("rateSelect"), "CAPTURE", 100000);
  fillRateSelect($("sideRateSelect"), "CAPTURE", 100000);
  clearSamples();
  setupEvents();
  updateConnectionUi();
  refreshAnalysis();
  logEvent("Dashboard sẵn sàng. Hãy kết nối STM32 USB CDC.");
  if (!("serial" in navigator)) logEvent("Web Serial không khả dụng; hãy dùng Chrome/Edge qua localhost.", "error");
}

initialize();



