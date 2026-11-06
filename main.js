const { app, BrowserWindow, ipcMain, clipboard, shell, dialog, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { scan, cleanItem, diskUsage, treeDir } = require('./scanner');

// Chạy qua XWayland (ổn định), giống local-ai.
app.commandLine.appendSwitch('ozone-platform', 'x11');
app.disableHardwareAcceleration();
// Ubuntu mới chặn user namespace nên sandbox của Chromium không chạy được trong AppImage.
app.commandLine.appendSwitch('no-sandbox');

// Chỉ cho chạy một bản; mở lần hai thì đưa cửa sổ cũ lên (cần khi app chạy nền ở khay).
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => showWindow());

// Chỉ những mục có trong lần quét gần nhất mới được phép xoá: renderer chỉ gửi id, không gửi đường dẫn.
let known = new Map();
let busy = false;
let ctl = { cancelled: false };
let win = null;
let tray = null;
let quitting = false;
const DAY = 86400000;
const TRASHABLE = new Set(['large', 'dupe']);

// ---------- Cài đặt + thống kê, lưu trong thư mục dữ liệu của app ----------
const DEFAULTS = {
  trashLarge: true, minSizeMB: 5, largeMB: 200, scanLarge: true, dupScan: true, dupMB: 10,
  background: false, remindDays: 7,
  ignored: [], ignoredTitles: {}, totalFreed: 0, cleanCount: 0, lastScan: null, firstRun: null, lastRemind: 0,
};
let store = { ...DEFAULTS };
const storeFile = () => path.join(app.getPath('userData'), 'settings.json');
const loadStore = () => {
  try { store = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(storeFile(), 'utf8')) }; } catch {}
  if (!store.firstRun) { store.firstRun = Date.now(); saveStore(); }
};
const saveStore = () => { try { fs.mkdirSync(path.dirname(storeFile()), { recursive: true }); fs.writeFileSync(storeFile(), JSON.stringify(store)); } catch {} };
const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

