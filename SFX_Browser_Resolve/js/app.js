(function () {
  'use strict';

  const api = window.sfx;
  const A = window.SFXAudio;
  const $ = (id) => document.getElementById(id);

  if (!api) {
    document.body.innerHTML = '<p style="padding:24px;color:#aaa">SFX Browser must be opened from DaVinci Resolve → Workspace → Workflow Integrations.</p>';
    return;
  }

  // ── Elements ─────────────────────────────────────────
  const listEl = $('list'), emptyEl = $('empty'), crumbEl = $('crumb');
  const searchEl = $('search'), searchBar = searchEl.parentElement;
  const statusEl = $('status');
  const inspector = $('inspector');
  const canvas = $('waveCanvas'), g = canvas.getContext('2d');
  const waveEl = $('wave'), waveMsg = $('waveMsg'), waveCursor = $('waveCursor'), waveHover = $('waveHover');
  const playBtn = $('playBtn'), addBtn = $('addBtn'), favBtn = $('favBtn');
  const volumeEl = $('volume'), volumeValue = $('volumeValue'), autoplayEl = $('autoplay');
  const notesEl = $('notes');
  const menuEl = $('menu'), hiddenPanel = $('hiddenPanel'), toastEl = $('toast');

  // ── State ────────────────────────────────────────────
  const DEFAULTS = { roots: [], hidden: [], favorites: [], expanded: [], notes: {}, volume: 85, autoplay: true, inspectorWidth: 360, view: 'library' };
  let state = Object.assign({}, DEFAULTS);
  let view = 'library';
  let query = '';
  let selected = null;     // { path, wrap }
  let cursorWrap = null;   // keyboard cursor (folder or file node)
  let current = null;      // decoded preview { path, buffer, peaks, bitDepth, codec }
  let previewToken = 0;
  let searchToken = 0;
  let rafId = 0;
  const cache = new Map(); // path → decoded preview, small LRU

  function persist() { api.saveState(state); }
  function arr(v) { return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []; }

  // ── Path helpers (both separators, since Windows paths can mix them) ──
  function basename(p) { const parts = String(p).split(/[\\/]/).filter(Boolean); return parts.length ? parts[parts.length - 1] : String(p); }
  function extname(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; }
  function stem(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b; }
  function dirname(p) { const s = String(p); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i > 0 ? s.slice(0, i) : s; }
  function isUnder(p, dir) { return p === dir || p.indexOf(dir + '/') === 0 || p.indexOf(dir + '\\') === 0; }
  function relParent(p) {
    const parent = dirname(p);
    const root = state.roots.find((r) => isUnder(parent, r));
    if (!root) return parent;
    const rel = parent.slice(root.length).replace(/^[\\/]/, '');
    return basename(root) + (rel ? ' / ' + rel.split(/[\\/]/).join(' / ') : '');
  }

  // ── Formatting ───────────────────────────────────────
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }
  function fmtBytes(n) {
    if (!isFinite(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n >= 10 ? 1 : 2) : Math.round(n)) + ' ' + u[i];
  }
  function chanLabel(n) { return n === 1 ? 'Mono' : n === 2 ? 'Stereo' : n + ' ch'; }

  function setStatus(text, isErr) { statusEl.textContent = text; statusEl.classList.toggle('err', !!isErr); }
  let toastTimer = 0;
  function toast(text, kind) {
    toastEl.textContent = text;
    toastEl.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast ' + (kind || ''); }, 2600);
  }

  function svg(id, cls) { return '<svg' + (cls ? ' class="' + cls + '"' : '') + '><use href="#' + id + '"/></svg>'; }
  const LRM = '\u200E';
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  // ── Favorites / hidden / expanded ─────────────────────
  const isFav = (p) => state.favorites.indexOf(p) >= 0;
  const isExpanded = (p) => state.expanded.indexOf(p) >= 0;
  function setExpanded(p, on) {
    state.expanded = state.expanded.filter((x) => x !== p);
    if (on) state.expanded.push(p);
    persist();
  }
  function toggleFav(p) {
    if (isFav(p)) state.favorites = state.favorites.filter((x) => x !== p);
    else state.favorites.push(p);
    persist();
    updateCounts();
    if (view === 'favorites' && !query) { render(); return; }
    document.querySelectorAll('.file').forEach((el) => { if (el.dataset.path === p) paintStar(el.querySelector('.rowStar'), isFav(p)); });
    if (selected && selected.path === p) paintStar(favBtn, isFav(p));
    setStatus((isFav(p) ? 'Added to favorites: ' : 'Removed from favorites: ') + stem(p));
  }
  function paintStar(btn, on) {
    if (!btn) return;
    btn.classList.toggle('on', on);
    btn.title = on ? 'Remove from favorites' : 'Add to favorites';
  }
  function hideItem(p) {
    if (state.hidden.indexOf(p) < 0) state.hidden.push(p);
    persist();
    if (selected && isUnder(selected.path, p)) clearSelection();
    render();
    updateCounts();
    setStatus('Hidden: ' + basename(p) + ' — restore it from the hidden list');
  }
  function restoreItem(p) {
    state.hidden = state.hidden.filter((x) => x !== p);
    persist();
    render();
    renderHidden();
    updateCounts();
    setStatus('Restored: ' + basename(p));
  }
  function removeRoot(p) {
    state.roots = state.roots.filter((r) => r !== p);
    state.expanded = state.expanded.filter((x) => !isUnder(x, p));
    persist();
    if (selected && isUnder(selected.path, p)) clearSelection();
    render();
    setStatus('Folder removed from the browser (files on disk are untouched)');
  }
  function updateCounts() {
    $('favCount').textContent = state.favorites.length || '';
    $('hiddenCount').textContent = state.hidden.length || '';
  }

  // ── Rendering ────────────────────────────────────────
  function fileNode(item, depth, showWhere) {
    const wrap = document.createElement('div');
    wrap.className = 'node file';
    wrap.dataset.path = item.path;
    const row = document.createElement('div');
    row.className = 'row';
    row.style.paddingLeft = (6 + depth * 16) + 'px';
    row.draggable = true;
    const fav = isFav(item.path);
    row.innerHTML =
      '<span class="caret"></span>' +
      '<span class="fmt">' + esc(extname(item.name).toUpperCase() || 'SFX') + '</span>' +
      '<span class="name">' + esc(stem(item.name)) + '</span>' +
      (showWhere ? '<span class="where" title="' + esc(dirname(item.path)) + '">' + LRM + esc(relParent(item.path)) + LRM + '</span>' : '') +
      (state.notes[item.path] ? '<span class="noteDot" title="Has a note">' + svg('i-note') + '</span>' : '') +
      '<button class="rowStar' + (fav ? ' on' : '') + '" title="' + (fav ? 'Remove from favorites' : 'Add to favorites') + '">' + svg('i-star') + '</button>';
    wrap.appendChild(row);
    if (selected && selected.path === item.path) { wrap.classList.add('selected'); selected.wrap = wrap; }
    if (current && current.path === item.path && player.playing) wrap.classList.add('playing');

    row.addEventListener('click', (e) => {
      if (e.target.closest('.rowStar')) return;
      select(item.path, wrap, autoplayEl.checked);
    });
    // Double-click only (re)plays. Adding to the timeline is always an explicit action.
    row.addEventListener('dblclick', (e) => { if (!e.target.closest('.rowStar')) select(item.path, wrap, true); });
    row.querySelector('.rowStar').addEventListener('click', (e) => { e.stopPropagation(); toggleFav(item.path); });
    row.addEventListener('dragstart', (e) => {
      e.preventDefault();
      select(item.path, wrap, false);
      api.startDrag(item.path);
      setStatus('Drag into the Resolve timeline or Media Pool: ' + stem(item.path));
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      select(item.path, wrap, false);
      fileMenu(e.clientX, e.clientY, item.path);
    });
    return wrap;
  }

  function folderNode(item, depth, isRoot) {
    const wrap = document.createElement('div');
    wrap.className = 'node folder' + (isRoot ? ' root' : '');
    wrap.dataset.path = item.path;
    const row = document.createElement('div');
    row.className = 'row';
    row.style.paddingLeft = (6 + depth * 16) + 'px';
    const children = document.createElement('div');
    children.className = 'children';
    wrap.appendChild(row);
    wrap.appendChild(children);
    let loaded = false;

    function paintIcon() {
      const icon = isRoot ? 'i-drive' : (wrap.classList.contains('open') ? 'i-folder-open' : 'i-folder');
      row.innerHTML =
        '<span class="caret">' + svg('i-chevron') + '</span>' + svg(icon, 'ico') +
        '<span class="name" title="' + esc(item.path) + '">' + esc(item.name) + '</span>' +
        (isRoot ? '<button class="rowRemove" title="Remove folder from browser">' + svg('i-close') + '</button>' : '');
      const rm = row.querySelector('.rowRemove');
      if (rm) rm.addEventListener('click', (e) => { e.stopPropagation(); removeRoot(item.path); });
    }
    async function load() {
      if (loaded) return;
      loaded = true;
      const items = await api.list(item.path, state.hidden);
      const frag = document.createDocumentFragment();
      items.forEach((x) => frag.appendChild(x.dir ? folderNode(x, depth + 1, false) : fileNode(x, depth + 1, false)));
      if (!items.length) {
        const none = document.createElement('div');
        none.className = 'row';
        none.style.cssText = 'padding-left:' + (28 + (depth + 1) * 16) + 'px;color:var(--faint);font-style:italic';
        none.textContent = 'No sounds';
        frag.appendChild(none);
      }
      children.appendChild(frag);
    }
    function setOpen(next) {
      wrap.classList.toggle('open', next);
      setExpanded(item.path, next);
      paintIcon();
      if (next) load();
    }
    wrap.toggle = (force) => setOpen(typeof force === 'boolean' ? force : !wrap.classList.contains('open'));

    if (isExpanded(item.path)) { wrap.classList.add('open'); load(); }
    paintIcon();
    row.addEventListener('click', (e) => {
      if (e.target.closest('.rowRemove')) return;
      cursorWrap = wrap;
      flashFolder(wrap);
      wrap.toggle();
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      folderMenu(e.clientX, e.clientY, item.path, isRoot, wrap);
    });
    return wrap;
  }

  function showEmpty(icon, title, text, withButton) {
    emptyEl.innerHTML =
      '<div class="big">' + svg(icon) + '</div><b>' + esc(title) + '</b><div>' + esc(text) + '</div>' +
      (withButton ? '<button class="btn" id="emptyAdd">' + svg('i-plus') + '<span>Add SFX folder</span></button>' : '');
    emptyEl.classList.add('show');
    const b = $('emptyAdd');
    if (b) b.addEventListener('click', addFolder);
  }

  async function render() {
    emptyEl.classList.remove('show');
    crumbEl.classList.remove('show');
    listEl.innerHTML = '';
    cursorWrap = null;
    document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));

    if (query) return renderSearch();

    if (view === 'favorites') {
      const valid = (await api.existing(state.favorites)).filter((p) => !state.hidden.some((h) => isUnder(p, h)));
      if (view !== 'favorites' || query) return;
      if (!valid.length) return showEmpty('i-star', 'No favorites yet', 'Hover a sound and click the star to keep it here.');
      valid.sort((a, b) => stem(a).localeCompare(stem(b), undefined, { numeric: true, sensitivity: 'base' }));
      const frag = document.createDocumentFragment();
      valid.forEach((p) => frag.appendChild(fileNode({ name: basename(p), path: p }, 0, true)));
      listEl.appendChild(frag);
      return;
    }

    const roots = state.roots.filter((r) => state.hidden.indexOf(r) < 0);
    if (!roots.length) return showEmpty('i-folder', 'Add your SFX library', 'Your folder names and structure stay exactly as they are on disk.', true);
    const frag = document.createDocumentFragment();
    roots.forEach((r) => frag.appendChild(folderNode({ name: basename(r) || r, path: r }, 0, true)));
    listEl.appendChild(frag);
  }

  async function renderSearch() {
    const token = ++searchToken;
    const scope = view === 'favorites' ? null : state.roots;
    let results, truncated = false;
    if (scope) {
      const r = await api.search(scope, query, state.hidden);
      results = r.results; truncated = r.truncated;
    } else {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      results = (await api.existing(state.favorites))
        .filter((p) => words.every((w) => basename(p).toLowerCase().indexOf(w) >= 0))
        .map((p) => ({ name: basename(p), path: p }));
    }
    if (token !== searchToken) return;
    listEl.innerHTML = '';
    crumbEl.innerHTML = '<span><b>' + results.length + (truncated ? '+' : '') + '</b> result' + (results.length === 1 ? '' : 's') + ' in ' + (scope ? 'library' : 'favorites') + '</span>';
    crumbEl.classList.add('show');
    if (!results.length) return showEmpty('i-search', 'Nothing found', 'No sound names match “' + query + '”.');
    const frag = document.createDocumentFragment();
    results.forEach((x) => frag.appendChild(fileNode(x, 0, true)));
    listEl.appendChild(frag);
  }

  // ── Selection & inspector ─────────────────────────────
  function setInfo(id, text) { $(id).textContent = text; }

  function clearSelection() {
    stopPreview();
    selected = null;
    current = null;
    document.querySelectorAll('.file.selected').forEach((x) => x.classList.remove('selected'));
    inspector.classList.add('disabled');
    setInfo('infoName', 'No sound selected');
    setInfo('infoSub', 'Pick a sound in the browser to preview it');
    ['infoFormat', 'infoDuration', 'infoRate', 'infoChannels', 'infoBits', 'infoSize', 'infoPath'].forEach((id) => setInfo(id, '—'));
    [playBtn, addBtn, favBtn, $('revealBtn'), $('copyBtn')].forEach((b) => { b.disabled = true; });
    paintStar(favBtn, false);
    notesEl.value = '';
    notesEl.disabled = true;
    waveMsg.textContent = 'No preview';
    waveMsg.style.display = 'flex';
    drawWave();
  }

  async function select(p, wrap, play) {
    const same = selected && selected.path === p;
    clearFolderCursor();
    document.querySelectorAll('.file.selected').forEach((x) => x.classList.remove('selected'));
    if (wrap) { wrap.classList.add('selected'); cursorWrap = wrap; scrollIntoView(wrap); }
    selected = { path: p, wrap };
    if (same && current && current.path === p) {
      if (play) playFrom(0);
      return;
    }

    inspector.classList.remove('disabled');
    [playBtn, addBtn, favBtn, $('revealBtn'), $('copyBtn')].forEach((b) => { b.disabled = false; });
    paintStar(favBtn, isFav(p));
    setInfo('infoName', stem(p));
    setInfo('infoSub', relParent(p));
    setInfo('infoFormat', extname(p).toUpperCase() || '—');
    ['infoDuration', 'infoRate', 'infoChannels', 'infoBits'].forEach((id) => setInfo(id, '…'));
    setInfo('infoPath', LRM + p + LRM);
    $('infoPath').title = p;
    notesEl.disabled = false;
    notesEl.value = state.notes[p] || '';
    api.stat(p).then((st) => { if (selected && selected.path === p) setInfo('infoSize', st ? fmtBytes(st.size) : '—'); });

    stopPreview();
    current = null;
    const token = ++previewToken;
    waveMsg.textContent = 'Loading…';
    waveMsg.style.display = 'flex';
    drawWave();

    let entry = cache.get(p);
    try {
      if (!entry) {
        const bytes = await api.read(p);
        if (token !== previewToken) return;
        const dec = await A.decode(bytes, extname(p));
        if (token !== previewToken) return;
        entry = { path: p, buffer: dec.buffer, peaks: A.peaks(dec.buffer, 1600), bitDepth: dec.bitDepth, codec: dec.codec };
        cache.set(p, entry);
        if (cache.size > 16) cache.delete(cache.keys().next().value);
      } else {
        cache.delete(p); cache.set(p, entry);
      }
    } catch (err) {
      if (token !== previewToken) return;
      waveMsg.textContent = 'Preview unavailable for this file';
      ['infoDuration', 'infoRate', 'infoChannels', 'infoBits'].forEach((id) => setInfo(id, '—'));
      setStatus('Could not decode ' + basename(p) + ': ' + (err && err.message ? err.message : err), true);
      return;
    }
    current = entry;
    const b = entry.buffer;
    waveMsg.style.display = 'none';
    setInfo('infoDuration', fmtTime(b.duration));
    setInfo('infoRate', (Math.round(b.sampleRate / 100) / 10) + ' kHz');
    setInfo('infoChannels', chanLabel(b.numberOfChannels));
    setInfo('infoBits', entry.bitDepth ? entry.bitDepth + '-bit' + (entry.codec && entry.codec !== 'PCM' ? ' ' + entry.codec : '') : (entry.codec || 'Compressed'));
    $('timeDur').textContent = fmtTime(b.duration);
    drawWave();
    if (play) playFrom(0);
    else setStatus(stem(p));
  }

  function scrollIntoView(wrap) {
    const row = wrap.firstElementChild;
    const r = row.getBoundingClientRect(), l = listEl.getBoundingClientRect();
    if (r.top < l.top) listEl.scrollTop -= l.top - r.top + 4;
    else if (r.bottom > l.bottom) listEl.scrollTop += r.bottom - l.bottom + 4;
  }

  // ── Playback ─────────────────────────────────────────
  const player = A.createPlayer(({ playing }) => {
    playBtn.classList.toggle('on', playing);
    playBtn.innerHTML = svg(playing ? 'i-stop' : 'i-play');
    document.querySelectorAll('.file.playing').forEach((x) => x.classList.remove('playing'));
    if (playing && selected && selected.wrap) selected.wrap.classList.add('playing');
    if (playing) tick(); else { cancelAnimationFrame(rafId); rafId = 0; drawWave(); }
  });
  player.setVolume(0.85);

  function playFrom(t) {
    if (!current) return;
    player.play(current.buffer, t);
    setStatus('Preview: ' + stem(current.path));
  }
  function stopPreview() { player.stop(); }
  function togglePlay() {
    if (!current) return;
    if (player.playing) stopPreview(); else playFrom(0);
  }
  function tick() {
    drawWave();
    rafId = player.playing ? requestAnimationFrame(tick) : 0;
  }

  // ── Waveform ─────────────────────────────────────────
  function drawWave() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(waveEl.clientWidth * dpr)), h = Math.max(1, Math.round(waveEl.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.clearRect(0, 0, w, h);
    const mid = h / 2;

    // Faint centre line and quarter guides.
    g.fillStyle = 'rgba(255,255,255,.05)';
    for (let i = 1; i < 4; i++) g.fillRect(Math.round(w * i / 4), 0, 1, h);
    g.fillStyle = 'rgba(255,255,255,.09)';
    g.fillRect(0, Math.round(mid), w, 1);

    const dur = current ? current.buffer.duration : 0;
    const pos = current ? player.position() : 0;
    $('timePos').textContent = fmtTime(pos);
    if (!current) { $('timeDur').textContent = fmtTime(0); waveCursor.style.display = 'none'; return; }

    const pk = current.peaks, buckets = pk.length / 2;
    const scale = (pk.peak > 0 ? Math.min(1 / pk.peak, 4) : 1) * mid * 0.9;
    const bar = Math.max(1, Math.round(2 * dpr)), gap = Math.max(1, Math.round(dpr));
    const progressX = dur > 0 ? (pos / dur) * w : 0;
    const showProgress = player.playing || pos > 0;

    for (let x = 0; x < w; x += bar + gap) {
      const b0 = Math.floor((x / w) * buckets), b1 = Math.max(b0 + 1, Math.floor(((x + bar) / w) * buckets));
      let min = 0, max = 0;
      for (let b = b0; b < b1 && b < buckets; b++) { if (pk[b * 2] < min) min = pk[b * 2]; if (pk[b * 2 + 1] > max) max = pk[b * 2 + 1]; }
      const top = mid - max * scale, bottom = mid - min * scale;
      const hgt = Math.max(dpr, bottom - top);
      g.fillStyle = showProgress && x < progressX ? '#ff6b3d' : '#8a8a96';
      g.fillRect(x, top, bar, hgt);
    }

    if (showProgress && dur > 0) {
      waveCursor.style.display = 'block';
      waveCursor.style.left = (pos / dur * 100) + '%';
    } else {
      waveCursor.style.display = 'none';
    }
  }

  waveEl.addEventListener('mousedown', (e) => {
    if (!current) return;
    const r = waveEl.getBoundingClientRect();
    playFrom(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * current.buffer.duration);
  });
  waveEl.addEventListener('mousemove', (e) => {
    const r = waveEl.getBoundingClientRect();
    waveHover.classList.toggle('on', !!current);
    waveHover.style.left = (e.clientX - r.left) + 'px';
  });
  new ResizeObserver(() => drawWave()).observe(waveEl);

  // ── Timeline insertion ───────────────────────────────
  let adding = false;
  async function addToTimeline() {
    if (!selected || adding) return;
    const p = selected.path;
    adding = true;
    addBtn.classList.add('busy');
    setStatus('Adding to timeline: ' + stem(p) + '…');
    try {
      const b = current && current.path === p ? current.buffer : null;
      const r = await api.insert(p, { durationSec: b ? b.duration : 0, channels: b ? b.numberOfChannels : 2 });
      setStatus(r.message, !r.ok);
      toast(r.ok ? r.message : 'Add failed — ' + r.message, r.ok ? 'ok' : 'err');
      if (r.ok) pollResolve();
    } catch (e) {
      setStatus('Add failed: ' + e.message, true);
      toast('Add failed — ' + e.message, 'err');
    } finally {
      adding = false;
      addBtn.classList.remove('busy');
    }
  }

  // ── Resolve connection indicator ─────────────────────
  let pollTimer = 0;
  async function pollResolve() {
    clearTimeout(pollTimer);
    const conn = $('conn'), text = $('connText');
    try {
      const s = await api.resolveStatus();
      conn.classList.toggle('ok', s.connected && !!s.timeline);
      conn.classList.toggle('off', !s.connected);
      if (!s.connected) { text.textContent = 'Resolve not connected'; conn.title = s.error || ''; }
      else if (!s.project) { text.textContent = 'No project open'; conn.title = ''; }
      else if (!s.timeline) { text.textContent = s.project + ' · no timeline'; conn.title = 'Open a timeline to add sounds'; }
      else { text.textContent = s.project + ' · ' + s.timeline; conn.title = 'Connected to DaVinci Resolve'; }
    } catch (e) {
      conn.classList.remove('ok'); conn.classList.add('off');
      text.textContent = 'Resolve not connected';
    }
    pollTimer = setTimeout(pollResolve, 4000);
  }

  // ── Menus ────────────────────────────────────────────
  function openMenu(x, y, items) {
    menuEl.innerHTML = '';
    items.forEach((it) => {
      if (it === '-') { menuEl.appendChild(document.createElement('hr')); return; }
      const b = document.createElement('button');
      if (it.danger) b.className = 'danger';
      b.innerHTML = svg(it.icon) + '<span>' + esc(it.label) + '</span>';
      b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.run(); });
      menuEl.appendChild(b);
    });
    menuEl.style.display = 'block';
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
    menuEl.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
  }
  function closeMenu() { menuEl.style.display = 'none'; }

  function fileMenu(x, y, p) {
    openMenu(x, y, [
      { icon: 'i-play', label: 'Play', run: () => select(p, selected && selected.wrap, true) },
      { icon: 'i-timeline', label: 'Add to Timeline', run: addToTimeline },
      '-',
      { icon: 'i-star', label: isFav(p) ? 'Remove from favorites' : 'Add to favorites', run: () => toggleFav(p) },
      { icon: 'i-reveal', label: revealLabel(), run: () => api.reveal(p) },
      { icon: 'i-copy', label: 'Copy path', run: () => { api.copy(p); setStatus('Path copied'); } },
      '-',
      { icon: 'i-eye-off', label: 'Hide sound', run: () => hideItem(p) }
    ]);
  }
  function folderMenu(x, y, p, isRoot, wrap) {
    const items = [
      { icon: wrap.classList.contains('open') ? 'i-folder' : 'i-folder-open', label: wrap.classList.contains('open') ? 'Collapse' : 'Expand', run: () => wrap.toggle() },
      { icon: 'i-reveal', label: revealLabel(), run: () => api.reveal(p) },
      { icon: 'i-copy', label: 'Copy path', run: () => { api.copy(p); setStatus('Path copied'); } },
      '-',
      { icon: 'i-eye-off', label: 'Hide folder', run: () => hideItem(p) }
    ];
    if (isRoot) items.push({ icon: 'i-close', label: 'Remove from browser', danger: true, run: () => removeRoot(p) });
    openMenu(x, y, items);
  }
  function revealLabel() { return api.platform === 'darwin' ? 'Reveal in Finder' : 'Show in Explorer'; }

  function renderHidden() {
    const listH = $('hiddenList');
    listH.innerHTML = '';
    if (!state.hidden.length) { listH.innerHTML = '<div class="popEmpty">No hidden items</div>'; return; }
    state.hidden.slice().sort((a, b) => basename(a).localeCompare(basename(b))).forEach((p) => {
      const row = document.createElement('div');
      row.className = 'popRow';
      const audio = !!extname(p) && /^(wav|mp3|aiff?|m4a|aac|flac|ogg)$/.test(extname(p));
      row.innerHTML = svg(audio ? 'i-volume' : 'i-folder') + '<div class="txt"><div>' + esc(audio ? stem(p) : basename(p)) + '</div><small title="' + esc(p) + '">' + LRM + esc(dirname(p)) + LRM + '</small></div><button>Restore</button>';
      row.querySelector('button').addEventListener('click', () => restoreItem(p));
      listH.appendChild(row);
    });
  }

  // ── Keyboard navigation ──────────────────────────────
  function visibleNodes() {
    return Array.from(listEl.querySelectorAll('.node')).filter((n) => n.offsetParent !== null);
  }
  function moveCursor(delta) {
    const nodes = visibleNodes();
    if (!nodes.length) return;
    let i = nodes.indexOf(cursorWrap || (selected && selected.wrap));
    i = i < 0 ? (delta > 0 ? 0 : nodes.length - 1) : Math.max(0, Math.min(nodes.length - 1, i + delta));
    const n = nodes[i];
    cursorWrap = n;
    if (n.classList.contains('file')) select(n.dataset.path, n, autoplayEl.checked);
    else {
      scrollIntoView(n);
      flashFolder(n);
    }
  }
  function clearFolderCursor() {
    document.querySelectorAll('.folder > .row.cursor').forEach((r) => r.classList.remove('cursor'));
  }
  function flashFolder(n) {
    clearFolderCursor();
    n.firstElementChild.classList.add('cursor');
  }

  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' && t.type === 'text' || t.tagName === 'TEXTAREA');
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      hiddenPanel.classList.remove('show');
      if (document.activeElement === searchEl && searchEl.value) { clearSearch(); return; }
      if (isTyping(e)) e.target.blur();
      return;
    }
    if (e.key === '/' && !isTyping(e)) { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
    if (e.target === searchEl && (e.key === 'ArrowDown' || e.key === 'Enter')) { e.preventDefault(); listEl.focus(); moveCursor(1); return; }
    if (isTyping(e)) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const n = cursorWrap;
      if (!n) return;
      e.preventDefault();
      if (n.classList.contains('folder')) {
        const open = n.classList.contains('open');
        if (e.key === 'ArrowRight' && !open) n.toggle(true);
        else if (e.key === 'ArrowLeft' && open) n.toggle(false);
        else if (e.key === 'ArrowLeft') jumpToParent(n);
        else moveCursor(1);
      } else if (e.key === 'ArrowLeft') jumpToParent(n);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (cursorWrap && cursorWrap.classList.contains('folder')) cursorWrap.toggle();
      else togglePlay();
    } else if ((e.key === 'f' || e.key === 'F') && selected && !e.metaKey && !e.ctrlKey) {
      toggleFav(selected.path);
    }
  });
  function jumpToParent(n) {
    const parent = n.parentElement && n.parentElement.closest('.folder');
    if (!parent) return;
    cursorWrap = parent;
    scrollIntoView(parent);
    flashFolder(parent);
  }

  // ── Wiring ───────────────────────────────────────────
  async function addFolder() {
    const p = await api.chooseFolder();
    if (!p) return;
    if (state.roots.indexOf(p) < 0) {
      state.roots.push(p);
      setExpanded(p, true);
      persist();
    }
    if (view !== 'library') view = state.view = 'library';
    render();
    setStatus('Added folder: ' + basename(p));
  }
  $('addFolder').addEventListener('click', addFolder);

  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    view = state.view = b.dataset.view;
    persist();
    render();
  }));

  let searchTimer = 0;
  searchEl.addEventListener('input', () => {
    searchBar.classList.toggle('has', !!searchEl.value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = searchEl.value.trim(); render(); }, 160);
  });
  function clearSearch() {
    searchEl.value = '';
    searchBar.classList.remove('has');
    query = '';
    render();
  }
  $('searchClear').addEventListener('click', () => { clearSearch(); searchEl.focus(); });

  playBtn.addEventListener('click', togglePlay);
  addBtn.addEventListener('click', addToTimeline);
  favBtn.addEventListener('click', () => { if (selected) toggleFav(selected.path); });
  $('revealBtn').addEventListener('click', () => { if (selected) api.reveal(selected.path); });
  $('copyBtn').addEventListener('click', () => { if (selected) { api.copy(selected.path); setStatus('Path copied'); } });

  function paintVolume() {
    volumeValue.textContent = volumeEl.value + '%';
    volumeEl.style.setProperty('--p', volumeEl.value + '%');
  }
  volumeEl.addEventListener('input', () => {
    player.setVolume(volumeEl.value / 100);
    paintVolume();
    state.volume = +volumeEl.value;
    persist();
  });
  autoplayEl.addEventListener('change', () => { state.autoplay = autoplayEl.checked; persist(); });

  let noteTimer = 0;
  notesEl.addEventListener('input', () => {
    const p = selected && selected.path, v = notesEl.value;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      if (!p) return;
      const had = !!state.notes[p];
      if (v.trim()) state.notes[p] = v; else delete state.notes[p];
      persist();
      if (had !== !!state.notes[p]) refreshNoteDot(p);
    }, 250);
  });
  function refreshNoteDot(p) {
    document.querySelectorAll('.file').forEach((el) => {
      if (el.dataset.path !== p) return;
      const row = el.firstElementChild, dot = row.querySelector('.noteDot');
      if (state.notes[p] && !dot) row.querySelector('.rowStar').insertAdjacentHTML('beforebegin', '<span class="noteDot" title="Has a note">' + svg('i-note') + '</span>');
      else if (!state.notes[p] && dot) dot.remove();
    });
  }

  $('hiddenToggle').addEventListener('click', (e) => {
    e.stopPropagation();
    const show = !hiddenPanel.classList.contains('show');
    hiddenPanel.classList.toggle('show', show);
    if (show) renderHidden();
  });
  $('hiddenClose').addEventListener('click', () => hiddenPanel.classList.remove('show'));
  window.addEventListener('mousedown', (e) => {
    if (!menuEl.contains(e.target)) closeMenu();
    if (!hiddenPanel.contains(e.target) && !e.target.closest('#hiddenToggle')) hiddenPanel.classList.remove('show');
  });
  window.addEventListener('blur', closeMenu);

  // Splitter between browser and inspector.
  const splitter = $('splitter');
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    splitter.classList.add('drag');
    const total = $('workspace').getBoundingClientRect();
    function move(ev) {
      const w = Math.max(280, Math.min(total.width * 0.6, total.right - ev.clientX));
      document.documentElement.style.setProperty('--ins-w', w + 'px');
      state.inspectorWidth = Math.round(w);
      drawWave();
    }
    function up() {
      splitter.classList.remove('drag');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      persist();
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  window.addEventListener('error', (e) => setStatus('Error: ' + e.message, true));

  // ── Boot ─────────────────────────────────────────────
  (async function boot() {
    try {
      const saved = await api.loadState();
      state = Object.assign({}, DEFAULTS, saved || {});
    } catch (e) { /* first launch */ }
    ['roots', 'hidden', 'favorites', 'expanded'].forEach((k) => { state[k] = arr(state[k]); });
    if (!state.notes || typeof state.notes !== 'object') state.notes = {};
    view = state.view === 'favorites' ? 'favorites' : 'library';
    volumeEl.value = Math.max(0, Math.min(100, Number(state.volume) || 0));
    player.setVolume(volumeEl.value / 100);
    paintVolume();
    autoplayEl.checked = state.autoplay !== false;
    if (state.inspectorWidth) document.documentElement.style.setProperty('--ins-w', state.inspectorWidth + 'px');
    updateCounts();
    clearSelection();
    await render();
    setStatus('Ready');
    pollResolve();
  })();
})();
