'use strict';

// File-system side of the browser. Runs in the Electron main process so the
// renderer can stay sandboxed.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const AUDIO_EXTS = new Set(['.wav', '.mp3', '.aif', '.aiff', '.m4a', '.aac', '.flac', '.ogg']);

function isAudio(name) {
  return AUDIO_EXTS.has(path.extname(name).toLowerCase());
}

function byFolderThenName(a, b) {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

async function listDir(dir, hidden) {
  const skip = new Set(hidden || []);
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const ent of entries) {
    if (ent.name[0] === '.') continue;
    const p = path.join(dir, ent.name);
    if (skip.has(p)) continue;
    let isDir = ent.isDirectory();
    if (ent.isSymbolicLink()) {
      try { isDir = (await fsp.stat(p)).isDirectory(); } catch (e) { continue; }
    }
    if (isDir || isAudio(ent.name)) out.push({ name: ent.name, path: p, dir: isDir });
  }
  return out.sort(byFolderThenName);
}

// Recursive name search across the given roots. Words must all match, in any order.
async function search(roots, query, hidden, limit) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { results: [], truncated: false };
  const skip = new Set(hidden || []);
  const max = limit || 500;
  const results = [];
  const queue = roots.filter((r) => !skip.has(r));
  let scanned = 0;
  while (queue.length && results.length < max && scanned < 200000) {
    const dir = queue.shift();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      scanned++;
      if (ent.name[0] === '.') continue;
      const p = path.join(dir, ent.name);
      if (skip.has(p)) continue;
      if (ent.isDirectory()) { queue.push(p); continue; }
      if (!isAudio(ent.name)) continue;
      const lower = ent.name.toLowerCase();
      if (words.every((w) => lower.indexOf(w) >= 0)) {
        results.push({ name: ent.name, path: p, dir: false, parent: dir });
        if (results.length >= max) break;
      }
    }
  }
  results.sort(byFolderThenName);
  return { results, truncated: results.length >= max };
}

async function stat(p) {
  try {
    const st = await fsp.stat(p);
    return { size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() };
  } catch (e) { return null; }
}

async function readFile(p) {
  if (!isAudio(p)) throw new Error('Not an audio file');
  const buf = await fsp.readFile(p);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function existsMany(paths) {
  return (paths || []).filter((p) => fs.existsSync(p));
}

function createStore(file) {
  let cache = null;
  let timer = null;
  function load() {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { cache = {}; }
    if (!cache || typeof cache !== 'object') cache = {};
    return cache;
  }
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!cache) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) { /* keep running; state stays in memory */ }
  }
  function save(next) {
    cache = next && typeof next === 'object' ? next : {};
    clearTimeout(timer);
    timer = setTimeout(flush, 300);
  }
  return { load, save, flush, file };
}

module.exports = { AUDIO_EXTS, isAudio, listDir, search, stat, readFile, existsMany, createStore };
