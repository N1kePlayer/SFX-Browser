'use strict';

// DaVinci Resolve bridge. Runs in the Electron main process.
// Every API call is awaited: Resolve 20.1+ returns promises, older builds return
// plain values, and `await` handles both.

const fs = require('fs');
const path = require('path');

const BIN_NAME = 'SFX Browser';

// WorkflowIntegration.node is Blackmagic's native module. It is looked up next to the
// plugin first, then in the Developer folder that every Resolve Studio install ships with.
function moduleCandidates(pluginDir) {
  const list = [path.join(pluginDir, 'WorkflowIntegration.node')];
  const sample = ['Workflow Integrations', 'Examples', 'SamplePlugin', 'WorkflowIntegration.node'];
  if (process.platform === 'darwin') {
    list.push(path.join('/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer', ...sample));
  } else if (process.platform === 'win32') {
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
    list.push(path.join(programData, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Developer', ...sample));
  }
  return list;
}

function createBridge(pluginId, pluginDir, loader) {
  let wi = null;
  let resolveObj = null;
  const load = loader || ((p) => require(p));

  async function getResolve() {
    if (resolveObj) return resolveObj;
    if (!wi) {
      const found = moduleCandidates(pluginDir).find((p) => fs.existsSync(p));
      if (!found) throw new Error('WorkflowIntegration.node not found. Copy it into the plugin folder (see README).');
      const mod = load(found);
      const ok = mod.InitializePromise ? await mod.InitializePromise(pluginId) : await mod.Initialize(pluginId);
      if (!ok) throw new Error('Resolve rejected the Workflow Integration connection.');
      wi = mod;
    }
    resolveObj = wi.GetResolvePromise ? await wi.GetResolvePromise() : await wi.GetResolve();
    if (!resolveObj) throw new Error('Resolve is not available.');
    return resolveObj;
  }

  async function cleanUp() {
    if (!wi) return;
    try { await wi.CleanUp(); } catch (e) { /* Resolve may already be closing. */ }
    wi = null;
    resolveObj = null;
  }

  async function context() {
    const resolve = await getResolve();
    const pm = await resolve.GetProjectManager();
    const project = pm && await pm.GetCurrentProject();
    const timeline = project && await project.GetCurrentTimeline();
    return { resolve, project, timeline };
  }

  async function status() {
    try {
      const { project, timeline } = await context();
      return {
        connected: true,
        project: project ? String(await project.GetName()) : '',
        timeline: timeline ? String(await timeline.GetName()) : ''
      };
    } catch (e) {
      resolveObj = null;
      return { connected: false, error: e.message };
    }
  }

  async function insert(filePath, opts) {
    opts = opts || {};
    const { project, timeline } = await context();
    if (!project) return fail('Open a project in DaVinci Resolve');
    if (!timeline) return fail('Open a timeline in DaVinci Resolve');
    if (!fs.existsSync(filePath)) return fail('File not found on disk');
    const mediaPool = await project.GetMediaPool();

    const item = await findOrImport(mediaPool, filePath);
    if (!item) return fail('Resolve could not import this file');

    const fps = await timelineFps(project, timeline);
    const dropFrame = String(await safe(() => timeline.GetSetting('timelineDropFrameTimecode'))) === '1';
    const tc = String(await timeline.GetCurrentTimecode());
    const playhead = timecodeToFrames(tc, fps, dropFrame);
    if (!isFinite(playhead)) return fail('Could not read the playhead position (' + tc + ')');

    // Source range is in the clip's own frame units; the timeline footprint is in timeline frames.
    const clipFps = parseFloat(await safe(() => item.GetClipProperty('FPS'))) || fps;
    let clipFrames = parseInt(await safe(() => item.GetClipProperty('Frames')), 10);
    const seconds = Number(opts.durationSec) > 0 ? Number(opts.durationSec) : (clipFrames > 0 ? clipFrames / clipFps : 0);
    if (!(clipFrames > 0)) clipFrames = Math.max(1, Math.ceil(seconds * clipFps));
    const footprint = Math.max(1, Math.ceil(seconds * fps));

    const clipInfo = (trackIndex) => [{
      mediaPoolItem: item,
      startFrame: 0,
      endFrame: clipFrames - 1,
      mediaType: 2,
      trackIndex,
      recordFrame: playhead
    }];

    const trackCount = Number(await timeline.GetTrackCount('audio')) || 0;
    const tried = [];
    // Highest index is the visually lowest audio track in Resolve (A1 sits at the top).
    for (let idx = trackCount; idx >= 1; idx--) {
      if (!(await trackIsUsable(timeline, idx, playhead, playhead + footprint))) continue;
      const start = await append(mediaPool, clipInfo(idx));
      if (start !== null) {
        await restorePlayhead(timeline, tc);
        return { ok: true, message: placedMessage(idx, start, playhead, tc), track: idx };
      }
      tried.push('A' + idx);
    }

    // No existing track is free for the whole sound: create a new one at the bottom.
    const channels = Number(opts.channels) || 2;
    const added = await safe(() => timeline.AddTrack('audio', channels === 1 ? 'mono' : 'stereo'));
    if (added) {
      const idx = Number(await timeline.GetTrackCount('audio')) || trackCount + 1;
      const start = await append(mediaPool, clipInfo(idx));
      if (start !== null) {
        await restorePlayhead(timeline, tc);
        return { ok: true, message: placedMessage(idx, start, playhead, tc, ' (new track)'), track: idx };
      }
      tried.push('A' + idx + ' (new)');
    }
    return fail(tried.length ? 'Resolve did not place the clip (tried ' + tried.join(', ') + ')' : 'No free audio track at the playhead');
  }

  return { getResolve, cleanUp, status, insert };
}

function fail(message) { return { ok: false, message }; }

async function safe(fn) {
  try { return await fn(); } catch (e) { return null; }
}

// Native arrays may arrive as JS arrays or as index-keyed objects depending on the Resolve build.
function toArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return Object.keys(v).sort((a, b) => a - b).map((k) => v[k]);
  return [];
}

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}

