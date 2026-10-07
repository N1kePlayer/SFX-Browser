'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const library = require('./lib/library');
const { createBridge } = require('./lib/resolve');

const PLUGIN_ID = 'com.local.sfxbrowser.resolve';
const bridge = createBridge(PLUGIN_ID, __dirname);
const store = library.createStore(path.join(app.getPath('appData'), 'SFX Browser for Resolve', 'state.json'));
let win = null;
let dragIcon = null;

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 640,
    minWidth: 560,
    minHeight: 380,
    useContentSize: true,
    backgroundColor: '#131315',
    title: 'SFX Browser',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

function handle(channel, fn) {
  ipcMain.handle(channel, (_e, ...args) => fn(...args));
}

handle('state:load', () => store.load());
handle('state:save', (next) => { store.save(next); return true; });

handle('fs:list', (dir, hidden) => library.listDir(dir, hidden));
handle('fs:search', (roots, query, hidden) => library.search(roots, query, hidden));
handle('fs:stat', (p) => library.stat(p));
handle('fs:read', (p) => library.readFile(p));
handle('fs:existing', (paths) => library.existsMany(paths));

handle('ui:chooseFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose an SFX folder', properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
handle('ui:reveal', (p) => { shell.showItemInFolder(p); return true; });
handle('ui:copy', (text) => { clipboard.writeText(String(text)); return true; });

handle('resolve:status', () => bridge.status());
handle('resolve:insert', async (p, opts) => {
  try { return await bridge.insert(p, opts); } catch (e) { return { ok: false, message: e.message }; }
});

// Native OS drag: Resolve accepts files dropped on the timeline and the Media Pool.
ipcMain.on('drag:start', (e, p) => {
  if (!library.isAudio(p)) return;
  if (!dragIcon) dragIcon = nativeImage.createFromPath(path.join(__dirname, 'img', 'drag.png'));
  e.sender.startDrag({ file: p, icon: dragIcon });
});

app.whenReady().then(createWindow);

app.on('before-quit', async () => {
  store.flush();
  await bridge.cleanUp();
});

app.on('window-all-closed', () => {
  store.flush();
  app.quit();
});
