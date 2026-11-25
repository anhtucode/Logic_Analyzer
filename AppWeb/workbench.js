"use strict";

// UI metadata is indexed by physical D0..D7. Reordering never remaps raw bits.
Object.assign(state, {
  channels: COLORS.map((color, i) => ({name: "D" + i, color, height: 40, group: ""})),
  order: [0,1,2,3,4,5,6,7], collapsedGroups: new Set(),
  sampleOrigin: 0, dataMode: "CAPTURE", triggerIndex: null, captureConfig: null,
  depth: 8192, requestedRate: 100000, actualDeviceState: "DISCONNECTED",
  followLive: true, streamTotal: 0, decoder: null, decoderKey: "", frozenRecords: null,
  gaps: [], selectedEvent: null, selection: null, laneExpanded: new Set(),
  metrics: {bytes: 0, samples: 0, packets: 0, errors: 0, gaps: 0, evicted: 0, since: performance.now()},
  measurementCache: new Map(), offlineCache: null, tableRows: [], geometry: null,
});
const DECODER_IDS = Object.keys(LA.DEFAULTS);
const text = (id, value) => { if ($(id)) $(id).textContent = value; };
const channelName = channel => Number.isInteger(channel)&&channel>=0&&channel<8?(state.channels[channel]?.name||"D"+channel):"—";
const sampleTime = local => (state.sampleOrigin + local - (state.triggerIndex === null ? 0 : state.sampleOrigin + state.triggerIndex)) / state.sampleRate;
const acquiring = () => state.pendingStart || ["ARMED","TRIGGERED","STREAMING"].includes(state.actualDeviceState) || state.streamAccept;
function decoderConfig() {
  return Object.fromEntries(DECODER_IDS.map(id => {
    const el = $(id), base = LA.DEFAULTS[id];
    return [id, typeof base === "boolean" ? !!el?.checked : typeof base === "number" ? Number(el?.value ?? base) : el?.value || base];
  }));
}
function applyDecoderConfig(cfg) {
  for (const id of DECODER_IDS) if ($(id)) {
    if (typeof LA.DEFAULTS[id] === "boolean") $(id).checked = !!cfg[id]; else $(id).value = String(cfg[id]);
  }
}
function analysisEngine() {
  const cfg = decoderConfig(), key = JSON.stringify(cfg);
  if (state.dataMode === "STREAM" && state.followLive && state.decoder && state.decoderKey === key) return state.decoder;
  if (state.offlineCache?.samples === state.samples && state.offlineCache.key === key && state.offlineCache.rate === state.sampleRate) return state.offlineCache.engine;
  const engine = LA.decode(state.samples, state.sampleRate, cfg, state.sampleOrigin);
  state.offlineCache = {samples: state.samples, key, rate: state.sampleRate, engine};
  return engine;
}
function records() {
  const first = state.sampleOrigin, last = first + state.samples.length - 1;
  const cfg=decoderConfig(),engine=state.frozenRecords?null:analysisEngine();
  const cache=state.recordCache,key=JSON.stringify(cfg)+":"+first+":"+(engine?.revision||0);
  if(cache?.samples===state.samples&&cache.frozen===state.frozenRecords&&cache.engine===engine&&cache.key===key)return cache.result;
  const result=(state.frozenRecords || engine.getRecords(first, last+1)).filter(r =>
    r.endIndex >= first && r.startIndex <= last+(r.kind==="GAP"?1:0) &&
    (r.protocol === "SYSTEM" || cfg[r.protocol.toLowerCase() + "Enabled"]));
  state.recordCache={samples:state.samples,frozen:state.frozenRecords,engine,key,result};return result;
}
function localRecord(r) {
  return {...r, index: r.index - state.sampleOrigin, startIndex: r.startIndex - state.sampleOrigin,
    endIndex: r.endIndex - state.sampleOrigin, boundary: !!r.transactionRef?.boundary};
}
const adapterCache = new Map();
function decodedProtocol(protocol, kinds) {
  const engine = analysisEngine(), cached = adapterCache.get(protocol), key = engine.revision + ":" + state.sampleOrigin;
  if (cached?.engine === engine && cached.key === key) return cached.result;
  const result = records().filter(r => r.protocol === protocol && kinds.includes(r.kind) && !r.transactionRef?.error).map(localRecord);
  const p = protocol.toLowerCase();
  result.configError = !!engine.validation.errors[p];
  result.warnings = [...(engine.validation.errors[p] ? [engine.validation.errors[p]] : []),
    ...(engine.validation.warnings[p] ? [engine.validation.warnings[p]] : []), ...engine.hints[p]];
  for (const r of records().filter(r => r.protocol === protocol && ["INCOMPLETE","ERROR"].includes(r.kind)))
    if (r.reason && !result.warnings.includes(r.reason)) result.warnings.push(r.reason);
  if (protocol === "UART" && result.some(r=>r.unsynchronized)) result.warnings.push("UNSYNC: capture bắt đầu giữa luồng; chờ idle đủ dài để xác nhận biên frame.");
  if (protocol === "SPI" && !result.length && !engine.records.some(r=>r.protocol==="SPI"&&r.kind==="TRANSACTION")) result.warnings.push("Chưa thấy CS active hoàn chỉnh; chờ biên CS thực.");
  adapterCache.set(protocol, {engine, key, result}); return result;
}
function decodeUart() { return decodedProtocol("UART", ["FRAME"]); }
function decodeSpi() { return decodedProtocol("SPI", ["WORD"]); }
function decodeI2c() { return decodedProtocol("I2C", ["START","RESTART","STOP","ADDRESS","DATA"]); }
function uartFrameInfo(r) {
  return (r.unsynchronized ? "UNSYNC · " : "") + (r.framingError ? "FRAME ERROR" : "STOP BIT OK") + (r.parityError ? " · PARITY ERROR" : "");
}
function updateDecoderFeedback() {
  for (const [name, decode] of [["uart",decodeUart],["spi",decodeSpi],["i2c",decodeI2c]]) {
    const result = $(name + "Enabled").checked ? decode() : null;
    text(name + "DecodeStatus", result ? result.warnings.join(" ") : "");
    $(name + "DecodeStatus").classList.toggle("error", !!result?.configError);
    const diagnostic=result?result.warnings.join(" "):"";
    state.decoderDiagnostics=state.decoderDiagnostics||{};
    if(state.samples.length&&diagnostic&&state.decoderDiagnostics[name]!==diagnostic)logEvent(name.toUpperCase()+": "+diagnostic,result.configError?"error":"warning","decoder");
    state.decoderDiagnostics[name]=diagnostic;
  }
  const m = Number($("spiMode").value);
  text("spiModeHint", "SCK nghỉ " + (m < 2 ? "LOW" : "HIGH") + " · đọc cạnh " + ([0,3].includes(m) ? "lên ↑" : "xuống ↓"));
}
function fillChannelSelect(select, selected = 0, optional = false) {
  select.innerHTML = (optional ? '<option value="-1">Không dùng</option>' : "") + state.order.map(i =>
    '<option value="' + i + '">' + escapeHtml(channelName(i)) + ' · D' + i + '</option>').join("");
  select.value = String(selected);
}
function buildChannelControls() {
  $("channelList").innerHTML = state.order.map(i => '<div class="channel-row" draggable="true" data-channel="'+i+'">' +
    '<input class="channel-visible" data-channel="'+i+'" type="checkbox" '+(state.visible[i]?"checked":"")+' aria-label="Hiện D'+i+'">' +
    '<span class="color-dot" style="background:'+state.channels[i].color+'"></span><button class="edit-channel" data-channel="'+i+'" title="Đổi tên, màu, chiều cao, nhóm">'+escapeHtml(channelName(i))+'<small>PA'+i+'</small></button>' +
    '<i id="logicA'+i+'" class="logic-state">—</i><i id="logicB'+i+'" class="logic-state">—</i></div>').join("");
  document.querySelectorAll(".channel-visible").forEach(box => box.onchange = () => { state.visible[Number(box.dataset.channel)] = box.checked; refreshAnalysis(); savePreferences(); });
  document.querySelectorAll(".edit-channel").forEach(btn => btn.onclick = () => editChannel(Number(btn.dataset.channel)));
  document.querySelectorAll(".channel-row").forEach(row => {
    row.ondragstart = e => e.dataTransfer.setData("text/plain", row.dataset.channel);
    row.ondragover = e => e.preventDefault(); row.ondrop = e => {
      e.preventDefault(); const from = Number(e.dataTransfer.getData("text/plain")), to = Number(row.dataset.channel);
      if (!state.order.includes(from) || from === to) return;
      state.order.splice(state.order.indexOf(from), 1); state.order.splice(state.order.indexOf(to), 0, from); rebuildChannels();
    };
  });
}
function rebuildChannels() {
  buildChannelControls();
  ["triggerChannel","uartChannel","uartTxChannel","spiCs","spiClk","spiMosi","spiMiso","i2cScl","i2cSda","selectedChannel"].forEach(id => fillChannelSelect($(id), Number($(id).value), id === "uartTxChannel"));
  const filter=$("decodeChannelFilter").value;fillChannelSelect($("decodeChannelFilter"));$("decodeChannelFilter").innerHTML='<option value="ALL">All channels</option>'+$("decodeChannelFilter").innerHTML;$("decodeChannelFilter").value=filter;
  refreshAnalysis(); savePreferences();
}
function editChannel(i) {
  const c = state.channels[i]; state.editingChannel = i;
  $("channelNameInput").value = c.name; $("channelColorInput").value = c.color;
  $("channelHeightInput").value = c.height; $("channelGroupInput").value = c.group;
  text("channelDialogTitle", "D"+i+" · PA"+i+" (bit vật lý cố định)"); $("channelDialog").showModal();
}
function clearSamples() {
  if (state.streamTimer !== null) clearTimeout(state.streamTimer);
  state.streamTimer = null; state.streamWrite = state.streamCount = 0; state.streamDirty = false;
  state.samples = []; state.sampleOrigin = state.streamTotal || 0; state.triggerIndex = null;
  state.cursorA = state.cursorB = 0; state.viewStart = 0; state.viewEnd = 1;
  state.captureDownload = null; state.frozenRecords = null; state.selection = null; state.selectedEvent = null;
  // Clear display does not reset wire sequence or decoder state of an active stream.
}
function setMode(mode) {
  state.mode = mode; $("modeSelect").value = mode;
  fillRateSelect($("rateSelect"), mode, Number($("rateSelect").value) || state.sampleRate);
  updateFooterStatus();
}
function syncRate(value) { $("rateSelect").value = String(value); }
function receiveCapture(info, payload) {
  state.samples = Uint8Array.from(payload); state.sampleOrigin = 0; state.dataMode = "CAPTURE";
  state.sampleRate = info.rate; state.captureId = info.id; state.flags = info.flags;
  state.dataRequestedRate = state.dataRequestedRate || info.rate; state.dataDepth = payload.length;
  state.triggerIndex = state.captureConfig?.triggerType !== "2" && Number.isInteger(info.trigger) && info.trigger >= 0 && info.trigger < payload.length ? info.trigger : null;
  state.deviceState = info.flags ? "ERROR" : "COMPLETE";
  state.actualDeviceState = state.deviceState; state.frozenRecords = null;
  state.viewStart = 0; state.viewEnd = Math.max(1,payload.length-1);
  state.cursorA = Math.round(payload.length*.35); state.cursorB = Math.round(payload.length*.70);
  state.metrics.samples += payload.length;
  logEvent("Capture #"+info.id+": "+payload.length.toLocaleString()+" mẫu @ "+formatRate(info.rate), info.flags?"error":"ok");
  refreshAnalysis();
  if (!state.selfTestRepeat && (state.selfTestRunning || state.selfTestPending || state.selfTestRunRequested)) stopSelfTest(false);
}
function receiveStream(info, payload) {
  state.dataMode = "STREAM"; state.sampleRate = info.rate; state.triggerIndex = null;
  const cfg = decoderConfig(), key = JSON.stringify(cfg);
  if (!state.decoder || state.decoderKey !== key || state.decoder.rate !== info.rate) {
    state.decoder = new LA.Decoder(info.rate, cfg, "stream"+info.id+":"+state.streamTotal); state.decoderKey = key;
    // Config changes replay only retained contiguous raw, never pretend the missing history exists.
    if (state.streamCount) {
      const snap = streamSnapshot(); state.decoder.feed(snap.samples, snap.first);
    }
  }
  state.decoder.feed(payload, state.streamTotal);
  const cap = state.streamRing.length, first = Math.min(payload.length,cap-state.streamWrite);
  state.streamRing.set(payload.subarray(0,first),state.streamWrite); state.streamRing.set(payload.subarray(first),0);
  state.streamWrite = (state.streamWrite+payload.length)%cap;
  state.metrics.evicted += Math.max(0,state.streamCount+payload.length-cap);
  state.streamCount = Math.min(cap,state.streamCount+payload.length);
  state.streamTotal += payload.length; state.metrics.samples += payload.length; state.metrics.packets++;
  state.decoder.prune(state.streamTotal-cap); state.streamDirty = true;
  // Large PC history needs fewer UI snapshots; every block is still decoded.
  if (state.streamTimer === null) state.streamTimer = setTimeout(flushStreamView,Math.max(STREAM_UI_PERIOD_MS,Math.ceil(state.streamCount/65536)*STREAM_UI_PERIOD_MS));
}
function streamSnapshot() {
  const cap = state.streamRing.length, samples = new Uint8Array(state.streamCount);
  const start = (state.streamWrite-state.streamCount+cap)%cap, first = Math.min(state.streamCount,cap-start);
  samples.set(state.streamRing.subarray(start,start+first)); samples.set(state.streamRing.subarray(0,state.streamCount-first),first);
  return {samples,first:state.streamTotal-state.streamCount};
}
function flushStreamView(force = false) {
  if (state.streamTimer !== null) clearTimeout(state.streamTimer); state.streamTimer = null;
  if (!state.streamDirty && !force) return; state.streamDirty = false;
  if (!state.followLive && !force) { updateFooterStatus(); return; }
  const snap = streamSnapshot(), shift = snap.first-state.sampleOrigin, had = state.samples.length;
  const span = had ? state.viewEnd-state.viewStart : snap.samples.length-1;
  state.samples = snap.samples; state.sampleOrigin = snap.first; state.triggerIndex = null; state.frozenRecords = null;
  state.hoverPulse = null;
  state.cursorA -= shift; state.cursorB -= shift;
  state.viewEnd = Math.max(1,snap.samples.length-1); state.viewStart = Math.max(0,state.viewEnd-Math.max(1,span));
  refreshAnalysis(false);
}
function setFollow(live) {
  if (!live && state.followLive) state.frozenRecords = structuredClone(records());
  state.followLive = live; $("followBtn").classList.toggle("active",live); text("followBtn",live?"● Follow Live":"Ⅱ Paused view");
  if(live)state.selection=null;
  if (live && state.dataMode === "STREAM") flushStreamView(true);
}
function displayBins(channel,from,to,columns) {
  if(state.binSamples!==state.samples){state.binCache=new Map();state.binSamples=state.samples;}
  const key=[channel,from,to,columns].join(":");
  if(!state.binCache.has(key)){if(state.binCache.size>25)state.binCache.clear();state.binCache.set(key,LA.bins(state.samples,channel,from,to,columns));}
  return state.binCache.get(key);
}
function measurementRange() {
  const choice = $("measureRange")?.value;
  if (choice === "visible") return [state.viewStart, state.viewEnd+1];
  if (choice === "cursors") return validCursor(state.cursorA)&&validCursor(state.cursorB)?[Math.min(state.cursorA,state.cursorB),Math.max(state.cursorA,state.cursorB)+1]:[0,0];
  return [0,state.samples.length];
}
function measureChannel(channel) {
  const range = measurementRange(), key = channel+":"+range.join(":")+":"+state.sampleRate;
  if(state.dataMode==="STREAM"&&state.streamAccept&&state.measurementWorker) {
    requestMeasurements();
    return state.asyncMeasurements?.samples===state.samples&&state.asyncMeasurements.range===range.join(":")?state.asyncMeasurements.values[channel]:LA.measure([],state.sampleRate,channel);
  }
  if (state.measurementSamples !== state.samples) {state.measurementCache.clear(); state.measurementSamples = state.samples;}
  if (!state.measurementCache.has(key)) {
    if (state.measurementCache.size>40) state.measurementCache.clear();
    state.measurementCache.set(key,LA.measure(state.samples,state.sampleRate,channel,...range));
  }
  return state.measurementCache.get(key);
}
function requestMeasurements() {
  if(!state.measurementWorker||state.measureJob)return;
  const range=measurementRange(),key=range.join(":");
  if(state.asyncMeasurements?.samples===state.samples&&state.asyncMeasurements.range===key)return;
  const samples=state.samples.slice(),id=(state.measureJobId||0)+1;state.measureJobId=id;
  state.measureJob={id,samples:state.samples,range:key,rate:state.sampleRate};
  state.measurementWorker.postMessage({id,samples,rate:state.sampleRate,from:range[0],to:range[1]},[samples.buffer]);
}
function setupMeasurementWorker() {
  if(typeof Worker==="undefined")return;
  try{
    const worker=new Worker("analysis_worker.js?v=2.0-workbench");state.measurementWorker=worker;
    worker.onmessage=({data})=>{
      if(data.id==="export"&&state.measureExport){const pending=state.measureExport;state.measureExport=null;clearTimeout(pending.timer);data.error?pending.reject(Error(data.error)):pending.resolve(data.measurements);return;}
      const job=state.measureJob;if(!job||job.id!==data.id)return;state.measureJob=null;
      if(data.error){worker.terminate();state.measurementWorker=null;logEvent("Measurement worker: "+data.error,"error");return;}
      if(job.samples===state.samples&&job.range===measurementRange().join(":")&&job.rate===state.sampleRate) {
        state.asyncMeasurements={samples:job.samples,range:job.range,values:data.measurements};renderMeasurements();updateSelectedChannel();
      }else if(state.streamAccept)requestMeasurements();
    };
    worker.onerror=()=>{worker.terminate();state.measurementWorker=null;state.measureJob=null;if(state.measureExport){clearTimeout(state.measureExport.timer);state.measureExport.reject(Error("Measurement worker failed"));state.measureExport=null;}logEvent("Worker không khả dụng; phép đo dùng main thread. Chọn PC history nhỏ nếu stream chậm.","error");};
  }catch(error){logEvent("Không tạo được measurement worker: "+error.message,"error");}
}
function renderMeasurements() {
  $("measurementsBody").innerHTML = state.order.map(ch => {
    const m = measureChannel(ch), time = value => value === null ? "—" : formatTime(value);
    return '<tr><td>'+escapeHtml(channelName(ch))+'</td><td>'+formatFrequency(m.frequency)+'</td><td>'+time(m.period)+'</td><td>'+(m.duty===null?"—":m.duty.toFixed(2)+"%")+'</td><td>'+time(m.high)+'</td><td>'+time(m.low)+'</td><td>'+m.rising+" / "+m.falling+'</td><td>'+time(m.jitter)+'</td></tr>';
  }).join("");
  const pending=state.measurementWorker&&state.dataMode==="STREAM"&&state.streamAccept&&state.asyncMeasurements?.samples!==state.samples;
  text("measureResolution",(pending?"Đang tính snapshot hiện tại · ":"")+"Ts = "+formatTime(1/state.sampleRate)+" · Chỉ tính pulse/period đủ cạnh; σ(period) gồm lượng tử hóa.");
}
function eventData(r) {
  const value=(n,width=8)=>{
    const mode=$("decodeFormat")?.value;
    if(mode==="decimal")return String(n);
    if(mode==="binary")return "0b"+n.toString(2).padStart(width,"0");
    if(mode==="ascii")return n>=32&&n<=126?"'"+String.fromCharCode(n)+"'":"· ("+hexByte(n)+")";
    return hexByte(n);
  };
  if (r.kind === "WORD") return "MOSI "+value(r.mosi,r.width)+" / MISO "+value(r.miso,r.width);
  if (r.kind === "FRAME") return value(r.value,r.width)+(r.value>=32&&r.value<=126&&$("decodeFormat")?.value!=="ascii"?" · '"+String.fromCharCode(r.value)+"'":"");
  return r.value === null || r.value === undefined ? r.kind : value(r.value);
}
function eventInfo(r) {
  if (r.transactionRef?.error) return "ERROR · "+r.transactionRef.error;
  if (r.reason) return r.reason;
  if (r.kind === "TRANSACTION") return r.status+" · #"+r.transaction+" · "+r.count+" words/bytes"+(r.address==null?"":" · address "+hexByte(r.address)+" "+(r.read?"Read":"Write"));
  if (r.protocol === "UART") return uartFrameInfo(r);
  if (r.protocol === "I2C" && ["ADDRESS","DATA"].includes(r.kind)) return i2cEventInfo(r);
  return r.status+(r.mode===undefined?"":" · Mode "+r.mode)+(r.transaction?" · CS/Tx #"+r.transaction:"")+(r.transactionRef?.boundary?" · CAPTURE END":"");
}
function filteredRecords() {
  const protocol = $("decodeFilter")?.value || "ALL", view = $("decodeView")?.value || "data", query = ($("decodeSearch")?.value||"").toLowerCase();
  const channel=$("decodeChannelFilter")?.value||"ALL", status=$("decodeStatusFilter")?.value||"ALL";
  const rows = records().filter(r => (protocol === "ALL" || r.protocol === protocol) &&
    (channel==="ALL"||String(r.channel)===channel) && (status==="ALL"||(r.transactionRef?.error?"ERROR":r.status)===status) &&
    (view === "transactions" ? r.kind === "TRANSACTION" : view === "frames" ? ["FRAME","WORD","ADDRESS","DATA","ERROR","INCOMPLETE","GAP"].includes(r.kind) : r.kind !== "TRANSACTION") &&
    (!query || [r.protocol,r.kind,eventData(r),eventInfo(r),channelName(r.channel)].join(" ").toLowerCase().includes(query)));
  rows.sort((a,b) => ($("decodeSort")?.value === "descending" ? -1 : 1)*(a.index-b.index)); return rows;
}
function renderDecodedData() {
  state.tableRows = filteredRecords();
  text("decodedCount",state.tableRows.length+" events · max "+(state.decoder?.maxRecords||12000).toLocaleString()+" retained records");
  renderDecodedRows();
}
function renderDecodedRows() {
  const host = $("decodedScroll"), rows = state.tableRows, rowHeight = 32;
  if ($("decodeFollow")?.checked && state.followLive && state.dataMode === "STREAM") host.scrollTop = Math.max(0,rows.length*rowHeight-host.clientHeight);
  const from = Math.max(0,Math.floor((host?.scrollTop||0)/rowHeight)-5), to = Math.min(rows.length,from+Math.max(30,Math.ceil((host?.clientHeight||300)/rowHeight)+12));
  const spacer = n => n ? '<tr class="spacer"><td colspan="8" style="height:'+n*rowHeight+'px"></td></tr>' : "";
  $("decodedTableBody").innerHTML = spacer(from)+rows.slice(from,to).map(r => {
    const start = r.startIndex-state.sampleOrigin, end = r.endIndex-state.sampleOrigin;
    return '<tr data-event="'+escapeHtml(r.id)+'" data-sample="'+start+'" class="'+(state.selectedEvent===r.id?"selected ":"")+(r.status === "ERROR" || r.unsynchronized ? "decode-uncertain":"")+'"><td>'+formatTime(sampleTime(start))+'</td><td>'+formatTime(sampleTime(end))+'</td><td>'+formatTime((end-start)/state.sampleRate)+'</td><td>'+escapeHtml(r.protocol)+'</td><td>'+escapeHtml(channelName(r.channel))+'</td><td>'+escapeHtml(r.kind)+'</td><td>'+escapeHtml(eventData(r))+'</td><td>'+escapeHtml(eventInfo(r))+'</td></tr>';
  }).join("")+spacer(rows.length-to);
}
function selectEvent(id, revealTable = false) {
  const r = records().find(r => r.id === id); if (!r) return;
  state.selectedEvent = id; setFollow(false); centerViewOn((r.startIndex+r.endIndex)/2-state.sampleOrigin);
  state.cursorA = Math.max(0,r.startIndex-state.sampleOrigin);
  text("eventDetails",r.protocol+" · "+r.kind+" · "+eventData(r)+" · "+eventInfo(r)+" · absolute samples "+r.startIndex+"…"+r.endIndex);
  if (revealTable) {
    if(!state.tableRows.some(item=>item.id===id)) {$("decodeFilter").value="ALL";$("decodeChannelFilter").value="ALL";$("decodeStatusFilter").value="ALL";$("decodeSearch").value="";$("decodeView").value=r.kind==="TRANSACTION"?"transactions":"data";renderDecodedData();}
    const n = state.tableRows.findIndex(item=>item.id===id); if(n>=0) $("decodedScroll").scrollTop=n*32;
  }
  renderDecodedRows(); updateCursorInfo(); drawWaveform();
}
function updateStats() {
  const count=state.samples.length, valid=state.triggerIndex!==null&&count;
  text("captureLength",formatTime(count/state.sampleRate)); text("totalSamples",count.toLocaleString()); text("statSampleRate",formatRate(state.sampleRate));
  text("activeChannels",state.visible.filter(Boolean).length+" / 8"); text("dataSize",(count/1024).toFixed(1)+" KiB");
  text("captureSummary",count?(state.dataMode==="STREAM"?"Stream":"Capture #"+state.captureId)+" · "+formatTime(count/state.sampleRate)+" · "+count.toLocaleString()+" samples · "+formatRate(state.sampleRate):"Chưa có dữ liệu — kết nối và nhấn Start");
  text("triggerMode",valid?(state.captureConfig?(state.captureConfig.triggerType==="1"?"Falling":"Rising"):"Legacy index · type unknown"):"Không có trigger");
  text("triggerSource",valid&&state.captureConfig?channelName(Number(state.captureConfig.channel)):"—");
  text("triggerPosition",valid?((state.triggerIndex/count)*100).toFixed(1)+"%":"—");
  text("triggerTime",valid?formatTime(state.triggerIndex/state.sampleRate):"—");
  text("prePost",valid?state.triggerIndex+" / "+(count-state.triggerIndex)+" samples":"—");
  $("gotoTrigger").disabled=!valid; text("triggerTimeText",valid?"T = 0":"No trigger");
  const frozen = state.dataMode === "STREAM" && !state.followLive;
  text("viewState", frozen?(state.streamAccept?"View paused · receiver continues":"Retained stream snapshot"):state.dataMode === "STREAM"?"Following latest samples":"Snapshot");
  text("visibleRange",formatTime(Math.max(0,state.viewEnd-state.viewStart)/state.sampleRate));
}
function validCursor(n) { return Number.isInteger(n)&&n>=0&&n<state.samples.length; }
function updateSelectedChannel() {
  const ch = Number($("selectedChannel").value)||0; state.selectedChannel=ch; const m=measureChannel(ch);
  text("stateAtA",validCursor(state.cursorA)?String((state.samples[state.cursorA]>>ch)&1):"—");
  text("stateAtB",validCursor(state.cursorB)?String((state.samples[state.cursorB]>>ch)&1):"—");
  text("selectedFrequency",formatFrequency(m.frequency)); text("selectedPeriod",m.period===null?"—":formatTime(m.period));
  text("selectedDuty",m.duty===null?"—":m.duty.toFixed(2)+"%"); text("selectedPulse",m.high===null||m.low===null?"—":formatTime(m.high)+" / "+formatTime(m.low));
  text("pulseStats",["highStats","lowStats","periodStats"].map(k=>k.replace("Stats","")+" min/mean/max: "+[m[k].min,m[k].mean,m[k].max].map(v=>v===null?"—":formatTime(v)).join(" / ")).join("\n"));
  text("pulseStats",$("pulseStats").textContent+"\nDuty min/mean/max: "+[m.dutyStats.min,m.dutyStats.mean,m.dutyStats.max].map(v=>v===null?"—":v.toFixed(2)+"%").join(" / ")+"\nEdges ↑ / ↓: "+m.rising+" / "+m.falling);
}
function updateCursorInfo() {
  const a=validCursor(state.cursorA), b=validCursor(state.cursorB), delta=(state.cursorB-state.cursorA)/state.sampleRate;
  text("cursorAText",a?formatTime(sampleTime(state.cursorA)):"A expired / —"); text("cursorBText",b?formatTime(sampleTime(state.cursorB)):"B expired / —");
  text("rightCursorA",a?formatTime(sampleTime(state.cursorA)):"—"); text("rightCursorB",b?formatTime(sampleTime(state.cursorB)):"—");
  text("deltaText","Δt (B−A) = "+(a&&b?formatTime(delta):"—")); text("frequencyText","1/|Δt| = "+(a&&b&&delta?formatFrequency(1/Math.abs(delta)):"—"));
  text("rightDelta",a&&b?formatTime(delta):"—"); text("rightDeltaFrequency",a&&b&&delta?formatFrequency(1/Math.abs(delta)):"—");
  for(let ch=0;ch<8;ch++) for(const cursor of ["A","B"]) { const n=state["cursor"+cursor]; text("logic"+cursor+ch,validCursor(n)?String((state.samples[n]>>ch)&1):"—"); }
  updateSelectedChannel(); if($("measureRange")?.value==="cursors") renderMeasurements();
}
function updateFooterStatus() {
  const busy=acquiring();
  for(const id of ["modeSelect","rateSelect","depthSelect","pcBufferSelect","triggerEdge","triggerChannel","pretriggerSelect","timeoutSelect"])
    if($(id)) $(id).disabled=busy || (["triggerEdge","triggerChannel","pretriggerSelect","timeoutSelect","depthSelect"].includes(id)&&state.mode==="STREAM");
  if($("loadBtn")) $("loadBtn").disabled=busy;
  if($("startBtn")) $("startBtn").disabled=!state.connected||!state.configSeen||busy;
  if($("stopBtn")) $("stopBtn").disabled=!state.connected||!(busy||state.selfTestRunning);
  text("footerStatus",(state.connected?state.deviceState+" · MCU "+(state.deviceRate?formatRate(state.deviceRate):"unknown"):"Offline")+" · "+state.mode+" · Data Fs "+(state.samples.length?formatRate(state.sampleRate):"—"));
  text("plannedDuration",formatTime((state.mode==="CAPTURE"?state.depth:Number($("pcBufferSelect")?.value)||8192)/(Number($("rateSelect")?.value)||state.requestedRate)));
  const m=state.metrics, seconds=Math.max(.001,(performance.now()-m.since)/1000);
  text("transportSummary",(m.bytes/1024).toFixed(1)+" KiB RX · "+(m.bytes/seconds/1024).toFixed(1)+" KiB/s avg · "+m.samples.toLocaleString()+" samples");
  text("transportDetails","Raw bytes RX: "+m.bytes+"\nValid stream blocks: "+m.packets+"\nPacket CRC/header errors: "+(m.packetErrors||0)+"\nSession integrity faults: "+m.errors+"\nSequence mismatches: "+(m.sequenceGaps||0)+"\nGap events: "+m.gaps+"\nMissing samples: "+(state.gaps.length?"unknown (no silent zero-fill)":"none detected")+"\nMCU dropped blocks (last status): "+(state.deviceDroppedBlocks??"unknown")+"\nPC history: "+state.streamCount+" / "+state.streamRing.length+" samples\nPC history evicted: "+m.evicted+" (retention, not transport loss)\nStream decoder errors (session): "+(state.decoder?.errorCount||0)+"\nRequested: "+formatRate(state.requestedRate)+" · Data Fs: "+formatRate(state.sampleRate)+"\nMCU DMA/queue sizes: not reported by protocol");
}
function logEvent(message,type="info",categoryOverride=null) {
  const category=categoryOverride||(/^(TX|ACK|NACK|RX)/.test(message)?"protocol":/STREAM|STATUS|Capture/.test(message)?"acquisition":"system");
  const last=state.logs[state.logs.length-1];
  if(last&&last.message===message&&last.type===type) last.count=(last.count||1)+1;
  else state.logs.push({time:new Date().toISOString(),message,type,category,count:1});
  if(state.logs.length>300) state.logs.shift(); renderLogs();
}
function renderLogs() {
  const severity=$("logSeverity")?.value||"all", category=$("logCategory")?.value||"all", query=($("logSearch")?.value||"").toLowerCase();
  $("eventLog").innerHTML=state.logs.filter(r=>(severity==="all"||r.type===severity)&&(category==="all"||r.category===category)&&r.message.toLowerCase().includes(query)).map(r=>'<div class="event-row '+r.type+'">['+r.time.slice(11,23)+'] '+escapeHtml(r.message)+(r.count>1?" ×"+r.count:"")+"</div>").join("");
  if($("autoScroll").checked) $("eventLog").scrollTop=$("eventLog").scrollHeight;
}