// ---------- Cửa sổ ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 700, minHeight: 500,
    title: 'Disk Cleaner', autoHideMenuBar: true, backgroundColor: '#14161a',
    show: !(process.argv.includes('--hidden') && store.background),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (store.background && !quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- Chạy nền: khay hệ thống, tự khởi động, nhắc dọn ----------
const autostartFile = path.join(os.homedir(), '.config', 'autostart', 'vn.makeai.diskcleaner.desktop');

function syncBackground() {
  if (store.background && !tray) {
    try {
      const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 22, height: 22 });
      tray = new Tray(icon);
      tray.setToolTip('Disk Cleaner');
      tray.on('click', showWindow);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Mở Disk Cleaner', click: showWindow },
        { label: 'Quét ngay', click: () => { showWindow(); win?.webContents.send('tray:scan'); } },
        { type: 'separator' },
        { label: 'Thoát', click: () => { quitting = true; app.quit(); } },
      ]));
    } catch { tray = null; }
  } else if (!store.background && tray) {
    tray.destroy();
    tray = null;
  }
  // Tự khởi động cùng máy (chỉ khi chạy từ bản đóng gói, để không ghi đường dẫn của môi trường dev).
  try {
    if (store.background && app.isPackaged) {
      const exe = process.env.APPIMAGE || process.execPath;
      fs.mkdirSync(path.dirname(autostartFile), { recursive: true });
      fs.writeFileSync(autostartFile,
        `[Desktop Entry]\nType=Application\nName=Disk Cleaner\nExec="${exe}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    } else {
      fs.rmSync(autostartFile, { force: true });
    }
  } catch {}
}

function checkReminder() {
  if (!store.background || !store.remindDays || !Notification.isSupported()) return;
  const since = Date.now() - (store.lastScan || store.firstRun || Date.now());
  if (since < store.remindDays * DAY || Date.now() - store.lastRemind < DAY) return;
  store.lastRemind = Date.now();
  saveStore();
  const n = new Notification({ title: 'Disk Cleaner', body: `Đã ${Math.floor(since / DAY)} ngày chưa quét dọn máy. Bấm để kiểm tra.` });
  n.on('click', showWindow);
  n.show();
}

// ---------- IPC ----------
ipcMain.handle('disk', () => diskUsage());
ipcMain.handle('settings:get', () => store);
ipcMain.handle('settings:set', (_e, s) => {
  store.trashLarge = !!s.trashLarge;
  store.scanLarge = !!s.scanLarge;
  store.dupScan = !!s.dupScan;
  store.background = !!s.background;
  store.minSizeMB = num(s.minSizeMB, 1, 1000, DEFAULTS.minSizeMB);
  store.largeMB = num(s.largeMB, 50, 10000, DEFAULTS.largeMB);
  store.dupMB = num(s.dupMB, 1, 10000, DEFAULTS.dupMB);
  store.remindDays = num(s.remindDays, 0, 90, DEFAULTS.remindDays);
  if (Array.isArray(s.ignored)) store.ignored = s.ignored.filter((x) => typeof x === 'string').slice(0, 500);
  saveStore();
  syncBackground();
  return store;
});

ipcMain.handle('scan', async (e) => {
  if (busy) return { error: 'Đang bận, đợi tác vụ hiện tại xong' };
  busy = true;
  ctl = { cancelled: false };
  try {
    const MB = 1024 * 1024;
    const result = await scan((msg) => { if (!e.sender.isDestroyed()) e.sender.send('progress', msg); },
      { minSize: store.minSizeMB * MB, largeSize: store.largeMB * MB, large: store.scanLarge, dup: store.dupScan, dupSize: store.dupMB * MB }, ctl);
    if (!result) return { cancelled: true };
    result.items = result.items.filter((i) => !store.ignored.includes(i.id));
    known = new Map(result.items.map((i) => [i.id, i]));
    store.lastScan = result.scannedAt;
    saveStore();
    return result;
  } catch (err) {
    return { error: err.message };
  } finally {
    busy = false;
  }
});
ipcMain.handle('scan:cancel', () => { ctl.cancelled = true; });

ipcMain.handle('clean', async (e, ids) => {
  if (busy) return { error: 'Đang bận, đợi tác vụ hiện tại xong' };
  busy = true;
  const done = [];
  const errors = [];
  let freed = 0;
  let trashed = 0;
  const trash = store.trashLarge ? (p) => shell.trashItem(p) : null;
  try {
    for (const id of ids) {
      const item = known.get(id);
      if (!item) continue;
      if (!e.sender.isDestroyed()) e.sender.send('progress', `Đang dọn: ${item.title}`);
      try {
        await cleanItem(item, trash);
        if (trash && TRASHABLE.has(item.group)) trashed += item.size; else freed += item.size;
        done.push(id);
        known.delete(id);
      } catch (err) {
        errors.push(`${item.title}: ${err.message}`);
      }
    }
    store.totalFreed += freed;
    store.cleanCount += done.length;
    saveStore();
    return { freed, trashed, done, errors, totalFreed: store.totalFreed };
  } finally {
    busy = false;
  }
});

// Bỏ qua một mục: không hiện lại ở các lần quét sau (khôi phục trong Cài đặt).
ipcMain.handle('ignore', (_e, id) => {
  const item = known.get(id);
  if (!item || store.ignored.includes(id)) return store.ignored;
  store.ignored.push(id);
  store.ignoredTitles = { ...store.ignoredTitles, [id]: item.title };
  known.delete(id);
  saveStore();
  return store.ignored;
});

// Mở thư mục chứa mục (chỉ với mục có trong lần quét).
ipcMain.handle('reveal', (_e, id) => {
  const item = known.get(id);
  if (item?.paths?.[0]) shell.showItemInFolder(item.paths[0]);
});
ipcMain.handle('openTrash', () => shell.openPath(path.join(os.homedir(), '.local/share/Trash/files')));
ipcMain.handle('copy', (_e, text) => clipboard.writeText(String(text)));

// ---------- Treemap ----------
ipcMain.handle('tree', async (_e, rel) => {
  try { return await treeDir(String(rel || '')); } catch (err) { return { error: err.message }; }
});
ipcMain.handle('tree:reveal', (_e, rel) => {
  const p = path.resolve(os.homedir(), String(rel || '.'));
  if (p === os.homedir() || p.startsWith(os.homedir() + path.sep)) shell.showItemInFolder(p);
});

// ---------- Xuất CSV ----------
// Ô bắt đầu bằng = + - @ bị Excel/Sheets hiểu là công thức, nên thêm dấu nháy phía trước.
const csvCell = (v) => {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return `"${t.replace(/"/g, '""')}"`;
};
ipcMain.handle('export', async (_e, ids) => {
  const items = (Array.isArray(ids) ? ids : []).map((id) => known.get(id)).filter(Boolean);
  if (!items.length) return { error: 'Không có mục nào để xuất' };
  const day = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(win, {
    title: 'Xuất kết quả quét', defaultPath: path.join(os.homedir(), `disk-cleaner-${day}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return { cancelled: true };
  const rows = [['Nhóm', 'Tên', 'Đường dẫn', 'Dung lượng (byte)', 'Dung lượng (MB)', 'Mức độ', 'Ghi chú']];
  for (const i of items) {
    rows.push([i.group, i.title, (i.paths || [i.cmd || '']).join(' | '), i.size, (i.size / 1048576).toFixed(1),
      i.level === 'safe' ? 'An toàn' : 'Xem lại', i.note]);
  }
  try {
    fs.writeFileSync(r.filePath, '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
    return { path: r.filePath, count: items.length };
  } catch (err) {
    return { error: err.message };
  }
});

app.whenReady().then(() => {
  loadStore();
  createWindow();
  syncBackground();
  setTimeout(checkReminder, 30000);
  setInterval(checkReminder, 30 * 60000);
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!store.background || quitting) app.quit(); });
