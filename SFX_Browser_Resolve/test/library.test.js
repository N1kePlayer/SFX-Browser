'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const library = require('../lib/library');

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfxl-'));
  fs.mkdirSync(path.join(root, 'Whooshes'));
  fs.mkdirSync(path.join(root, 'Impacts', 'Heavy'), { recursive: true });
  for (const f of ['Whooshes/Whoosh 10.wav', 'Whooshes/Whoosh 2.wav', 'Impacts/Heavy/Boom Big.aiff', 'Impacts/readme.txt', 'Impacts/.hidden.wav', 'click.mp3']) {
    fs.writeFileSync(path.join(root, f), 'x');
  }
  return root;
}

test('lists folders first, audio only, natural order', async () => {
  const root = tree();
  const items = await library.listDir(root, []);
  assert.deepStrictEqual(items.map((x) => x.name), ['Impacts', 'Whooshes', 'click.mp3']);
  const wh = await library.listDir(path.join(root, 'Whooshes'), []);
  assert.deepStrictEqual(wh.map((x) => x.name), ['Whoosh 2.wav', 'Whoosh 10.wav']);
  const imp = await library.listDir(path.join(root, 'Impacts'), [path.join(root, 'Impacts', 'Heavy')]);
  assert.deepStrictEqual(imp, []);
});

test('search matches all words recursively and skips hidden folders', async () => {
  const root = tree();
  let r = await library.search([root], 'big boom', []);
  assert.deepStrictEqual(r.results.map((x) => x.name), ['Boom Big.aiff']);
  r = await library.search([root], 'boom', [path.join(root, 'Impacts')]);
  assert.strictEqual(r.results.length, 0);
});

test('readFile refuses non-audio files', async () => {
  const root = tree();
  await assert.rejects(library.readFile(path.join(root, 'Impacts', 'readme.txt')));
});

test('store round-trips state', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sfxs-')), 'sub', 'state.json');
  const s = library.createStore(file);
  s.save({ roots: ['/a'] });
  s.flush();
  assert.deepStrictEqual(library.createStore(file).load(), { roots: ['/a'] });
});

// Decoders live in the renderer script; load it with a stub window.
function decoders() {
  const sandbox = { window: {}, Math, Float32Array, DataView, String, Error };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'audio.js'), 'utf8'), sandbox);
  return sandbox.window.SFXAudio;
}

function wav(bits, tag, samples, channels) {
  const bytes = bits / 8, data = Buffer.alloc(samples.length * bytes);
  samples.forEach((v, i) => {
    if (tag === 3) data.writeFloatLE(v, i * 4);
    else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), i * 2);
    else if (bits === 24) data.writeIntLE(Math.round(v * 8388607), i * 3, 3);
  });
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(tag, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(48000, 24); h.writeUInt32LE(48000 * bytes * channels, 28); h.writeUInt16LE(bytes * channels, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const b = Buffer.concat([h, data]);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

test('WAV decoder: 16/24-bit PCM and float, interleaved stereo', () => {
  const A = decoders();
  let d = A.decodeWav(wav(16, 1, [0.5, -0.5, 0.25, -0.25], 2));
  assert.strictEqual(d.sampleRate, 48000);
  assert.strictEqual(d.channels.length, 2);
  assert.ok(Math.abs(d.channels[0][1] - 0.25) < 1e-3);
  assert.ok(Math.abs(d.channels[1][0] + 0.5) < 1e-3);
  d = A.decodeWav(wav(24, 1, [0.75, -1], 1));
  assert.ok(Math.abs(d.channels[0][0] - 0.75) < 1e-5);
  d = A.decodeWav(wav(32, 3, [0.125], 1));
  assert.strictEqual(d.channels[0][0], 0.125);
  assert.strictEqual(d.codec, 'Float');
});

function ext80(rate) {
  const b = Buffer.alloc(10);
  const exp = Math.floor(Math.log2(rate));
  b.writeUInt16BE(16383 + exp, 0);
  const mant = rate / Math.pow(2, exp) * Math.pow(2, 31);
  b.writeUInt32BE(Math.floor(mant), 2);
  return b;
}

test('AIFF decoder: big-endian 16-bit and AIFC sowt', () => {
  const A = decoders();
  function aiff(kind, comp, samples, little) {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => (little ? data.writeInt16LE(v, i * 2) : data.writeInt16BE(v, i * 2)));
    const commBody = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(4), Buffer.from([0, 16]), ext80(44100), comp ? Buffer.concat([Buffer.from(comp), Buffer.from([0, 0])]) : Buffer.alloc(0)]);
    commBody.writeUInt32BE(samples.length, 2);
    const comm = Buffer.concat([Buffer.from('COMM'), Buffer.alloc(4), commBody]); comm.writeUInt32BE(commBody.length, 4);
    const ssndBody = Buffer.concat([Buffer.alloc(8), data]);
    const ssnd = Buffer.concat([Buffer.from('SSND'), Buffer.alloc(4), ssndBody]); ssnd.writeUInt32BE(ssndBody.length, 4);
    const form = Buffer.concat([Buffer.from('FORM'), Buffer.alloc(4), Buffer.from(kind), comm, ssnd]);
    form.writeUInt32BE(form.length - 8, 4);
    return form.buffer.slice(form.byteOffset, form.byteOffset + form.byteLength);
  }
  let d = A.decodeAiff(aiff('AIFF', null, [16384, -32768]));
  assert.strictEqual(d.sampleRate, 44100);
  assert.strictEqual(d.channels[0][0], 0.5);
  assert.strictEqual(d.channels[0][1], -1);
  d = A.decodeAiff(aiff('AIFC', 'sowt', [16384], true));
  assert.strictEqual(d.channels[0][0], 0.5);
});
