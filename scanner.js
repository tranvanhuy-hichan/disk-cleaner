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
const MB = 1024 * 1024;
// Ngưỡng có thể chỉnh trong Cài đặt (đặt lại ở đầu mỗi lần quét).
let cfg = { minSize: 5 * MB, largeSize: 200 * MB, large: true, dup: true, dupSize: 10 * MB };
let MIN_SIZE = cfg.minSize;

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
  { paths: [h('.cache/yarn')], title: 'Yarn cache', note: 'Yarn tự tải lại khi cần' },
  { paths: [h('.local/share/pnpm/store'), h('.cache/pnpm')], title: 'pnpm store', note: 'pnpm tải lại khi cài package' },
  { paths: [h('.gradle/caches')], title: 'Gradle cache', note: 'Gradle tải lại khi build', level: 'review' },
  { paths: [h('.m2/repository')], title: 'Maven repository', note: 'Maven tải lại khi build', level: 'review' },
  { paths: [h('.cargo/registry')], title: 'Cargo registry', note: 'Cargo tải lại khi build', level: 'review' },
  { paths: [h('.cache/thumbnails')], title: 'Ảnh thu nhỏ (thumbnails)', note: 'Tự tạo lại khi mở thư mục ảnh' },
  { paths: [h('.cache/google-chrome'), h('.cache/chromium')], title: 'Cache trình duyệt Chrome/Chromium', note: 'Trang web sẽ tải chậm hơn lần đầu' },
  { paths: [h('.cache/mozilla/firefox')], title: 'Cache Firefox', note: 'Trang web sẽ tải chậm hơn lần đầu' },
  { paths: [h('.cache/huggingface')], title: 'Model Hugging Face', note: 'Phải tải lại nếu dùng', level: 'review' },
  { paths: [h('.cache/torch')], title: 'Model PyTorch', note: 'Phải tải lại nếu dùng', level: 'review' },
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