async function timelineFps(project, timeline) {
  const raw = (await safe(() => timeline.GetSetting('timelineFrameRate'))) || (await safe(() => project.GetSetting('timelineFrameRate')));
  const fps = parseFloat(raw);
  return fps > 0 ? fps : 24;
}

// Timecode → absolute frame number, the same unit Resolve uses for GetStartFrame and recordFrame.
function timecodeToFrames(tc, fps, dropFrame) {
  const m = /^(\d+)[:;.](\d+)[:;.](\d+)[:;.](\d+)$/.exec(String(tc).trim());
  if (!m) return NaN;
  const h = +m[1], mi = +m[2], s = +m[3], f = +m[4];
  const nominal = Math.round(fps);
  let frames = ((h * 60 + mi) * 60 + s) * nominal + f;
  const isDrop = (dropFrame || String(tc).indexOf(';') >= 0) && Math.abs(fps - nominal) > 0.001;
  if (isDrop) {
    const drop = Math.round(nominal / 15); // 2 for 29.97, 4 for 59.94
    const totalMinutes = h * 60 + mi;
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

async function trackIsUsable(timeline, idx, start, end) {
  if (await safe(() => timeline.GetIsTrackLocked('audio', idx))) return false;
  const items = toArray(await safe(() => timeline.GetItemListInTrack('audio', idx)));
  for (const it of items) {
    const s = Number(await safe(() => it.GetStart()));
    const e = Number(await safe(() => it.GetEnd()));
    if (!isFinite(s) || !isFinite(e)) continue;
    if (s < end && e > start) return false;
  }
  return true;
}

// Returns the placed TimelineItem's start frame, or null when Resolve placed nothing.
// A returned item counts as placed: retrying on another track would duplicate the clip.
async function append(mediaPool, info) {
  const result = toArray(await safe(() => mediaPool.AppendToTimeline(info)));
  if (!result.length || !result[0]) return null;
  const start = Number(await safe(() => result[0].GetStart()));
  return isFinite(start) ? start : info[0].recordFrame;
}

function placedMessage(idx, start, playhead, tc, extra) {
  const where = Math.abs(start - playhead) <= 1 ? tc : 'frame ' + start + ' (Resolve moved it from the playhead)';
  return 'Added · A' + idx + (extra || '') + ' · ' + where;
}

async function restorePlayhead(timeline, tc) {
  await safe(() => timeline.SetCurrentTimecode(tc));
}

async function findInFolder(folder, wanted) {
  for (const clip of toArray(await safe(() => folder.GetClipList()))) {
    const p = await safe(() => clip.GetClipProperty('File Path'));
    if (p && normPath(p) === wanted) return clip;
  }
  return null;
}

// Imports into a dedicated "SFX Browser" bin and reuses the clip if it is already there.
async function findOrImport(mediaPool, filePath) {
  const wanted = normPath(filePath);
  const root = await mediaPool.GetRootFolder();
  let bin = null;
  for (const f of toArray(await safe(() => root.GetSubFolderList()))) {
    if (String(await safe(() => f.GetName())) === BIN_NAME) { bin = f; break; }
  }
  if (bin) {
    const existing = await findInFolder(bin, wanted);
    if (existing) return existing;
  } else {
    bin = await safe(() => mediaPool.AddSubFolder(root, BIN_NAME));
  }

  const previous = await safe(() => mediaPool.GetCurrentFolder());
  if (bin) await safe(() => mediaPool.SetCurrentFolder(bin));
  const imported = toArray(await safe(() => mediaPool.ImportMedia([filePath])));
  if (previous) await safe(() => mediaPool.SetCurrentFolder(previous));
  if (imported.length && imported[0]) return imported[0];
  return bin ? findInFolder(bin, wanted) : null;
}

module.exports = { createBridge, timecodeToFrames, toArray, moduleCandidates, BIN_NAME };