function setInteractionMode(mode) {
  state.interactionMode=mode; for(const [id,m] of [["cursorBtn","CURSOR"],["panBtn","PAN"],["selectBtn","SELECT"]]) $(id).classList.toggle("active",m===mode);
}
function waveRows() {
  const rows=[], groups=new Set(); let top=28;
  for(const ch of state.order) {
    if(!state.visible[ch]) continue; const c=state.channels[ch];
    if(c.group&&!groups.has(c.group)) { rows.push({kind:"group",name:c.group,top,height:24}); top+=24; groups.add(c.group); }
    if(c.group&&state.collapsedGroups.has(c.group)) continue;
    rows.push({kind:"digital",channel:ch,top,height:c.height}); top+=c.height;
  }
  for(const p of ["UART","I2C","SPI"]) if(decoderConfig()[p.toLowerCase()+"Enabled"]) {
    const expanded=state.laneExpanded.has(p), height=expanded?120:36;
    for(const role of p==="UART"&&decoderConfig().uartTxChannel>=0?["RX","TX"]:[null]) {
      rows.push({kind:"decoder",protocol:p,role,top,height,expanded}); top+=height;
    }
  }
  return {rows,height:Math.max(150,top+18)};
}
function drawWaveform() {
  const canvas=$("waveCanvas"), wrap=canvas.parentElement, width=Math.max(200,wrap.clientWidth||800), layout=waveRows();
  const dpr=window.devicePixelRatio||1, height=layout.height;
  canvas.width=Math.round(width*dpr); canvas.height=Math.round(height*dpr); canvas.style.height=height+"px";
  const ctx=canvas.getContext("2d"); ctx.scale(dpr,dpr); ctx.fillStyle="#10151d"; ctx.fillRect(0,0,width,height);
  const left=104,pw=Math.max(20,width-left-16),x=i=>sampleToX(i,left,pw), origin=state.sampleOrigin;
  state.geometry={left,width:pw,rows:layout.rows,height,hits:[]};
  ctx.font="12px Segoe UI";
  const ticks=Math.max(2,Math.floor(pw/100));
  for(let tick=0;tick<=ticks*4;tick++) {
    const sample=state.viewStart+tick*(state.viewEnd-state.viewStart)/(ticks*4),xx=x(sample);
    ctx.strokeStyle=tick%4?"#1b242f":"#344050";ctx.beginPath();ctx.moveTo(xx,24);ctx.lineTo(xx,height);ctx.stroke();
  }
  for(const row of layout.rows) {
    const t=row.top,h=row.height;
    ctx.strokeStyle="#29333f";ctx.beginPath();ctx.moveTo(0,t+h);ctx.lineTo(width,t+h);ctx.stroke();
    ctx.textAlign="left";ctx.fillStyle="#c5cfde";
    if(row.kind==="group") {ctx.fillText((state.collapsedGroups.has(row.name)?"▸ ":"▾ ")+row.name,8,t+17);continue;}
    if(row.kind==="digital") {
      const ch=row.channel,c=state.channels[ch],high=t+10,low=t+h-9,y=level=>level?high:low;
      ctx.fillStyle=c.color;ctx.fillText(c.name.slice(0,13),8,t+h/2+4);ctx.strokeStyle=c.color;ctx.lineWidth=1.35;
      ctx.save();ctx.beginPath();ctx.rect(left,t,pw,h);ctx.clip();
      if(state.samples.length) {
        if((state.viewEnd-state.viewStart)>pw*2) {
          const bins=displayBins(ch,state.viewStart,state.viewEnd,Math.floor(pw));ctx.beginPath();
          bins.forEach((b,i)=>{const xx=left+i;ctx.moveTo(xx,y(b.lo));ctx.lineTo(xx,y(b.hi));if(i) {ctx.moveTo(xx-1,y(bins[i-1].last));ctx.lineTo(xx,y(bins[i-1].last));ctx.lineTo(xx,y(b.first));}});ctx.stroke();
        } else {
          const first=Math.max(0,Math.floor(state.viewStart)),end=Math.min(state.samples.length-1,Math.ceil(state.viewEnd));ctx.beginPath();
          ctx.moveTo(x(first),y((state.samples[first]>>ch)&1));
          for(let i=first+1;i<=end;i++){ctx.lineTo(x(i),y((state.samples[i-1]>>ch)&1));ctx.lineTo(x(i),y((state.samples[i]>>ch)&1));}ctx.stroke();
          if(pw/(state.viewEnd-state.viewStart)>7) for(let i=first;i<=end;i++){ctx.beginPath();ctx.arc(x(i),y((state.samples[i]>>ch)&1),2,0,Math.PI*2);ctx.fill();}
        }
      }
      if(state.hoverPulse?.channel===ch) {const p=state.hoverPulse;ctx.fillStyle="#ffffff22";ctx.fillRect(x(p.start),t,x(p.end+1)-x(p.start),h);ctx.strokeStyle="#dce7f8";ctx.setLineDash([3,3]);for(const edge of[!p.clippedStart?p.start:null,!p.clippedEnd?p.end+1:null])if(edge!==null){ctx.beginPath();ctx.moveTo(x(edge),t);ctx.lineTo(x(edge),t+h);ctx.stroke();}ctx.setLineDash([]);}
      ctx.restore();continue;
    }
    const p=row.protocol,expanded=row.expanded,color=p==="UART"?"#aa62ea":p==="SPI"?"#e58c30":"#42b6af";
    ctx.fillStyle=color;ctx.fillText((expanded?"▾ ":"▸ ")+p+(row.role?" "+row.role:""),8,t+22);
    const list=records().filter(r=>r.protocol===p&&(!row.role||r.role===row.role)&&r.endIndex>=origin+state.viewStart&&r.startIndex<=origin+state.viewEnd);
    ctx.save();ctx.beginPath();ctx.rect(left,t,pw,h);ctx.clip();
    for(const r of list) {
      if(!expanded&&r.kind==="TRANSACTION") continue;
      const a=x(r.startIndex-origin),b=x(r.endIndex-origin),lane=r.kind==="TRANSACTION"?2:["ERROR","INCOMPLETE"].includes(r.kind)?3:0;
      const yy=t+5+(expanded?lane*27:0),ww=Math.max(4,b-a);
      ctx.fillStyle=r.status==="ERROR"||r.transactionRef?.error?"#c33d51":state.selectedEvent===r.id?"#e0bb27":color+"88";ctx.fillRect(a,yy,ww,23);
      ctx.save();ctx.beginPath();ctx.rect(a,yy,ww,23);ctx.clip();ctx.fillStyle="#fff";ctx.fillText(eventData(r),a+4,yy+16);ctx.restore();
      state.geometry.hits.push({id:r.id,left:a,right:a+ww,top:yy,bottom:yy+23});
      if(expanded&&r.bits) {
        ctx.fillStyle="#d8e0ed"; for(let k=0;k<r.bits.length;k++) {const bit=r.bits[k],at=typeof bit==="number"?bit:bit.index;
          const position=r.bitOrder==="lsb"?k:r.width-1-k;
          const value=typeof bit==="number"?String(Math.floor(r.mosi/2**position)%2)+"/"+String(Math.floor(r.miso/2**position)%2):String(bit.value);
          const bx=x(at-origin);ctx.fillText(String(value),bx,t+48);}
        if(r.protocol==="UART") {ctx.fillText("S",a,t+48);if(r.parityIndex!==null)ctx.fillText("P",x(r.parityIndex-origin),t+48);for(const at of r.stopIndices||[])ctx.fillText("STOP",x(at-origin),t+48);}
        if(r.protocol==="I2C"&&r.bits.length===9)ctx.fillText(r.ack?"ACK":"NACK",x(r.bits[8].index-origin),t+48);
      }
    }
    ctx.restore();
  }
  if(state.selection) {ctx.fillStyle="#4b90ff30";ctx.fillRect(x(Math.min(...state.selection)),24,Math.abs(x(state.selection[1])-x(state.selection[0])),height-24);}
  if(validCursor(state.cursorA)&&validCursor(state.cursorB)){ctx.fillStyle="#4b90ff0c";ctx.fillRect(x(Math.min(state.cursorA,state.cursorB)),24,Math.abs(x(state.cursorB)-x(state.cursorA)),height-24);}
  const selected=records().find(r=>r.id===state.selectedEvent);
  if(selected){const a=Math.max(left,x(selected.startIndex-origin)),b=Math.min(left+pw,x(selected.endIndex-origin));if(b>=a){ctx.fillStyle="#ffc93d20";ctx.fillRect(a,24,Math.max(2,b-a),height-24);}}
  if(state.samples.length) {
    if(state.triggerIndex!==null) drawMarker(ctx,state.triggerIndex,"T","#37b967",left,pw,24,height);
    if(validCursor(state.cursorA))drawMarker(ctx,state.cursorA,"A","#448be8",left,pw,24,height);
    if(validCursor(state.cursorB))drawMarker(ctx,state.cursorB,"B","#e5c524",left,pw,24,height,"#171b23");
    if(state.gaps.length){ctx.fillStyle="#ff8e9c";ctx.textAlign="right";ctx.fillText("GAP / ERROR · missing samples unknown",width-12,18);}
  } else {ctx.fillStyle="#8c99aa";ctx.textAlign="center";ctx.fillText("Chưa có dữ liệu thật",left+pw/2,height/2);}
  drawTimeRuler(width,dpr,left,pw); drawOverview(width,dpr); updateStats();
}
function drawTimeRuler(width,dpr,left,pw) {
  const canvas=$("timeCanvas");canvas.width=width*dpr;canvas.height=28*dpr; const ctx=canvas.getContext("2d");ctx.scale(dpr,dpr);ctx.fillStyle="#10151d";ctx.fillRect(0,0,width,28);ctx.fillStyle="#b9c6d6";ctx.font="11px Segoe UI";ctx.textAlign="center";
  const ticks=Math.max(2,Math.floor(pw/100));for(let n=0;n<=ticks;n++){const i=state.viewStart+n*(state.viewEnd-state.viewStart)/ticks;ctx.fillText(formatTime(sampleTime(i)),left+n*pw/ticks,19);}
}
function drawOverview(width,dpr) {
  const canvas=$("overviewCanvas");canvas.width=width*dpr;canvas.height=36*dpr;const ctx=canvas.getContext("2d");ctx.scale(dpr,dpr);ctx.fillStyle="#161e29";ctx.fillRect(0,0,width,36);
  const ch=state.selectedChannel,bins=displayBins(ch,0,Math.max(1,state.samples.length-1),Math.floor(width));ctx.strokeStyle=state.channels[ch].color;ctx.beginPath();
  bins.forEach((b,i)=>{ctx.moveTo(i,b.lo?8:28);ctx.lineTo(i,b.hi?8:28);ctx.moveTo(i,b.first?8:28);ctx.lineTo(i+1,b.first?8:28);});ctx.stroke();
  const n=Math.max(1,state.samples.length-1),a=state.viewStart/n*width,b=state.viewEnd/n*width;
  ctx.fillStyle="#6ea5ff22";ctx.fillRect(a,0,b-a,36);ctx.strokeStyle="#7db2ff";ctx.strokeRect(a+.5,.5,Math.max(1,b-a),35);ctx.fillStyle="#8cbbff";ctx.fillRect(a,0,3,36);ctx.fillRect(b-3,0,3,36);
  for(const [index,label,color]of[[state.triggerIndex,"T","#37b967"],[state.cursorA,"A","#448be8"],[state.cursorB,"B","#e5c524"]])if(index!==null&&validCursor(index)){const xx=index/n*width;ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(xx,0);ctx.lineTo(xx,36);ctx.stroke();ctx.fillStyle=color;ctx.fillText(label,Math.min(width-10,xx+3),12);}
}
function zoom(factor,anchor=(state.viewStart+state.viewEnd)/2) {
  if(state.dataMode==="STREAM")setFollow(false);
  const current=state.viewEnd-state.viewStart,max=Math.max(1,state.samples.length-1),span=Math.max(1,Math.min(max,current*factor)),ratio=current?(anchor-state.viewStart)/current:.5;
  state.viewStart=Math.max(0,Math.min(max-span,anchor-span*ratio));state.viewEnd=state.viewStart+span; refreshAnalysis();
}
function fitWaveform() {state.viewStart=0;state.viewEnd=Math.max(1,state.samples.length-1);refreshAnalysis();}
function setupCanvasInteraction() {
  const canvas=$("waveCanvas"),tooltip=$("canvasTooltip"); let drag=null;
  const point=e=>{const b=canvas.getBoundingClientRect(),g=state.geometry;return {x:e.clientX-b.left,y:e.clientY-b.top,g,b};};
  canvas.onpointerdown=e=>{
    const p=point(e),row=p.g.rows.find(r=>p.y>=r.top&&p.y<r.top+r.height);
    if(p.x<p.g.left) {if(row?.kind==="group") {const set=state.collapsedGroups;set.has(row.name)?set.delete(row.name):set.add(row.name);} else if(row?.kind==="decoder") {const set=state.laneExpanded;set.has(row.protocol)?set.delete(row.protocol):set.add(row.protocol);} else if(row?.kind==="digital") {$("selectedChannel").value=String(row.channel);updateSelectedChannel();} drawWaveform();return;}
    const hit=p.g.hits.findLast(h=>p.x>=h.left&&p.x<=h.right&&p.y>=h.top&&p.y<=h.bottom);
    if(hit) {selectEvent(hit.id,true);return;} if(!state.samples.length)return;
    if(state.dataMode==="STREAM")setFollow(false);
    const sample=xToSample(p.x,p.g.left,p.g.width),mode=e.shiftKey||e.button!==0?"PAN":state.interactionMode;
    drag={mode,x:p.x,start:state.viewStart,end:state.viewEnd,sample};
    if(mode==="CURSOR"){setActiveCursor(Math.abs(sample-state.cursorA)<Math.abs(sample-state.cursorB)?"A":"B");setCursorSample(sample);}
    if(mode==="SELECT")state.selection=[sample,sample];canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove=e=>{
    const p=point(e),sample=xToSample(p.x,p.g.left,p.g.width),row=p.g.rows.find(r=>p.y>=r.top&&p.y<r.top+r.height);
    if(drag) {
      if(drag.mode==="PAN"){const span=drag.end-drag.start,max=Math.max(1,state.samples.length-1);state.viewStart=Math.max(0,Math.min(max-span,drag.start-(p.x-drag.x)*span/p.g.width));state.viewEnd=state.viewStart+span;drawWaveform();}
      else if(drag.mode==="SELECT"){state.selection=[drag.sample,sample];drawWaveform();}else setCursorSample(sample);
      return;
    }
    state.hoverPulse=null;
    const hit=p.g.hits.findLast(h=>p.x>=h.left&&p.x<=h.right&&p.y>=h.top&&p.y<=h.bottom);
    if(hit){const r=records().find(r=>r.id===hit.id);tooltip.textContent=r?eventData(r)+" · "+eventInfo(r):"";}
    else if(row?.kind==="digital"&&state.samples.length){
      const pulse=pulseAt(sample,row.channel),auto=$("autoMeasure").checked;
      state.hoverPulse=auto?{...pulse,channel:row.channel}:null;
      let detail="";
      if(auto){detail=" · width "+(pulse.clippedStart||pulse.clippedEnd?"≥ ":"")+formatTime(pulse.duration);
        const opposite=pulse.end+1<state.samples.length?pulseAt(pulse.end+1,row.channel):null;
        if(!pulse.clippedStart&&!pulse.clippedEnd&&opposite&&!opposite.clippedEnd){const period=(opposite.end+1-pulse.start)/state.sampleRate,high=pulse.level?pulse.duration:opposite.duration;detail+=" · T="+formatTime(period)+" · "+formatFrequency(1/period)+" · duty "+(high/period*100).toFixed(1)+"%";}
      }
      tooltip.textContent=channelName(row.channel)+" · "+(pulse.level?"HIGH":"LOW")+detail+" · t="+formatTime(sampleTime(sample));
    }
    else {tooltip.classList.add("hidden");return;}
    tooltip.classList.remove("hidden");tooltip.style.left=Math.max(0,Math.min(p.x+12,p.b.width-260))+"px";tooltip.style.top=Math.max(0,p.y-48)+"px";
    text("footerPointer", "t: "+formatTime(sampleTime(sample))+" · sample "+(state.sampleOrigin+sample));drawWaveform();
  };
  canvas.onpointerup=canvas.onpointercancel=e=>{drag=null;if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);renderMeasurements();};
  canvas.onpointerleave=()=>{if(!drag){tooltip.classList.add("hidden");state.hoverPulse=null;drawWaveform();}};
  canvas.oncontextmenu=e=>e.preventDefault();canvas.addEventListener("wheel",e=>{e.preventDefault();const p=point(e);zoom(e.deltaY>0?1.25:.8,xToSample(p.x,p.g.left,p.g.width));},{passive:false});
  const overview=$("overviewCanvas");let mini=null;
  overview.onpointerdown=e=>{setFollow(false);const b=overview.getBoundingClientRect(),n=Math.max(1,state.samples.length-1),s=(e.clientX-b.left)/b.width*n,tolerance=8/b.width*n;mini={kind:Math.abs(s-state.viewStart)<tolerance?"left":Math.abs(s-state.viewEnd)<tolerance?"right":"move",sample:s,start:state.viewStart,end:state.viewEnd};overview.setPointerCapture(e.pointerId);};
  overview.onpointermove=e=>{if(!mini)return;const b=overview.getBoundingClientRect(),n=Math.max(1,state.samples.length-1),s=Math.max(0,Math.min(n,(e.clientX-b.left)/b.width*n));if(mini.kind==="left")state.viewStart=Math.min(state.viewEnd-1,s);else if(mini.kind==="right")state.viewEnd=Math.max(state.viewStart+1,s);else{const span=mini.end-mini.start;state.viewStart=Math.max(0,Math.min(n-span,mini.start+s-mini.sample));state.viewEnd=state.viewStart+span;}drawWaveform();};
  overview.onpointerup=overview.onpointercancel=()=>{mini=null;renderMeasurements();};
}

