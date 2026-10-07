'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBridge, timecodeToFrames } = require('../lib/resolve');

test('timecode → frames', () => {
  assert.strictEqual(timecodeToFrames('01:00:00:00', 24, false), 86400);
  assert.strictEqual(timecodeToFrames('01:00:01:12', 25, false), 90037);
  assert.strictEqual(timecodeToFrames('00:00:10:00', 23.976, false), 240);
  // 29.97 DF: 00:01:00;02 is frame 1800.
  assert.strictEqual(timecodeToFrames('00:01:00;02', 29.97, true), 1800);
  assert.strictEqual(timecodeToFrames('00:10:00;00', 29.97, true), 17982);
  assert.ok(isNaN(timecodeToFrames('garbage', 24, false)));
});

// Minimal fake of the Resolve object model, async like Resolve 20.1+.
function fakeResolve(opts) {
  const tracks = opts.tracks.map((items) => items.map(([s, e]) => ({ GetStart: async () => s, GetEnd: async () => e })));
  const locked = opts.locked || [];
  const calls = { append: [], import: [], addTrack: 0 };
  const clip = { GetClipProperty: async (k) => ({ 'File Path': opts.file, Frames: '48', FPS: '24' })[k] };
  const bin = { GetName: async () => 'SFX Browser', GetClipList: async () => (calls.import.length ? [clip] : []) };
  const root = { GetSubFolderList: async () => (opts.hasBin ? [bin] : []) };
  const mediaPool = {
    GetRootFolder: async () => root,
    AddSubFolder: async () => bin,
    GetCurrentFolder: async () => root,
    SetCurrentFolder: async () => true,
    ImportMedia: async (paths) => { calls.import.push(paths); return [clip]; },
    AppendToTimeline: async (info) => {
      calls.append.push(info[0]);
      if (opts.rejectTracks && opts.rejectTracks.includes(info[0].trackIndex)) return [];
      const it = { GetStart: async () => info[0].recordFrame, GetEnd: async () => info[0].recordFrame + 48 };
      tracks[info[0].trackIndex - 1].push(it);
      return [it];
    }
  };
  const timeline = {
    GetName: async () => 'Timeline 1',
    GetSetting: async (k) => ({ timelineFrameRate: '24', timelineDropFrameTimecode: '0' })[k],
    GetCurrentTimecode: async () => opts.tc || '01:00:00:00',
    SetCurrentTimecode: async () => true,
    GetTrackCount: async () => tracks.length,
    GetIsTrackLocked: async (_t, i) => locked.includes(i),
    GetItemListInTrack: async (_t, i) => tracks[i - 1],
    AddTrack: async () => { calls.addTrack++; tracks.push([]); return true; }
  };
  const project = { GetName: async () => 'P', GetCurrentTimeline: async () => timeline, GetMediaPool: async () => mediaPool, GetSetting: async () => '24' };
  const resolve = { GetProjectManager: async () => ({ GetCurrentProject: async () => project }) };
  return { resolve, calls, tracks };
}

function bridgeFor(fake) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfxr-'));
  fs.writeFileSync(path.join(dir, 'WorkflowIntegration.node'), '');
  const mod = { Initialize: () => true, GetResolve: () => fake.resolve, CleanUp: () => true };
  return createBridge('test', dir, () => mod);
}

function tmpAudio() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sfxa-')), 'boom.wav');
  fs.writeFileSync(p, 'x');
  return p;
}

test('adds to the lowest free audio track at the playhead', async () => {
  const file = tmpAudio();
  // A1 free, A2 free, A3 busy at the playhead (86400).
  const fake = fakeResolve({ file, tracks: [[], [], [[86390, 86410]]] });
  const r = await bridgeFor(fake).insert(file, { durationSec: 2 });
  assert.ok(r.ok, r.message);
  assert.strictEqual(r.track, 2);
  const info = fake.calls.append[0];
  assert.strictEqual(info.recordFrame, 86400);
  assert.strictEqual(info.mediaType, 2);
  assert.strictEqual(info.endFrame, 47);
  assert.strictEqual(fake.calls.import.length, 1);
});

test('skips locked tracks and tracks busy anywhere in the sound’s range', async () => {
  const file = tmpAudio();
  // A3 locked, A2 has a clip starting 1s after the playhead (2s sound overlaps).
  const fake = fakeResolve({ file, tracks: [[], [[86424, 86500]], []], locked: [3] });
  const r = await bridgeFor(fake).insert(file, { durationSec: 2 });
  assert.ok(r.ok, r.message);
  assert.strictEqual(r.track, 1);
});

test('creates a new track when nothing is free', async () => {
  const file = tmpAudio();
  const fake = fakeResolve({ file, tracks: [[[0, 999999]]] });
  const r = await bridgeFor(fake).insert(file, { durationSec: 1, channels: 1 });
  assert.ok(r.ok, r.message);
  assert.strictEqual(fake.calls.addTrack, 1);
  assert.strictEqual(r.track, 2);
});

test('does not retry on another track once Resolve placed a clip', async () => {
  const file = tmpAudio();
  const fake = fakeResolve({ file, tracks: [[], [], []], rejectTracks: [3] });
  const r = await bridgeFor(fake).insert(file, { durationSec: 1 });
  assert.ok(r.ok);
  assert.strictEqual(r.track, 2);
  assert.strictEqual(fake.calls.append.length, 2);
});

test('reuses a clip already in the SFX Browser bin', async () => {
  const file = tmpAudio();
  const fake = fakeResolve({ file, tracks: [[]], hasBin: true });
  fake.calls.import.push(['earlier']);
  await bridgeFor(fake).insert(file, {});
  assert.strictEqual(fake.calls.import.length, 1);
});

test('reports a missing timeline', async () => {
  const file = tmpAudio();
  const fake = fakeResolve({ file, tracks: [[]] });
  const resolve = { GetProjectManager: async () => ({ GetCurrentProject: async () => ({ GetCurrentTimeline: async () => null }) }) };
  fake.resolve = resolve;
  const r = await bridgeFor(fake).insert(file, {});
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /timeline/i);
});
