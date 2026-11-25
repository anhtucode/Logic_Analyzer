/* Pure sample-index analysis. No DOM, transport, generated data or firmware commands. */
(function (root) {
  "use strict";
  const DEFAULTS = Object.freeze({ uartEnabled: true, uartChannel: 0, uartTxChannel: -1,
    uartBaud: 115200, uartDataBits: 8, uartParity: "none", uartStopBits: 1, uartBitOrder: "lsb",
    spiEnabled: false, spiCs: 2, spiClk: 0, spiMosi: 1, spiMiso: 3, spiMode: 0,
    spiWordSize: 8, spiBitOrder: "msb", spiCsActive: 0,
    i2cEnabled: false, i2cScl: 0, i2cSda: 1 });
  const bit = (value, channel) => (value >> channel) & 1;
  const channel = value => Number.isInteger(value) && value >= 0 && value <= 7;
  function validate(rate, cfg) {
    const errors = {}, warnings = {};
    const unique = ids => ids.every(channel) && new Set(ids).size === ids.length;
    if (!Number.isFinite(rate) || rate <= 0) throw Error("Sample rate không hợp lệ");
    if (!unique([cfg.uartChannel]) || (cfg.uartTxChannel !== -1 &&
      !unique([cfg.uartChannel, cfg.uartTxChannel]))) errors.uart = "RX/TX phải là các kênh D0–D7 khác nhau.";
    if (!Number.isFinite(cfg.uartBaud) || cfg.uartBaud <= 0 || rate / cfg.uartBaud < 3)
      errors.uart = "Sample rate quá thấp: cần ít nhất 3 mẫu/bit UART.";
    else if (rate / cfg.uartBaud < 8) warnings.uart = "Dưới 8 mẫu/bit UART; nên tăng sample rate hoặc giảm baud của nguồn và decoder.";
    if (![5, 6, 7, 8, 9].includes(cfg.uartDataBits) || ![1, 1.5, 2].includes(cfg.uartStopBits) ||
      !["none", "even", "odd"].includes(cfg.uartParity) || !["lsb", "msb"].includes(cfg.uartBitOrder))
      errors.uart = "Định dạng UART không hợp lệ.";
    if (!unique([cfg.spiCs, cfg.spiClk, cfg.spiMosi, cfg.spiMiso])) errors.spi = "Chọn các kênh D0–D7 khác nhau cho từng tín hiệu.";
    if (![0, 1, 2, 3].includes(cfg.spiMode) || !Number.isInteger(cfg.spiWordSize) || cfg.spiWordSize < 1 || cfg.spiWordSize > 32 ||
      ![0, 1].includes(cfg.spiCsActive) || !["lsb", "msb"].includes(cfg.spiBitOrder)) errors.spi = "Cấu hình SPI không hợp lệ.";
    if (!unique([cfg.i2cScl, cfg.i2cSda])) errors.i2c = "Chọn các kênh D0–D7 khác nhau cho SCL/SDA.";
    return { errors, warnings };
  }

  class Decoder {
    constructor(rate, options = {}, epoch = "offline", maxRecords = 12000) {
      this.rate = rate; this.cfg = { ...DEFAULTS, ...options }; this.epoch = epoch;
      Object.keys(this.cfg).forEach(key => { if (typeof DEFAULTS[key] === "number") this.cfg[key] = Number(this.cfg[key]); });
      this.validation = validate(rate, this.cfg); this.maxRecords = maxRecords;
      this.records = []; this.next = null; this.serial = 0; this.revision = 0; this.transactions = {UART:0,SPI:0,I2C:0};
      this.hints = { uart: new Set(), spi: new Set(), i2c: new Set() }; this.errorCount = 0;
      this.resetState();
    }
    resetState() {
      const c = this.cfg;
      this.uarts = [c.uartChannel, ...(c.uartTxChannel === -1 ? [] : [c.uartTxChannel])]
        .map((ch, i) => ({ channel: ch, role: i ? "TX" : "RX", previous: null, high: 0, sync: false, pending: null }));
      this.spi = { previous: null, tx: null, bits: [], mosi: 0, miso: 0, lastEdge: null };
      this.i2c = { previous: null, tx: null, bits: [], pending: null, address: true, unsupported: false, lastEdge: null };
    }
    emit(protocol, kind, start, end, fields = {}) {
      const record = { protocol, kind, index: start, startIndex: start, endIndex: end,
        id: this.epoch + ":" + (++this.serial), status: "OK", ...fields };
      this.records.push(record);
      if (record.status === "ERROR") this.errorCount++;
      if (this.records.length > this.maxRecords * 2) this.records.splice(0, this.records.length - this.maxRecords);
      return record;
    }
    hint(protocol, text) { this.hints[protocol].add(text); }
    begin(protocol, at, channelId) {
      return this.emit(protocol, "TRANSACTION", at, at, { channel: channelId,
        transaction: ++this.transactions[protocol], status: "OPEN", count: 0 });
    }
    incomplete(protocol, start, end, fields = {}) {
      return this.emit(protocol, "INCOMPLETE", start, end, { status: "INCOMPLETE", ...fields });
    }
    gap(at, reason, missing = null) {
      this.finish();
      this.emit("SYSTEM", "GAP", at, at, { status: "ERROR", reason, missing });
      this.resetState(); this.next = null;
    }
    feed(samples, first = this.next === null ? 0 : this.next) {
      this.revision++;
      if (!Number.isSafeInteger(first) || first < 0) throw Error("Sample index không hợp lệ");
      if (this.next !== null && first !== this.next) this.gap(this.next, "Sample index discontinuity", first > this.next ? first - this.next : null);
      const c = this.cfg;
      for (let k = 0; k < samples.length; k++) {
        const value = samples[k], index = first + k;
        if (c.uartEnabled && !this.validation.errors.uart) for (const u of this.uarts) this.uartSample(u, bit(value, u.channel), index);
        if (c.spiEnabled && !this.validation.errors.spi) this.spiSample(value, index);
        if (c.i2cEnabled && !this.validation.errors.i2c) this.i2cSample(value, index);
      }
      this.next = first + samples.length;
      return this;
    }
    uartSample(u, level, index) {
      const c = this.cfg, spb = this.rate / c.uartBaud, oldHigh = u.high;
      u.high = level ? u.high + 1 : 0;
      let p = u.pending;
      if (p && index >= p.target) {
        if (p.stage === "start") {
          if (level) { u.pending = null; u.previous = level; return; }
          p.stage = "data"; p.position = 0; p.target = Math.round(p.edge + 1.5 * spb);
        } else if (p.stage === "data") {
          p.bits.push({ index, value: level });
          const position = c.uartBitOrder === "lsb" ? p.position : c.uartDataBits - 1 - p.position;
          p.value += level * 2 ** position; p.ones += level; p.position++;
          if (p.position < c.uartDataBits) p.target = Math.round(p.edge + (1.5 + p.position) * spb);
          else {
            p.stage = c.uartParity === "none" ? "stop" : "parity";
            p.target = Math.round(p.edge + (1.5 + c.uartDataBits) * spb);
          }
        } else if (p.stage === "parity") {
          p.parityIndex = index;
          p.parityError = level !== ((p.ones & 1) ^ (c.uartParity === "odd" ? 1 : 0));
          p.stage = "stop"; p.target = Math.round(p.edge + (2.5 + c.uartDataBits) * spb);
        } else {
          p.stopIndices.push(index); if (!level) p.framingError = true;
          if (p.stopIndices.length === 1 && c.uartStopBits > 1) {
            const stopStart = 1 + c.uartDataBits + (c.uartParity === "none" ? 0 : 1);
            p.target = Math.round(p.edge + (stopStart + (c.uartStopBits === 1.5 ? 1.25 : 1.5)) * spb);
          } else {
            this.emit("UART", "FRAME", p.start, index, { channel: u.channel, role: u.role,
              value: p.value, width: c.uartDataBits, framingError: p.framingError,
              parityError: p.parityError, unsynchronized: !u.sync, bits: p.bits,
              startEdge: p.edge, samplesPerBit: spb, parityIndex: p.parityIndex,
              stopIndices: p.stopIndices, status: p.framingError || p.parityError ? "ERROR" : u.sync ? "OK" : "UNSYNC" });
            if (p.framingError || p.parityError) u.sync = false;
            u.pending = null;
          }
        }
      } else if (!p && u.previous === 1 && level === 0) {
        const highLimit = (1 + c.uartDataBits + (c.uartParity === "none" ? 0 : 1) + c.uartStopBits) * spb;
        if (oldHigh >= Math.ceil(highLimit)) u.sync = true;
        const edge = index - 0.5;
        u.pending = { start: index, edge, stage: "start", target: Math.round(edge + 0.5 * spb),
          bits: [], value: 0, ones: 0, stopIndices: [], framingError: false, parityError: false, parityIndex: null };
      }
      u.previous = level;
    }
    spiError(index, message) {
      const s = this.spi;
      if (s.tx && !s.tx.error) {
        s.tx.error = message; s.tx.status = "ERROR";
        this.emit("SPI", "ERROR", index, index, { status: "ERROR", reason: message,
          channel: this.cfg.spiClk, transaction: s.tx.transaction });
      }
      this.hint("spi", message);
    }
    spiSample(value, index) {
      const c = this.cfg, s = this.spi, cs = bit(value, c.spiCs), clk = bit(value, c.spiClk), idle = c.spiMode >> 1;
      if (s.previous === null) {
        if (cs === c.spiCsActive) this.hint("spi", "CAPTURE BOUNDARY: CS đã active ở đầu capture; chờ CS nhả rồi active lại.");
        s.previous = value; return;
      }
      const previous = s.previous, oldCs = bit(previous, c.spiCs), oldClk = bit(previous, c.spiClk);
      s.previous = value;
      if (oldCs !== cs && cs === c.spiCsActive) {
        s.tx = this.begin("SPI", index, c.spiCs); s.bits = []; s.mosi = s.miso = 0; s.lastEdge = null;
        if (oldClk !== clk || oldClk !== idle) this.spiError(index, "TIMING: CS/SCK không rõ thứ tự hoặc SCK sai mức nghỉ; bỏ giao dịch.");
        return;
      }
      if (oldCs !== cs && cs !== c.spiCsActive) {
        if (s.tx) {
          if (oldClk !== clk) this.spiError(index, "TIMING: CS/SCK đổi cùng mẫu; bỏ giao dịch.");
          if (s.bits.length) this.incomplete("SPI", s.bits[0], index, { channel: c.spiMosi,
            reason: "INCOMPLETE: CS nhả khi word chưa đủ bit", transaction: s.tx.transaction, width: s.bits.length });
          s.tx.status = s.tx.error ? "ERROR" : s.bits.length ? "INCOMPLETE" : "OK";
          s.tx.endIndex = index;
        }
        s.tx = null; s.bits = []; return;
      }
      if (s.tx) s.tx.endIndex = index;
      if (!s.tx || cs !== c.spiCsActive || s.tx.error || clk === oldClk) return;
      if (s.lastEdge !== null && index - s.lastEdge < 4) this.hint("spi", "Dưới 8 mẫu/chu kỳ SCK; nên tăng sample rate.");
      s.lastEdge = index;
      if ((clk === 1) !== (c.spiMode === 0 || c.spiMode === 3)) return;
      if (((value ^ previous) & ((1 << c.spiMosi) | (1 << c.spiMiso))) !== 0) {
        this.spiError(index, "TIMING: data đổi cùng mẫu với cạnh đọc SCK; kiểm tra Mode hoặc tăng sample rate."); return;
      }
      const out = bit(value, c.spiMosi), incoming = bit(value, c.spiMiso), pos = s.bits.length;
      if (c.spiBitOrder === "msb") { s.mosi = (s.mosi * 2 + out) >>> 0; s.miso = (s.miso * 2 + incoming) >>> 0; }
      else { s.mosi = (s.mosi + out * 2 ** pos) >>> 0; s.miso = (s.miso + incoming * 2 ** pos) >>> 0; }
      s.bits.push(index);
      if (s.bits.length === c.spiWordSize) {
        this.emit("SPI", "WORD", s.bits[0], index, { channel: c.spiMosi, mosi: s.mosi, miso: s.miso,
          width: c.spiWordSize, mode: c.spiMode, bitOrder: c.spiBitOrder, transaction: s.tx.transaction, transactionRef: s.tx,
          bits: s.bits, mosiChannel: c.spiMosi, misoChannel: c.spiMiso });
        s.tx.count++; s.bits = []; s.mosi = s.miso = 0;
      }
    }
    i2cSample(value, index) {
      const c = this.cfg, s = this.i2c, scl = bit(value, c.i2cScl), sda = bit(value, c.i2cSda);
      if (s.previous === null) {
        if (!scl || !sda) this.hint("i2c", "CAPTURE BOUNDARY: chưa đồng bộ đầu giao dịch; chờ START thực.");
        s.previous = value; return;
      }
      const oldScl = bit(s.previous, c.i2cScl), oldSda = bit(s.previous, c.i2cSda); s.previous = value;
      if(oldScl!==scl){if(s.lastEdge!==null&&index-s.lastEdge<4)this.hint("i2c","Dưới 8 mẫu/chu kỳ SCL quan sát; nên tăng sample rate hoặc giảm clock nguồn.");s.lastEdge=index;}
      if (oldScl && scl && oldSda !== sda) {
        s.pending = null; // SCL chuan bi START/STOP khong phai bit data.
        if (!sda) {
          const repeat = !!s.tx;
          if (s.tx) { s.tx.endIndex = index; s.tx.status = s.bits.length ? "INCOMPLETE" : "OK";
            if (s.bits.length) this.incomplete("I2C", s.bits[0].index, index, { channel: c.i2cSda, reason: "Byte bị ngắt bởi repeated START" }); }
          s.tx = this.begin("I2C", index, c.i2cSda); s.address = true; s.unsupported = false; s.bits = [];
          this.emit("I2C", repeat ? "RESTART" : "START", index, index, { channel: c.i2cSda, value: null, transaction: s.tx.transaction });
        } else if (s.tx) {
          if (s.bits.length) this.incomplete("I2C", s.bits[0].index, index, { channel: c.i2cSda, reason: "Byte chưa đủ data/ACK trước STOP" });
          this.emit("I2C", "STOP", index, index, { channel: c.i2cSda, value: null, transaction: s.tx.transaction });
          s.tx.endIndex = index; s.tx.status = s.unsupported ? "UNSUPPORTED" : s.bits.length ? "INCOMPLETE" : "OK";
          s.tx = null; s.bits = [];
        }
        return;
      }
      if (!s.tx) return;
      s.tx.endIndex = index;
      if (!oldScl && scl && !s.unsupported) {
        if (oldSda !== sda) {
          this.emit("I2C", "ERROR", index, index, { status: "ERROR", channel: c.i2cSda,
            reason: "TIMING: SCL/SDA đổi cùng mẫu; chờ START tiếp theo." });
          s.tx.status = "ERROR"; s.tx = null; s.bits = []; s.pending = null;
        } else s.pending = { index, value: sda };
      }
      if (oldScl && !scl && s.pending && !s.unsupported) {
        s.bits.push(s.pending); s.pending = null;
        if (s.bits.length === 9) {
          let byte = 0; for (let b = 0; b < 8; b++) byte = byte * 2 + s.bits[b].value;
          const unsupported = s.address && (byte & 0xf8) === 0xf0;
          this.emit("I2C", s.address ? "ADDRESS" : "DATA", s.bits[0].index, s.bits[8].index, {
            channel: c.i2cSda, value: byte, ack: !s.bits[8].value, bits: s.bits,
            transaction: s.tx.transaction, address: s.address && !unsupported ? byte >> 1 : null,
            read: s.address && !unsupported ? !!(byte & 1) : null, unsupported,
            status: unsupported ? "UNSUPPORTED" : "OK" });
          if (s.address) { s.tx.address = unsupported ? null : byte >> 1; s.tx.read = !!(byte & 1); }
          s.tx.count++; s.address = false; s.unsupported = unsupported; s.bits = [];
          if (unsupported) this.hint("i2c", "UNSUPPORTED: địa chỉ I²C 10 bit; không diễn giải phần dữ liệu.");
        }
      }
    }
    finish() {
      this.revision++;
      const end = Math.max(0, (this.next === null ? 0 : this.next) - 1);
      for (const u of this.uarts) if (u.pending) {
        this.incomplete("UART", u.pending.start, end, { channel: u.channel, role: u.role,
          reason: "INCOMPLETE: thiếu data/stop bit ở cuối capture.", bits: u.pending.bits }); u.pending = null;
      }
      const s = this.spi;
      if (s.tx) {
        s.tx.endIndex = end; s.tx.status = s.tx.error ? "ERROR" : "INCOMPLETE"; s.tx.boundary = true;
        if (s.bits.length) this.incomplete("SPI", s.bits[0], end, { channel: this.cfg.spiMosi,
          reason: "INCOMPLETE: cuối capture CS còn active, word chưa đủ bit.", width: s.bits.length });
        this.hint("spi", "INCOMPLETE: cuối capture CS còn active."); s.tx = null;
      }
      const i = this.i2c;
      if (i.tx) {
        i.tx.endIndex = end; i.tx.status = "INCOMPLETE"; i.tx.boundary = true;
        this.incomplete("I2C", i.bits.length ? i.bits[0].index : end, end, { channel: this.cfg.i2cSda,
          reason: "INCOMPLETE: cuối capture chưa có STOP hoặc byte chưa đủ ACK." }); i.tx = null;
      }
      return this;
    }
    getRecords(start = -Infinity, end = Infinity) {
      return this.records.slice(-this.maxRecords).filter(r => r.endIndex >= start && r.startIndex <= end);
    }
    prune(start) { this.records = this.records.filter(r => r.endIndex >= start || r === this.spi.tx || r === this.i2c.tx); }
  }

  function decode(samples, rate, config, first = 0) { return new Decoder(rate, config).feed(samples, first).finish(); }

  class Ring {
    constructor(capacity) {
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1048576) throw Error("PC buffer không hợp lệ");
      this.data = new Uint8Array(capacity); this.clear();
    }
    clear() { this.write = this.count = this.next = this.evicted = 0; }
    append(bytes, first = this.next) {
      if (this.count && first !== this.next) throw Error("Data gap: không nối raw samples qua khoảng thiếu");
      let source = bytes;
      const old = this.count;
      if (source.length > this.data.length) source = source.subarray(source.length - this.data.length);
      const firstPart = Math.min(source.length, this.data.length - this.write);
      this.data.set(source.subarray(0, firstPart), this.write); this.data.set(source.subarray(firstPart), 0);
      this.write = (this.write + source.length) % this.data.length;
      this.count = Math.min(this.data.length, old + source.length);
      this.evicted += Math.max(0, old + bytes.length - this.data.length);
      this.next = first + bytes.length;
    }
    snapshot() {
      const out = new Uint8Array(this.count), start = (this.write - this.count + this.data.length) % this.data.length;
      const first = Math.min(this.count, this.data.length - start);
      out.set(this.data.subarray(start, start + first)); out.set(this.data.subarray(0, this.count - first), first);
      return { samples: out, first: this.next - this.count, next: this.next };
    }
  }

  function statistics(values) {
    if (!values.length) return { min: null, max: null, mean: null, stddev: null, count: 0 };
    const mean = values.reduce((sum, n) => sum + n, 0) / values.length;
    let min = Infinity, max = -Infinity;
    for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
    return { min, max, mean,
      stddev: Math.sqrt(values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / values.length), count: values.length };
  }
  function measure(samples, rate, channelId, from = 0, to = samples.length) {
    const start = Math.max(0, Math.ceil(from)), end = Math.min(samples.length, Math.floor(to));
    // Welford accumulators avoid allocating one object/array entry per edge.
    const accumulator = () => ({min:Infinity,max:-Infinity,mean:0,m2:0,count:0});
    const high = accumulator(), low = accumulator(), periods = accumulator(), duties = accumulator();
    const add = (s,value) => {s.count++;s.min=Math.min(s.min,value);s.max=Math.max(s.max,value);const delta=value-s.mean;s.mean+=delta/s.count;s.m2+=delta*(value-s.mean);};
    const result = (s,scale=1) => s.count ? {min:s.min/scale,max:s.max/scale,mean:s.mean/scale,stddev:Math.sqrt(s.m2/s.count)/scale,count:s.count} : {min:null,max:null,mean:null,stddev:null,count:0};
    let run = start, highCount = 0, rising = 0, falling = 0, lastRise = null, riseHighCount = 0;
    for (let i = start; i < end; i++) {
      const current = bit(samples[i], channelId); highCount += current;
      if (i === start || current === bit(samples[i - 1], channelId)) continue;
      if (current) {
        rising++;
        if (lastRise !== null) {add(periods,i-lastRise);add(duties,100*(highCount-riseHighCount)/(i-lastRise));}
        lastRise=i;riseHighCount=highCount;
      } else falling++;
      if (run > start) add(current ? low : high,i-run);
      run = i;
    }
    const p = result(periods,rate), h = result(high,rate), l = result(low,rate), duty = result(duties);
    return { frequency: p.mean ? 1 / p.mean : null, period: p.mean, duty: duty.mean,
      high: h.mean, low: l.mean, transitions: rising + falling, rising,
      falling, highStats: h, lowStats: l, periodStats: p, dutyStats: duty,
      resolution: 1 / rate, jitter: p.count > 1 ? p.stddev : null };
  }
  function bins(samples, channelId, from, to, columns) {
    const start = Math.max(0, Math.floor(from)), end = Math.min(samples.length, Math.ceil(to) + 1);
    const output = [];
    for (let pixel = 0; pixel < columns; pixel++) {
      const a = Math.max(start, Math.floor(from + pixel * (to - from) / columns));
      const b = Math.min(end, Math.max(a + 1, Math.ceil(from + (pixel + 1) * (to - from) / columns)));
      if (a >= end) break;
      let lo = 1, hi = 0;
      for (let i = a; i < b; i++) { const level = bit(samples[i], channelId); lo &= level; hi |= level; }
      output.push({ first: bit(samples[a], channelId), last: bit(samples[b - 1], channelId), lo, hi, start: a, end: b });
    }
    return output;
  }

  function validateSession(input) {
    if (!input || typeof input !== "object" || ![1, 2].includes(input.version)) throw Error("Session version không hỗ trợ");
    if (!Array.isArray(input.samples) || !input.samples.length || input.samples.length > 1048576 ||
      !input.samples.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw Error("Raw samples phải là byte, tối đa 1048576 mẫu");
    if (!Number.isFinite(input.sampleRate) || input.sampleRate <= 0 || input.sampleRate > 1000000) throw Error("Sample rate session không hợp lệ");
    const origin = input.version === 2 ? input.sampleOrigin : 0;
    if (!Number.isSafeInteger(origin) || origin < 0 || !Number.isSafeInteger(origin+input.samples.length)) throw Error("Sample origin không hợp lệ");
    const trigger = input.triggerIndex ?? null;
    if (trigger !== null && (!Number.isInteger(trigger) || trigger < 0 || trigger >= input.samples.length)) throw Error("Trigger index không hợp lệ");
    if (input.version === 2 && !["CAPTURE", "STREAM"].includes(input.mode)) throw Error("Mode session không hợp lệ");
    const channels = input.channels || Array.from({ length: 8 }, (_, i) => ({ name: "D" + i, color: "#1677ff", height: 38, group: "" }));
    if (!Array.isArray(channels) || channels.length !== 8 || !channels.every(c => c && typeof c.name === "string" && c.name.length <= 32 &&
      /^#[0-9a-f]{6}$/i.test(c.color) && Number.isFinite(c.height) && c.height >= 24 && c.height <= 120 &&
      typeof c.group === "string" && c.group.length <= 24)) throw Error("Channel metadata không hợp lệ");
    const order = input.order || [0, 1, 2, 3, 4, 5, 6, 7];
    if (!Array.isArray(order) || order.length !== 8 || new Set(order).size !== 8 || !order.every(channel)) throw Error("Channel order không hợp lệ");
    const decoders = { ...DEFAULTS, ...input.decoders };
    if (Object.keys(DEFAULTS).some(k => typeof decoders[k] !== typeof DEFAULTS[k])) throw Error("Decoder settings sai kiểu dữ liệu");
    // A low acquisition rate is a decoder diagnostic, not a corrupt raw session.
    const checked = validate(Math.max(input.sampleRate, decoders.uartBaud * 3), decoders);
    for (const p of ["uart", "spi", "i2c"]) if (decoders[p + "Enabled"] && checked.errors[p]) throw Error(checked.errors[p]);
    if (input.gaps && (!Array.isArray(input.gaps) || input.gaps.length > 100 || !input.gaps.every(g => g &&
      Number.isSafeInteger(g.index) && g.index >= origin + input.samples.length && (g.missing === null || Number.isSafeInteger(g.missing) && g.missing >= 0))))
      throw Error("Session chỉ hỗ trợ gap ở biên sau raw prefix; không dựng timeline giả");
    if (input.visible && (!Array.isArray(input.visible) || input.visible.length !== 8 || !input.visible.every(v => typeof v === "boolean"))) throw Error("Visible channels không hợp lệ");
    if (input.view && (!Array.isArray(input.view) || input.view.length !== 2 || !input.view.every(Number.isFinite) || input.view[0] < 0 || input.view[1] < input.view[0] || input.view[1] > Math.max(1,input.samples.length - 1))) throw Error("Viewport không hợp lệ");
    if (input.cursors && (!Array.isArray(input.cursors) || input.cursors.length !== 2 || !input.cursors.every(Number.isSafeInteger))) throw Error("Cursors không hợp lệ");
    if (input.flags !== undefined && (!Number.isInteger(input.flags) || input.flags < 0 || input.flags > 65535)) throw Error("Flags không hợp lệ");
    if (input.captureId !== undefined && (!Number.isInteger(input.captureId) || input.captureId < 0 || input.captureId > 0xffffffff)) throw Error("Capture ID không hợp lệ");
    if (input.version === 2 && input.mode === "STREAM" && trigger !== null) throw Error("Stream không có trigger");
    if (input.captureConfig && (!input.captureConfig || !["0","1","2"].includes(input.captureConfig.triggerType) || !channel(input.captureConfig.channel) || !Number.isFinite(input.captureConfig.pretrigger) || input.captureConfig.pretrigger < 0 || input.captureConfig.pretrigger > 100)) throw Error("Trigger config không hợp lệ");
    if (input.display && (!["hex","decimal","binary","ascii"].includes(input.display.format) || !["full","visible","cursors"].includes(input.display.range) ||
      !Array.isArray(input.display.expanded) || input.display.expanded.length>3 || !input.display.expanded.every(p=>["UART","I2C","SPI"].includes(p)) ||
      !Array.isArray(input.display.collapsedGroups) || input.display.collapsedGroups.length>8 || !input.display.collapsedGroups.every(g=>typeof g==="string"&&g.length<=24))) throw Error("Display settings không hợp lệ");
    if (input.decoderRecords) {
      const limit = origin + input.samples.length;
      const position = n => Number.isSafeInteger(n) && n >= 0 && n <= limit;
      const ids = new Set();
      if (!Array.isArray(input.decoderRecords) || input.decoderRecords.length > 12000 || !input.decoderRecords.every(r => {
        if (!r || !["UART","SPI","I2C","SYSTEM"].includes(r.protocol) || !["TRANSACTION","FRAME","WORD","ADDRESS","DATA","START","STOP","RESTART","ERROR","INCOMPLETE","GAP"].includes(r.kind) ||
          typeof r.id !== "string" || r.id.length > 120 || ids.has(r.id) || !position(r.index) || !position(r.startIndex) || !position(r.endIndex) || r.startIndex > r.endIndex ||
          (r.channel !== undefined && !channel(r.channel)) || !["OK","OPEN","UNSYNC","ERROR","UNSUPPORTED","INCOMPLETE"].includes(r.status)) return false;
        ids.add(r.id);
        for (const k of ["value","mosi","miso"]) if (r[k] !== undefined && r[k] !== null && (!Number.isInteger(r[k]) || r[k] < 0 || r[k] > 0xffffffff)) return false;
        if (r.bits && (!Array.isArray(r.bits) || r.bits.length > 32 || !r.bits.every(b => typeof b === "number" ? position(b) : b && position(b.index) && [0,1].includes(b.value)))) return false;
        if (r.stopIndices && (!Array.isArray(r.stopIndices) || r.stopIndices.length > 2 || !r.stopIndices.every(position))) return false;
        if (r.parityIndex != null && !position(r.parityIndex)) return false;
        if (r.transactionRef && (typeof r.transactionRef !== "object" || !["OK","OPEN","UNSYNC","ERROR","UNSUPPORTED","INCOMPLETE"].includes(r.transactionRef.status))) return false;
        return true;
      })) throw Error("Decoder records không hợp lệ");
    }
    return { ...input, sampleOrigin: origin, triggerIndex: trigger, channels, order, decoders,
      mode: input.version === 1 ? "CAPTURE" : input.mode, gaps: input.gaps || [] };
  }
  function vcd(samples, rate, channels, origin = 0) {
    const rows = ["$timescale 1 ns $end", "$scope module logic_analyzer $end"];
    channels.forEach((c, i) => rows.push("$var wire 1 " + String.fromCharCode(33 + i) + " " + (c.name || "D" + i).replace(/[^a-zA-Z0-9_]/g, "_") + "_D" + i + " $end"));
    rows.push("$upscope $end", "$enddefinitions $end");
    for (let k = 0; k < samples.length; k++) {
      if (k && samples[k] === samples[k - 1]) continue;
      rows.push("#" + Math.round((origin + k) * 1e9 / rate));
      for (let i = 0; i < 8; i++) if (!k || bit(samples[k], i) !== bit(samples[k - 1], i)) rows.push(bit(samples[k], i) + String.fromCharCode(33 + i));
    }
    return rows.join("\n") + "\n";
  }
  const api = { DEFAULTS, Decoder, decode, Ring, validate, measure, statistics, bins, validateSession, vcd };
  root.LA = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
