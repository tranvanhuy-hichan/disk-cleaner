const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const { scan, cleanItem, diskUsage } = require('./scanner');

// Chạy qua XWayland (ổn định), giống local-ai.
app.commandLine.appendSwitch('ozone-platform', 'x11');
app.disableHardwareAcceleration();

// Chỉ những mục có trong lần quét gần nhất mới được phép xoá: renderer chỉ gửi id, không gửi đường dẫn.
let known = new Map();
let busy = false;

function createWindow() {
  const win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 700, minHeight: 500,
    title: 'Disk Cleaner', autoHideMenuBar: true, backgroundColor: '#212121',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('disk', () => diskUsage());

ipcMain.handle('scan', async (e) => {
  if (busy) return { error: 'Đang bận, đợi tác vụ hiện tại xong' };
  busy = true;
  try {
    const result = await scan((msg) => { if (!e.sender.isDestroyed()) e.sender.send('progress', msg); });
    known = new Map(result.items.map((i) => [i.id, i]));
    return result;
  } catch (err) {
    return { error: err.message };
  } finally {
    busy = false;
  }
});

ipcMain.handle('clean', async (e, ids) => {
  if (busy) return { error: 'Đang bận, đợi tác vụ hiện tại xong' };
  busy = true;
  const done = [];
  const errors = [];
  let freed = 0;
  try {
    for (const id of ids) {
      const item = known.get(id);
      if (!item) continue;
      if (!e.sender.isDestroyed()) e.sender.send('progress', `Đang dọn: ${item.title}`);
      try {
        await cleanItem(item);
        freed += item.size;
        done.push(id);
        known.delete(id);
      } catch (err) {
        errors.push(`${item.title}: ${err.message}`);
      }
    }
    return { freed, done, errors };
  } finally {
    busy = false;
  }
});

ipcMain.handle('copy', (_e, text) => clipboard.writeText(String(text)));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
