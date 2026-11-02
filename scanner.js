const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOME = os.homedir();
const DAY = 86400000;
const ACTIVE_DAYS = 14; // project có hoạt động trong ngần này ngày => "cần xem lại"
const MAX_DEPTH = 7;
const MIN_SIZE = 5 * 1024 * 1024; // bỏ qua mục nhỏ hơn 5 MB

const SKIP_DIRS = new Set(['snap', 'node_modules', '.git']);

// Thư mục sinh ra khi build / cài đặt: xoá đi vẫn tạo lại được. `need` giúp tránh xoá nhầm
// những thư mục trùng tên nhưng chứa mã nguồn thật (ví dụ build/ của Electron, bin/ của shell).
const ARTIFACTS = {
  node_modules: { rebuild: 'npm install' },
  '.next': { need: ['package.json'], rebuild: 'npm run build' },
  target: { need: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'Cargo.toml'], rebuild: 'mvn package / cargo build' },
  bin: { needExt: '.csproj', rebuild: 'dotnet build' },
  obj: { needExt: '.csproj', rebuild: 'dotnet build' },
  '.venv': { inside: 'pyvenv.cfg', rebuild: 'python -m venv .venv && pip install -r requirements.txt' },
  venv: { inside: 'pyvenv.cfg', rebuild: 'python -m venv venv && pip install -r requirements.txt' },
  '.gradle': { need: ['build.gradle', 'build.gradle.kts', 'settings.gradle'], rebuild: 'gradle build' },
};

const h = (p) => path.join(HOME, p);
const CACHES = [
  { paths: [h('.npm/_cacache')], title: 'npm cache', note: 'npm tự tải lại khi cần' },
  { paths: [h('.npm/_npx')], title: 'npx cache', note: 'npx tự tải lại khi chạy' },
  { paths: [h('.cache/pip')], title: 'pip cache', note: 'pip tự tải lại khi cần' },
  { paths: [h('.cache/ms-playwright')], title: 'Trình duyệt của Playwright', note: 'Tải lại bằng npx playwright install' },
  { paths: [h('.cache/typescript')], title: 'TypeScript cache', note: 'Tự tạo lại' },
  { paths: [h('.cache/prisma')], title: 'Prisma engines', note: 'Tải lại khi chạy Prisma' },
  { paths: [h('.cache/electron')], title: 'Electron binary cache', note: 'Tải lại khi npm install' },
  { paths: [h('.cache/tracker3')], title: 'Chỉ mục tìm kiếm GNOME', note: 'Tự tạo lại' },
  { paths: [h('.cache/kagglehub')], title: 'Dữ liệu/model từ Kaggle', note: 'Phải tải lại nếu dùng', level: 'review' },
  { paths: [h('.cache/rtmlib')], title: 'Model rtmlib', note: 'Phải tải lại nếu dùng', level: 'review' },
  { paths: ['Cache', 'CachedData', 'CachedExtensionVSIXs', 'Code Cache', 'GPUCache'].map((d) => h('.config/Code/' + d)),
    title: 'Cache của VS Code', note: 'VS Code tự tạo lại' },
  { paths: [h('.local/share/Trash/files'), h('.local/share/Trash/info')], title: 'Thùng rác', note: 'Xoá vĩnh viễn', kind: 'contents' },
];

const DOCKER = {
  'Build Cache': { args: ['builder', 'prune', '-af'], level: 'safe', note: 'Lần docker build sau sẽ chậm hơn' },
  Images: { args: ['image', 'prune', '-af'], level: 'review', note: 'Xoá mọi image không có container, kể cả image của app đang làm' },
  Containers: { args: ['container', 'prune', '-f'], level: 'safe', note: 'Chỉ xoá container đã dừng' },
  'Local Volumes': { args: ['volume', 'prune', '-f'], level: 'review', note: 'Có thể chứa dữ liệu database' },
};

// Chạy lệnh, trả stdout (kể cả khi lệnh thoát lỗi một phần, ví dụ du gặp thư mục không có quyền).
const run = (cmd, args, timeout = 180000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 << 20 }, (_err, stdout) => resolve(stdout || null));
  });

const exists = (p) => fsp.access(p).then(() => true, () => false);
const sizeOf = async (p) => {
  const out = await run('du', ['-sk', '--', p]);
  return out ? parseInt(out, 10) * 1024 : 0;
};
const idOf = (...parts) => crypto.createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 12);
const rel = (p) => (p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);

