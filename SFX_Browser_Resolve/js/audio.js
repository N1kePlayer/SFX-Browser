/* Audio decoding, peaks and preview playback. No external decoders are needed:
   WAV and AIFF are parsed here (Chromium cannot decode AIFF or A-law/µ-law WAV),
   everything else goes through Web Audio's decodeAudioData. */
(function () {
  'use strict';

  function fourCC(v, o) {
    return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  }
  function muLaw(x) { x = ~x & 255; let t = ((x & 15) << 3) + 132; t <<= (x & 112) >> 4; return ((x & 128) ? 132 - t : t - 132) / 32768; }
  function aLaw(x) {
    x ^= 0x55; let t = (x & 15) << 4; const seg = (x & 112) >> 4;
    if (seg === 0) t += 8; else if (seg === 1) t += 0x108; else { t += 0x108; t <<= seg - 1; }
    return ((x & 128) ? t : -t) / 32768;
  }
  function clamp(x) { return x > 1 ? 1 : (x < -1 ? -1 : x); }

  // Reads one sample of an integer/float PCM stream.
  function sampleReader(v, bits, isFloat, little) {
    if (isFloat) {
      if (bits === 32) return (p) => v.getFloat32(p, little);
      if (bits === 64) return (p) => v.getFloat64(p, little);
      throw new Error('Unsupported float depth ' + bits);
    }
    if (bits === 8) return little ? (p) => (v.getUint8(p) - 128) / 128 : (p) => v.getInt8(p) / 128;
    if (bits === 16) return (p) => v.getInt16(p, little) / 32768;
    if (bits === 24) {
      return little
        ? (p) => { let n = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16); if (n & 0x800000) n |= 0xff000000; return n / 8388608; }
        : (p) => { let n = (v.getUint8(p) << 16) | (v.getUint8(p + 1) << 8) | v.getUint8(p + 2); if (n & 0x800000) n |= 0xff000000; return n / 8388608; };
    }
    if (bits === 32) return (p) => v.getInt32(p, little) / 2147483648;
    throw new Error('Unsupported PCM depth ' + bits);
  }

  function deinterleave(v, dataOff, frames, channels, blockAlign, bytes, read) {
    const out = [];
    for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
    const limit = v.byteLength - bytes;
    for (let i = 0; i < frames; i++) {
      const base = dataOff + i * blockAlign;
      for (let c = 0; c < channels; c++) {
        const p = base + c * bytes;
        out[c][i] = p > limit ? 0 : clamp(read(p));
      }
    }
    return out;
  }

  function decodeWav(ab) {
    const v = new DataView(ab);
    if (v.byteLength < 12 || fourCC(v, 0) !== 'RIFF' || fourCC(v, 8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
    let off = 12, fmt = null, dataOff = -1, dataSize = 0;
    while (off + 8 <= v.byteLength) {
      const id = fourCC(v, off), size = v.getUint32(off + 4, true), body = off + 8;
      if (id === 'fmt ') fmt = { off: body, size };
      else if (id === 'data') { dataOff = body; dataSize = Math.min(size, v.byteLength - body); }
      off = body + size + (size & 1);
    }
    if (!fmt || dataOff < 0) throw new Error('WAV has no fmt/data chunk');
    const fo = fmt.off;
    let tag = v.getUint16(fo, true);
    const channels = v.getUint16(fo + 2, true), rate = v.getUint32(fo + 4, true);
    const blockAlign = v.getUint16(fo + 12, true), bits = v.getUint16(fo + 14, true);
    if (tag === 0xfffe && fmt.size >= 40) tag = v.getUint16(fo + 24, true);
    if (!channels || !rate || !blockAlign) throw new Error('Invalid WAV header');
    const frames = Math.floor(dataSize / blockAlign);
    let data;
    if (tag === 1 || tag === 3) {
      const bytes = bits >> 3;
      data = deinterleave(v, dataOff, frames, channels, blockAlign, bytes, sampleReader(v, bits, tag === 3, true));
    } else if (tag === 6 || tag === 7) {
      data = deinterleave(v, dataOff, frames, channels, blockAlign, 1, (p) => (tag === 6 ? aLaw : muLaw)(v.getUint8(p)));
    } else {
      throw new Error('Unsupported WAV codec 0x' + tag.toString(16));
    }
    const codec = { 1: 'PCM', 3: 'Float', 6: 'A-law', 7: 'µ-law' }[tag];
    return { sampleRate: rate, channels: data, bitDepth: bits, codec };
  }

  function readExtended(v, o) {
    const exp = ((v.getUint8(o) & 0x7f) << 8) | v.getUint8(o + 1);
    const hi = v.getUint32(o + 2), lo = v.getUint32(o + 6);
    if (!exp && !hi && !lo) return 0;
    const val = (hi * Math.pow(2, -31) + lo * Math.pow(2, -63)) * Math.pow(2, exp - 16383);
    return (v.getUint8(o) & 0x80) ? -val : val;
  }

  function decodeAiff(ab) {
    const v = new DataView(ab);
    if (v.byteLength < 12 || fourCC(v, 0) !== 'FORM') throw new Error('Not an AIFF file');
    const kind = fourCC(v, 8);
    if (kind !== 'AIFF' && kind !== 'AIFC') throw new Error('Not an AIFF file');
    let off = 12, comm = null, ssnd = -1, ssndSize = 0;
    while (off + 8 <= v.byteLength) {
      const id = fourCC(v, off), size = v.getUint32(off + 4), body = off + 8;
      if (id === 'COMM') {
        comm = { channels: v.getUint16(body), frames: v.getUint32(body + 2), bits: v.getUint16(body + 6), rate: readExtended(v, body + 8), comp: 'NONE' };
        if (kind === 'AIFC' && size >= 22) comm.comp = fourCC(v, body + 18);
      } else if (id === 'SSND') {
        const dataOffset = v.getUint32(body);
        ssnd = body + 8 + dataOffset;
        ssndSize = Math.min(size - 8 - dataOffset, v.byteLength - ssnd);
      }
      off = body + size + (size & 1);
    }
    if (!comm || ssnd < 0) throw new Error('AIFF has no COMM/SSND chunk');
    const comp = comm.comp.toLowerCase();
    let isFloat = false, little = false, bits = comm.bits;
    if (comp === 'sowt') little = true;
    else if (comp === 'fl32') { isFloat = true; bits = 32; }
    else if (comp === 'fl64') { isFloat = true; bits = 64; }
    else if (comp !== 'none' && comp !== 'twos') throw new Error('Unsupported AIFF-C codec ' + comm.comp);
    const bytes = Math.ceil(bits / 8), blockAlign = bytes * comm.channels;
    const frames = Math.min(comm.frames, Math.floor(ssndSize / blockAlign));
    // AIFF stores <16-bit samples left-aligned in signed bytes, so 8-bit reads as signed.
    const data = deinterleave(v, ssnd, frames, comm.channels, blockAlign, bytes, sampleReader(v, bytes * 8, isFloat, little));
    return { sampleRate: Math.round(comm.rate), channels: data, bitDepth: bits, codec: isFloat ? 'Float' : 'PCM' };
  }

  let ctx = null;
  function context() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }

  function toAudioBuffer(d) {
    const buf = context().createBuffer(d.channels.length, Math.max(1, d.channels[0].length), d.sampleRate);
    d.channels.forEach((ch, i) => buf.copyToChannel(ch, i));
    return buf;
  }

  // bytes: Uint8Array of the file. Resolves to { buffer: AudioBuffer, bitDepth, codec }.
  async function decode(bytes, ext) {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    ext = (ext || '').toLowerCase();
    let parsed = null;
    try {
      if (ext === 'wav') parsed = decodeWav(ab);
      else if (ext === 'aif' || ext === 'aiff') parsed = decodeAiff(ab);
    } catch (e) {
      if (ext !== 'wav') throw e; // Compressed WAVs (e.g. ADPCM) may still decode below.
    }
    if (parsed) return { buffer: toAudioBuffer(parsed), bitDepth: parsed.bitDepth, codec: parsed.codec };
    const buffer = await context().decodeAudioData(ab.slice(0));
    return { buffer, bitDepth: 0, codec: '' };
  }

  // Min/max peaks per bucket across all channels, normalised so quiet sounds stay readable.
  function peaks(buffer, buckets) {
    const n = buffer.length, chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    const out = new Float32Array(buckets * 2);
    const step = n / buckets;
    let top = 0;
    for (let b = 0; b < buckets; b++) {
      const s = Math.floor(b * step), e = Math.max(s + 1, Math.floor((b + 1) * step));
      let min = 0, max = 0;
      for (const ch of chans) {
        for (let i = s; i < e && i < n; i++) { const x = ch[i]; if (x < min) min = x; if (x > max) max = x; }
      }
      out[b * 2] = min; out[b * 2 + 1] = max;
      top = Math.max(top, -min, max);
    }
    out.peak = top;
    return out;
  }

  // Single-voice preview player built on AudioBufferSourceNode.
  function createPlayer(onState) {
    let source = null, gain = null, buffer = null, startedAt = 0, offset = 0, playing = false, volume = 0.85;
    function emit() { if (onState) onState({ playing }); }
    function stopSource() {
      if (!source) return;
      source.onended = null;
      try { source.stop(0); } catch (e) { /* already stopped */ }
      try { source.disconnect(); } catch (e) { /* noop */ }
      source = null;
    }
    function play(buf, at) {
      const c = context();
      if (c.state === 'suspended') c.resume();
      stopSource();
      buffer = buf || buffer;
      if (!buffer) return;
      if (!gain) { gain = c.createGain(); gain.connect(c.destination); }
      gain.gain.value = volume;
      offset = Math.max(0, Math.min(at || 0, buffer.duration - 0.001));
      source = c.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.onended = () => { source = null; playing = false; offset = buffer ? buffer.duration : 0; emit(); };
      startedAt = c.currentTime - offset;
      source.start(0, offset);
      playing = true;
      emit();
    }
    function stop() { stopSource(); playing = false; offset = 0; emit(); }
    function position() {
      if (!buffer) return 0;
      return playing ? Math.min(buffer.duration, context().currentTime - startedAt) : offset;
    }
    function setVolume(v) { volume = v; if (gain) gain.gain.value = v; }
    function clear() { stop(); buffer = null; }
    return {
      play, stop, clear, position, setVolume,
      get playing() { return playing; },
      get buffer() { return buffer; }
    };
  }

  window.SFXAudio = { decode, peaks, createPlayer, decodeWav, decodeAiff };
})();