async function walk(dir, depth, found, onDir, ctl) {
  if (ctl?.cancelled) return;
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
    await walk(full, depth + 1, found, onDir, ctl);
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

async function scanProjects(onProgress, ctl) {
  const found = [];
  const roots = (await fsp.readdir(HOME, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map((e) => path.join(HOME, e.name));
  let n = 0;
  for (const r of roots) {
    await walk(r, 1, found, (d) => { if (++n % 200 === 0) onProgress?.(`Đang tìm trong ${rel(d)}`); }, ctl);
  }
  onProgress?.(`Đo dung lượng ${found.length} thư mục...`);
  const items = await pool(found.map((f) => async () => {
    if (ctl?.cancelled) return null;
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

// ---------- Cần quyền root: chạy qua pkexec (polkit), chỉ các lệnh cố định ----------
const ROOT_CMDS = { apt: ['apt-get', 'clean'], journal: ['journalctl', '--vacuum-size=100M'] };
async function scanSystem() {
  const items = [];
  const apt = await run('du', ['-sk', '/var/cache/apt/archives']);
  const aptSize = apt ? parseInt(apt, 10) * 1024 : 0;
  if (aptSize >= MIN_SIZE) {
    items.push({ id: idOf('sys', 'apt'), group: 'system', kind: 'root', sysType: 'apt', title: 'Cache gói apt', size: aptSize,
      level: 'safe', note: 'Cần quyền root: sẽ hiện hộp thoại nhập mật khẩu (polkit)', cmd: 'apt-get clean' });
  }
  const j = await run('journalctl', ['--disk-usage']);
  const m = j && /take up ([\d.]+)([KMGT])/.exec(j);
  if (m) {
    const total = parseFloat(m[1]) * { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2]];
    const keep = 100 * 1024 ** 2;
    if (total - keep >= MIN_SIZE) {
      items.push({ id: idOf('sys', 'journal'), group: 'system', kind: 'root', sysType: 'journal', title: 'Log hệ thống (journal)',
        size: Math.round(total - keep), level: 'safe', note: 'Cần quyền root (polkit), giữ lại 100 MB gần nhất',
        cmd: 'journalctl --vacuum-size=100M' });
    }
  }
  return items;
}

async function diskUsage() {
  const s = await fsp.statfs('/');
  return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
}

// ---------- Tệp lớn ----------
const LARGE_SKIP = ['/snap/', '/node_modules/', '/.local/share/Trash/', '/.cache/', '/.git/', '/.config/', '/.var/', '/.local/share/docker/'];
async function listFiles(minBytes) {
  const out = await run('find', [HOME, '-xdev', '-type', 'f', '-size', `+${Math.floor(minBytes / MB)}M`, '-printf', '%s\t%T@\t%p\n'], 120000);
  if (!out) return [];
  const rows = [];
  for (const line of out.split('\n')) {
    const [size, mtime, ...rest] = line.split('\t');
    const p = rest.join('\t');
    if (!p || LARGE_SKIP.some((k) => p.includes(k))) continue;
    if (path.relative(HOME, p).split(path.sep).some((part) => part.startsWith('.'))) continue; // thư mục/tệp ẩn: thường là dữ liệu chương trình
    rows.push({ p, size: Number(size), mtime: Number(mtime) * 1000 });
  }
  return rows;
}

const hashFile = (p, limit) => new Promise((resolve) => {
  const hash = crypto.createHash('sha1');
  const stream = fs.createReadStream(p, limit ? { start: 0, end: limit - 1 } : {});
  stream.on('data', (d) => hash.update(d));
  stream.on('end', () => resolve(hash.digest('hex')));
  stream.on('error', () => resolve(null));
});

// Nhóm theo kích thước -> hash 64 KB đầu -> hash toàn bộ. Chỉ tệp qua cả ba bước mới là trùng.
async function findDuplicates(rows, ctl) {
  const bySize = new Map();
  for (const r of rows) bySize.set(r.size, [...(bySize.get(r.size) || []), r]);
  const sets = [];
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    const partial = new Map();
    await pool(group.map((r) => async () => {
      if (ctl?.cancelled) return;
      const k = await hashFile(r.p, 65536);
      if (k) partial.set(k, [...(partial.get(k) || []), r]);
    }), 3);
    for (const cand of partial.values()) {
      if (cand.length < 2 || ctl?.cancelled) continue;
      const full = new Map();
      await pool(cand.map((r) => async () => {
        const k = await hashFile(r.p);
        if (k) full.set(k, [...(full.get(k) || []), r]);
      }), 2);
      for (const same of full.values()) if (same.length > 1) sets.push(same);
    }
  }
  return sets;
}

async function scanFiles(skipPaths, onProgress, ctl) {
  if (!cfg.large && !cfg.dup) return [];
  const minBytes = Math.min(cfg.large ? cfg.largeSize : Infinity, cfg.dup ? cfg.dupSize : Infinity);
  const rows = (await listFiles(minBytes)).filter((r) => !skipPaths.some((d) => r.p.startsWith(d + path.sep)));
  if (ctl?.cancelled) return [];
  const items = [];
  const inDupSet = new Set();

  if (cfg.dup) {
    onProgress?.('Đang so sánh tệp trùng lặp...');
    const sets = await findDuplicates(rows.filter((r) => r.size >= cfg.dupSize), ctl);
    sets.sort((a, b) => b[0].size * (b.length - 1) - a[0].size * (a.length - 1));
    for (const same of sets.slice(0, 30)) {
      same.sort((a, b) => a.mtime - b.mtime || a.p.length - b.p.length); // giữ bản cũ nhất
      const keep = same[0];
      for (const r of same) inDupSet.add(r.p);
      for (const r of same.slice(1)) {
        items.push({
          id: idOf('dup', r.p), group: 'dupe', kind: 'file', paths: [r.p], title: rel(r.p), size: r.size, level: 'review',
          note: `Trùng nội dung với ${rel(keep.p)} (bản này mới hơn, sẽ giữ lại bản kia)`,
        });
      }
    }
  }

  if (cfg.large) {
    rows.filter((r) => r.size >= cfg.largeSize && !inDupSet.has(r.p)).sort((a, b) => b.size - a.size).slice(0, 40).forEach((r) => {
      const days = Math.floor((Date.now() - r.mtime) / DAY);
      const inDl = r.p.startsWith(h('Downloads') + path.sep);
      items.push({
        id: idOf('file', r.p), group: 'large', kind: 'file', paths: [r.p], title: rel(r.p), size: r.size, level: 'review',
        note: `${inDl ? 'Trong Downloads · ' : ''}Sửa lần cuối ${days} ngày trước · không tự tạo lại được`,
      });
    });
  }
  return items;
}

// ---------- Treemap: dung lượng từng thư mục con ----------
async function treeDir(relPath) {
  const dir = path.resolve(HOME, relPath || '.');
  if (dir !== HOME && !dir.startsWith(HOME + path.sep)) throw new Error('Ngoài thư mục home');
  const dirs = new Set((await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name));
  const out = await run('du', ['-ak', '-x', '--max-depth=1', '--', dir], 240000);
  const entries = [];
  let total = 0;
  for (const line of (out || '').split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (!m) continue;
    if (m[2] === dir) { total = Number(m[1]) * 1024; continue; }
    const name = path.basename(m[2]);
    entries.push({ name, size: Number(m[1]) * 1024, dir: dirs.has(name) });
  }
  entries.sort((a, b) => b.size - a.size);
  return { path: path.relative(HOME, dir), total, entries: entries.slice(0, 60) };
}

async function scan(onProgress, opts = {}, ctl = {}) {
  cfg = { ...cfg, ...opts };
  MIN_SIZE = cfg.minSize;
  gitCache.clear();
  onProgress?.('Đang quét project...');
  const projects = await scanProjects(onProgress, ctl);
  if (ctl.cancelled) return null;
  onProgress?.('Đang quét cache...');
  const caches = await scanCaches();
  if (ctl.cancelled) return null;
  onProgress?.('Đang kiểm tra Docker...');
  const docker = await scanDocker();
  const system = await scanSystem();
  if (ctl.cancelled) return null;
  onProgress?.('Đang tìm tệp lớn...');
  const files = await scanFiles(projects.map((p) => p.paths[0]), onProgress, ctl);
  if (ctl.cancelled) return null;
  const items = [...projects, ...caches, ...docker, ...system, ...files].sort((a, b) => b.size - a.size);
  return { items, disk: await diskUsage(), scannedAt: Date.now() };
}

// ---------- Dọn ----------
// Chỉ xoá những đường dẫn nằm trong HOME (và không phải chính HOME).
function assertInsideHome(p) {
  const r = path.resolve(p);
  if (!r.startsWith(HOME + path.sep)) throw new Error(`Từ chối xoá ngoài thư mục home: ${p}`);
  return r;
}

// trash: hàm chuyển vào thùng rác (do main cung cấp); nếu không có thì xoá vĩnh viễn.
const remove = (p, trash) => (trash ? trash(p) : fsp.rm(p, { recursive: true, force: true }));

async function cleanItem(item, trash) {
  if (item.kind === 'docker') {
    const rule = DOCKER[item.dockerType];
    if (!rule) throw new Error('Lệnh Docker không hợp lệ');
    await new Promise((resolve, reject) =>
      execFile('docker', rule.args, { timeout: 600000 }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())));
    return;
  }
  if (item.kind === 'root') {
    const args = ROOT_CMDS[item.sysType];
    if (!args) throw new Error('Lệnh hệ thống không hợp lệ');
    await new Promise((resolve, reject) =>
      execFile('pkexec', args, { timeout: 300000 }, (err, _o, stderr) => {
        if (!err) return resolve();
        reject(new Error(err.code === 126 || err.code === 127 ? 'Đã huỷ xác thực quyền root' : stderr || err.message));
      }));
    return;
  }
  if (!['large', 'dupe'].includes(item.group)) trash = null; // cache/build tạo lại được và cần giải phóng dung lượng thật
  for (const p of item.paths) {
    const r = assertInsideHome(p);
    if (item.kind === 'contents') {
      for (const name of await fsp.readdir(r).catch(() => [])) await remove(path.join(r, name), trash);
    } else {
      await remove(r, trash);
    }
  }
}

module.exports = { scan, cleanItem, diskUsage, treeDir, HOME };

if (require.main === module) {
  const fmt = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + ' GB' : (b / 1024 ** 2).toFixed(0) + ' MB');
  scan((m) => process.stderr.write(m + '\n')).then(({ items, disk }) => {
    for (const i of items) console.log(`${i.level.padEnd(6)} ${fmt(i.size).padStart(8)}  ${i.title}`);
    const total = items.reduce((a, i) => a + i.size, 0);
    console.log(`\nTổng có thể dọn: ${fmt(total)} | Ổ / còn trống: ${fmt(disk.free)}/${fmt(disk.total)}`);
  });
}