function parseDockerSize(s) {
  const m = /^([\d.]+)\s*([kMGT]?B)/.exec(s || '');
  if (!m) return 0;
  const unit = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2]];
  return Math.round(parseFloat(m[1]) * unit);
}

async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }));
  return results;
}

// ---------- Thư mục build/cài đặt trong project ----------
async function matches(rule, parent, full, siblings) {
  if (rule.need && !rule.need.some((f) => siblings.includes(f))) return false;
  if (rule.needExt && !siblings.some((f) => f.endsWith(rule.needExt))) return false;
  if (rule.inside && !(await exists(path.join(full, rule.inside)))) return false;
  return true;
}

async function walk(dir, depth, found, onDir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  onDir?.(dir);
  const names = entries.map((e) => e.name);
  for (const e of entries) {
    if (!e.isDirectory()) continue; // symlink không phải thư mục thật => bỏ qua
    const full = path.join(dir, e.name);
    const rule = ARTIFACTS[e.name];
    if (rule && (await matches(rule, dir, full, names))) {
      found.push({ full, parent: dir, name: e.name, rule });
      continue;
    }
    if (depth >= MAX_DEPTH || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    await walk(full, depth + 1, found, onDir);
  }
}

const gitCache = new Map();
async function gitActivity(dir) {
  let best = 0;
  for (let d = dir; d.startsWith(HOME) && d !== HOME; d = path.dirname(d)) {
    if (!gitCache.has(d)) {
      let t = 0;
      for (const f of ['.git/logs/HEAD', '.git/index']) {
        try { t = Math.max(t, (await fsp.stat(path.join(d, f))).mtimeMs); } catch {}
      }
      gitCache.set(d, t);
    }
    best = Math.max(best, gitCache.get(d));
  }
  return best;
}

async function lastActive(dir) {
  let best = await gitActivity(dir);
  for (const f of ['package.json', 'package-lock.json', 'pom.xml', 'requirements.txt']) {
    try { best = Math.max(best, (await fsp.stat(path.join(dir, f))).mtimeMs); } catch {}
  }
  if (!best) { try { best = (await fsp.stat(dir)).mtimeMs; } catch {} }
  return best;
}

async function scanProjects(onProgress) {
  const found = [];
  const roots = (await fsp.readdir(HOME, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map((e) => path.join(HOME, e.name));
  let n = 0;
  for (const r of roots) {
    await walk(r, 1, found, (d) => { if (++n % 200 === 0) onProgress?.(`Đang tìm trong ${rel(d)}`); });
  }
  onProgress?.(`Đo dung lượng ${found.length} thư mục...`);
  const items = await pool(found.map((f) => async () => {
    const size = await sizeOf(f.full);
    if (size < MIN_SIZE) return null;
    const days = Math.floor((Date.now() - (await lastActive(f.parent))) / DAY);
    const active = days < ACTIVE_DAYS;
    return {
      id: idOf('dir', f.full), group: 'project', kind: 'dir', paths: [f.full],
      title: rel(f.full), size, level: active ? 'review' : 'safe',
      note: active ? `Project đang làm (hoạt động ${days} ngày trước)` : `Project lâu không đụng (${days} ngày)`,
      rebuild: f.rule.rebuild,
    };
  }), 4);
  return items.filter(Boolean);
}

// ---------- Cache ----------
async function scanCaches() {
  const items = await pool(CACHES.map((c) => async () => {
    const present = [];
    for (const p of c.paths) if (await exists(p)) present.push(p);
    if (!present.length) return null;
    const size = (await Promise.all(present.map(sizeOf))).reduce((a, b) => a + b, 0);
    if (size < MIN_SIZE) return null;
    return {
      id: idOf('cache', ...present), group: 'cache', kind: c.kind || 'dir', paths: present,
      title: c.title, size, level: c.level || 'safe', note: c.note,
    };
  }), 4);

  // Các thư mục lớn khác trong ~/.cache chưa nằm trong danh sách trên
  const known = new Set(CACHES.flatMap((c) => c.paths));
  try {
    const subs = (await fsp.readdir(h('.cache'), { withFileTypes: true })).filter((e) => e.isDirectory());
    const extra = await pool(subs.map((e) => async () => {
      const p = path.join(h('.cache'), e.name);
      if (known.has(p)) return null;
      const size = await sizeOf(p);
      if (size < 200 * 1024 * 1024) return null;
      return {
        id: idOf('cache', p), group: 'cache', kind: 'dir', paths: [p], title: rel(p), size,
        level: 'review', note: 'Cache của ứng dụng khác, kiểm tra trước khi xoá',
      };
    }), 4);
    items.push(...extra);
  } catch {}
  return items.filter(Boolean);
}

// ---------- Docker ----------
async function scanDocker() {
  const out = await run('docker', ['system', 'df', '--format', '{{json .}}'], 20000);
  if (!out) return [];
  const items = [];
  for (const line of out.split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const rule = DOCKER[row.Type];
    const size = parseDockerSize(row.Reclaimable);
    if (!rule || size < MIN_SIZE) continue;
    items.push({
      id: idOf('docker', row.Type), group: 'docker', kind: 'docker', dockerType: row.Type,
      title: `Docker: ${row.Type}`, size, level: rule.level, note: rule.note,
      cmd: 'docker ' + rule.args.join(' '),
    });
  }
  return items;
}

// ---------- Cần quyền root: chỉ hiển thị lệnh, không tự chạy ----------
async function scanSystem() {
  const items = [];
  const apt = await run('du', ['-sk', '/var/cache/apt/archives']);
  const aptSize = apt ? parseInt(apt, 10) * 1024 : 0;
  if (aptSize >= MIN_SIZE) {
    items.push({ id: idOf('sys', 'apt'), group: 'system', kind: 'sudo', title: 'Cache gói apt', size: aptSize,
      level: 'safe', note: 'Cần quyền root, chạy lệnh trong terminal', cmd: 'sudo apt clean' });
  }
  const j = await run('journalctl', ['--disk-usage']);
  const m = j && /take up ([\d.]+)([KMGT])/.exec(j);
  if (m) {
    const total = parseFloat(m[1]) * { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2]];
    const keep = 100 * 1024 ** 2;
    if (total - keep >= MIN_SIZE) {
      items.push({ id: idOf('sys', 'journal'), group: 'system', kind: 'sudo', title: 'Log hệ thống (journal)',
        size: Math.round(total - keep), level: 'safe', note: 'Cần quyền root, giữ lại 100 MB gần nhất',
        cmd: 'sudo journalctl --vacuum-size=100M' });
    }
  }
  return items;
}

async function diskUsage() {
  const s = await fsp.statfs('/');
  return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
}

async function scan(onProgress) {
  gitCache.clear();
  onProgress?.('Đang quét project...');
  const projects = await scanProjects(onProgress);
  onProgress?.('Đang quét cache...');
  const caches = await scanCaches();
  onProgress?.('Đang kiểm tra Docker...');
  const docker = await scanDocker();
  const system = await scanSystem();
  const items = [...projects, ...caches, ...docker, ...system].sort((a, b) => b.size - a.size);
  return { items, disk: await diskUsage(), scannedAt: Date.now() };
}

// ---------- Dọn ----------
// Chỉ xoá những đường dẫn nằm trong HOME (và không phải chính HOME).
function assertInsideHome(p) {
  const r = path.resolve(p);
  if (!r.startsWith(HOME + path.sep)) throw new Error(`Từ chối xoá ngoài thư mục home: ${p}`);
  return r;
}

async function cleanItem(item) {
  if (item.kind === 'docker') {
    const rule = DOCKER[item.dockerType];
    if (!rule) throw new Error('Lệnh Docker không hợp lệ');
    await new Promise((resolve, reject) =>
      execFile('docker', rule.args, { timeout: 600000 }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())));
    return;
  }
  if (item.kind === 'sudo') throw new Error('Mục này cần quyền root, hãy chạy lệnh trong terminal');
  for (const p of item.paths) {
    const r = assertInsideHome(p);
    if (item.kind === 'contents') {
      for (const name of await fsp.readdir(r).catch(() => [])) await fsp.rm(path.join(r, name), { recursive: true, force: true });
    } else {
      await fsp.rm(r, { recursive: true, force: true });
    }
  }
}

module.exports = { scan, cleanItem, diskUsage, HOME };

if (require.main === module) {
  const fmt = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + ' GB' : (b / 1024 ** 2).toFixed(0) + ' MB');
  scan((m) => process.stderr.write(m + '\n')).then(({ items, disk }) => {
    for (const i of items) console.log(`${i.level.padEnd(6)} ${fmt(i.size).padStart(8)}  ${i.title}`);
    const total = items.reduce((a, i) => a + i.size, 0);
    console.log(`\nTổng có thể dọn: ${fmt(total)} | Ổ / còn trống: ${fmt(disk.free)}/${fmt(disk.total)}`);
  });
}