function sessionData() {
  return {version:2,mode:state.dataMode,samples:Array.from(state.samples),sampleRate:state.sampleRate,sampleOrigin:state.sampleOrigin,
    triggerIndex:state.triggerIndex,captureId:state.captureId,flags:state.flags,captureConfig:state.captureConfig,
    requestedRate:state.dataRequestedRate||state.sampleRate,depth:state.dataDepth||state.depth,channels:state.channels,order:state.order,visible:state.visible,
    decoders:decoderConfig(),gaps:state.gaps,view:[state.viewStart,state.viewEnd],cursors:[state.cursorA,state.cursorB],
    display:{format:$("decodeFormat").value,range:$("measureRange").value,expanded:[...state.laneExpanded],collapsedGroups:[...state.collapsedGroups]},
    decoderRecords:records(),createdAt:new Date().toISOString()};
}
function saveCapture() {if(state.samples.length){downloadBlob(JSON.stringify(sessionData()),"capture-"+state.captureId+".json","application/json");logEvent("Đã xuất session JSON v2.","ok");}}
async function loadCaptureFile(file) {
  try {
    if(acquiring())throw Error("Hãy Stop trước khi Load session.");
    if(file.size>100*1024*1024)throw Error("Session vượt 100 MiB.");
    const data=LA.validateSession(JSON.parse(await file.text()));
    if(acquiring())throw Error("Thiết bị bắt đầu thu trong khi đọc file; không thay dữ liệu.");
    if(state.samples.length&&!confirm("Thay dữ liệu đang xem bằng session này?"))return;
    clearSamples();Object.assign(state,{samples:Uint8Array.from(data.samples),sampleRate:data.sampleRate,sampleOrigin:data.sampleOrigin,
      triggerIndex:data.triggerIndex,dataMode:data.mode,captureId:data.captureId||0,flags:data.flags||0,captureConfig:data.captureConfig||null,
      channels:data.channels,order:data.order,visible:data.visible||Array(8).fill(true),frozenRecords:data.decoderRecords||null,
      gaps:data.gaps,decoder:null,offlineCache:null,followLive:false,dataRequestedRate:data.requestedRate||data.sampleRate,dataDepth:data.depth||data.samples.length});
    applyDecoderConfig(data.decoders);state.cursorA=data.cursors?.[0]??0;state.cursorB=data.cursors?.[1]??Math.max(0,state.samples.length-1);
    $("decodeFormat").value=data.display?.format||"hex";$("measureRange").value=data.display?.range||"full";
    state.laneExpanded=new Set(data.display?.expanded||[]);state.collapsedGroups=new Set(data.display?.collapsedGroups||[]);
    $("decodeFilter").value="ALL";$("decodeStatusFilter").value="ALL";$("decodeChannelFilter").value="ALL";$("decodeSearch").value="";
    state.viewStart=data.view?.[0]??0;state.viewEnd=data.view?.[1]??Math.max(1,state.samples.length-1);
    buildChannelControls();rebuildChannels();refreshAnalysis();logEvent("Đã load session offline: "+state.samples.length+" mẫu.","ok");
  }catch(error){logEvent("Load bị từ chối: "+error.message,"error");alert(error.message);}
}
const csvCell=value=>'"'+String(value??"").replace(/"/g,'""')+'"';
function csv(rows) {return rows.map(row=>row.map(csvCell).join(",")).join("\r\n");}
function exportCsv() {
  if(!state.samples.length)return;
  const rows=[["sample_absolute","time_s",...state.channels.map((c,i)=>c.name+" (D"+i+")")]];
  state.samples.forEach((sample,i)=>rows.push([state.sampleOrigin+i,sampleTime(i),...state.channels.map((c,ch)=>(sample>>ch)&1)]));
  downloadBlob(csv(rows),"capture-"+state.captureId+".csv","text/csv;charset=utf-8");
}
async function exportData(kind) {
  if(!state.samples.length&&kind!=="logs")return;
  if(kind==="raw")return exportCsv();
  if(kind==="vcd")return downloadBlob(LA.vcd(state.samples,state.sampleRate,state.channels,state.sampleOrigin),"capture.vcd","text/plain");
  if(kind==="png") {const source=$("waveCanvas"),ruler=$("timeCanvas"),c=document.createElement("canvas");c.width=source.width;c.height=source.height+ruler.height;const ctx=c.getContext("2d");ctx.drawImage(ruler,0,0);ctx.drawImage(source,0,ruler.height);c.toBlob(blob=>{if(blob)downloadBlob(blob,"waveform.png","image/png");});return;}
  let measured=null,exportRange=measurementRange(),exportOrigin=state.sampleOrigin,exportRate=state.sampleRate;
  if(kind==="measurements") {
    const samples=state.samples.slice();
    if(state.measurementWorker&&state.streamAccept) {
      if(state.measureExport){logEvent("Đang xuất measurements; chờ tác vụ trước.","error");return;}
      try{measured=await new Promise((resolve,reject)=>{state.measureExport={resolve,reject,timer:setTimeout(()=>{state.measureExport=null;reject(Error("Measurement export timeout"));},10000)};state.measurementWorker.postMessage({id:"export",samples,rate:exportRate,from:exportRange[0],to:exportRange[1]},[samples.buffer]);});}
      catch(error){logEvent("Export thất bại: "+error.message,"error");return;}
    }else measured=Array.from({length:8},(_,ch)=>LA.measure(samples,exportRate,ch,...exportRange));
  }
  const rows=kind==="decoded"?[["start_s","end_s","protocol","channel","type","data","status"],...filteredRecords().map(r=>[sampleTime(r.startIndex-state.sampleOrigin),sampleTime(r.endIndex-state.sampleOrigin),r.protocol,channelName(r.channel),r.kind,eventData(r),eventInfo(r)])]:kind==="measurements"?[["channel","frequency_Hz","period_s","duty_percent","high_s","low_s","rising","falling","period_stddev_s","range_samples","origin","sample_rate_Hz"],...state.order.map(ch=>{const m=measured[ch];return[channelName(ch),m.frequency,m.period,m.duty,m.high,m.low,m.rising,m.falling,m.jitter,exportRange.join(":"),exportOrigin,exportRate];})]:[["timestamp_UTC","severity","category","message","count"],...state.logs.map(r=>[r.time,r.type,r.category,r.message,r.count])];
  downloadBlob(csv(rows),kind+".csv","text/csv;charset=utf-8");
}
function savePreferences() {
  try{localStorage.setItem("etview.preferences.v2",JSON.stringify({channels:state.channels,order:state.order,visible:state.visible,decoders:decoderConfig(),dark:document.body.classList.contains("dark"),layout:state.layout||{}}));}catch{}
}
function setupEvents() {
  const click=(id,fn)=>$(id).addEventListener("click",fn);
  click("connectBtn",connectSerial);click("startBtn",startAcquisition);click("stopBtn",stopAcquisition);click("resetBtn",resetDashboard);
  click("runSelfTestBtn",runSelfTest);click("stopSelfTestBtn",()=>stopSelfTest(false));$("selfTestProtocol").onchange=updateSelfTestWiring;
  click("saveBtn",saveCapture);click("loadBtn",()=>$("loadInput").click());$("loadInput").onchange=e=>{if(e.target.files[0])loadCaptureFile(e.target.files[0]);e.target.value="";};
  click("exportBtn",()=>$("exportDialog").showModal());document.querySelectorAll("[data-export]").forEach(b=>b.onclick=()=>{exportData(b.dataset.export);$("exportDialog").close();});
  click("themeBtn",()=>{document.body.classList.toggle("dark");savePreferences();});
  $("modeSelect").onchange=()=>setMode($("modeSelect").value);$("rateSelect").onchange=()=>{state.requestedRate=Number($("rateSelect").value);updateFooterStatus();};
  $("depthSelect").onchange=()=>{state.depth=Number($("depthSelect").value);updateFooterStatus();};
  click("allChannelsBtn",()=>{state.visible.fill(true);buildChannelControls();refreshAnalysis();});click("noChannelsBtn",()=>{state.visible.fill(false);buildChannelControls();refreshAnalysis();});
  click("zoomInBtn",()=>zoom(.65));click("zoomOutBtn",()=>zoom(1.5));click("fitBtn",fitWaveform);
  for(const [id,mode]of[["cursorBtn","CURSOR"],["panBtn","PAN"],["selectBtn","SELECT"]])click(id,()=>setInteractionMode(mode));
  click("zoomSelection",()=>{if(state.selection&&state.selection[0]!==state.selection[1]){state.viewStart=Math.min(...state.selection);state.viewEnd=Math.max(...state.selection);state.selection=null;refreshAnalysis();}});
  click("snapBtn",()=>{state.cursorSnap=!state.cursorSnap;$("snapBtn").classList.toggle("active",state.cursorSnap);});
  click("prevEdgeBtn",()=>navigateEdge(-1));click("nextEdgeBtn",()=>navigateEdge(1));click("cursorAPill",()=>setActiveCursor("A"));click("cursorBPill",()=>setActiveCursor("B"));
  for(const [id,key]of[["gotoA","cursorA"],["gotoB","cursorB"],["gotoTrigger","triggerIndex"]])click(id,()=>{setFollow(false);if(state[key]!==null){centerViewOn(state[key]);drawWaveform();}});
  click("followBtn",()=>setFollow(!state.followLive));click("liveBtn",()=>setFollow(true));
  $("autoMeasure").onchange=()=>{state.hoverPulse=null;drawWaveform();};
  click("clearLogBtn",()=>{state.logs=[];renderLogs();});click("exportLogBtn",()=>exportData("logs"));
  ["logSeverity","logCategory","logSearch"].forEach(id=>$(id).addEventListener("input",renderLogs));
  $("selectedChannel").onchange=()=>{updateSelectedChannel();drawWaveform();};$("measureRange").onchange=()=>{renderMeasurements();updateSelectedChannel();};
  for(const id of DECODER_IDS)$(id).addEventListener("change",()=>{state.offlineCache=null;state.frozenRecords=null;state.selectedEvent=null;text("eventDetails","Decoder configuration changed; results recomputed from retained raw.");refreshAnalysis();savePreferences();});
  for(const id of ["decodeFilter","decodeSearch","decodeView","decodeSort","decodeChannelFilter","decodeStatusFilter"])$(id).addEventListener("input",()=>{$("decodedScroll").scrollTop=0;renderDecodedData();});
  click("clearDecodeFilters",()=>{$("decodeFilter").value="ALL";$("decodeChannelFilter").value="ALL";$("decodeStatusFilter").value="ALL";$("decodeSearch").value="";renderDecodedData();});
  $("decodeFormat").onchange=()=>{renderDecodedData();drawWaveform();};
  $("decodedScroll").onscroll=()=>{if(state.tableFrame)return;state.tableFrame=requestAnimationFrame(()=>{state.tableFrame=null;renderDecodedRows();});};
  $("decodedTableBody").onclick=e=>{const row=e.target.closest("tr[data-event]");if(row)selectEvent(row.dataset.event);};
  click("copyDecoded",async()=>{try{await navigator.clipboard.writeText(filteredRecords().map(r=>[formatTime(sampleTime(r.index-state.sampleOrigin)),r.protocol,eventData(r),eventInfo(r)].join("\t")).join("\n"));}catch(e){logEvent("Copy thất bại: "+e.message,"error");}});
  click("exportDecoded",()=>exportData("decoded"));
  $("channelForm").onsubmit=e=>{e.preventDefault();const c=state.channels[state.editingChannel];Object.assign(c,{name:$("channelNameInput").value.trim()||"D"+state.editingChannel,color:$("channelColorInput").value,height:Number($("channelHeightInput").value),group:$("channelGroupInput").value.trim()});$("channelDialog").close();rebuildChannels();};
  document.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>$(b.dataset.close).close());
  for(const [id,cls]of[["toggleLeft","hide-left"],["toggleRight","hide-right"],["toggleBottom","hide-bottom"],["expandWave","focus-wave"]])click(id,()=>{document.body.classList.toggle(cls);requestAnimationFrame(drawWaveform);});
  for(const [id,variable,axis,min,max]of[["leftResizer","--left-width","x",210,420],["bottomResizer","--bottom-height","y",120,650]]) {
    const el=$(id);let start=null;el.onpointerdown=e=>{start={x:e.clientX,y:e.clientY,size:axis==="x"?document.querySelector(".left-panel").clientWidth:document.querySelector(".analysis-card").clientHeight};el.setPointerCapture(e.pointerId);};
    el.onpointermove=e=>{if(!start)return;const delta=axis==="x"?e.clientX-start.x:start.y-e.clientY,value=Math.max(min,Math.min(max,start.size+delta));document.documentElement.style.setProperty(variable,value+"px");state.layout={...state.layout,[variable]:value};drawWaveform();};el.onpointerup=el.onpointercancel=()=>{start=null;savePreferences();};
  }
  document.addEventListener("keydown",e=>{if(e.target.matches("input,textarea,select")||document.querySelector("dialog[open]"))return;if(e.key===" "){e.preventDefault();acquiring()?stopAcquisition():startAcquisition();}if(e.key==="+")zoom(.65);if(e.key==="-")zoom(1.5);if(e.key.toLowerCase()==="f")fitWaveform();if(e.key.toLowerCase()==="a")setActiveCursor("A");if(e.key.toLowerCase()==="b")setActiveCursor("B");if(e.key==="ArrowLeft")navigateEdge(-1);if(e.key==="ArrowRight")navigateEdge(1);});
  window.addEventListener("resize",drawWaveform);new ResizeObserver(()=>drawWaveform()).observe(document.querySelector(".canvas-wrap"));
  if(navigator.serial)navigator.serial.addEventListener("disconnect",e=>{if(e.target===state.port)disconnectSerial();});
  setupTabs();setupCanvasInteraction();
}
function initialize() {
  try {const p=JSON.parse(localStorage.getItem("etview.preferences.v2")||"null");if(p){const v=LA.validateSession({version:2,mode:"CAPTURE",samples:[0],sampleRate:1000000,sampleOrigin:0,triggerIndex:null,...p});state.channels=v.channels;state.order=v.order;state.visible=v.visible||state.visible;document.body.classList.toggle("dark",!!p.dark);state.savedDecoders=v.decoders;for(const [key,min,max]of[["--left-width",210,420],["--bottom-height",120,650]])if(Number.isFinite(p.layout?.[key])){const value=Math.max(min,Math.min(max,p.layout[key]));document.documentElement.style.setProperty(key,value+"px");state.layout={...state.layout,[key]:value};}}}catch{}
  buildChannelControls();for(const id of ["triggerChannel","uartChannel","uartTxChannel","i2cScl","i2cSda","spiCs","spiClk","spiMosi","spiMiso","selectedChannel"])fillChannelSelect($(id),LA.DEFAULTS[id]??0,id==="uartTxChannel");
  fillChannelSelect($("decodeChannelFilter"),0);$("decodeChannelFilter").innerHTML='<option value="ALL">All channels</option>'+$("decodeChannelFilter").innerHTML;$("decodeChannelFilter").value="ALL";
  if(state.savedDecoders)applyDecoderConfig(state.savedDecoders);
  fillRateSelect($("rateSelect"),"CAPTURE",100000);updateSelfTestWiring();setSelfTestStatus("OFF");clearSamples();setupMeasurementWorker();setupEvents();updateConnectionUi();refreshAnalysis();
  logEvent("Dashboard sẵn sàng. Hãy kết nối STM32 USB CDC.");if(!navigator.serial)logEvent("Web Serial không khả dụng; dùng Chrome/Edge qua localhost.","error");
}

initialize();
