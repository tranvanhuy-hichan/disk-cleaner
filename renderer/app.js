const $ = (s) => document.querySelector(s);

const GROUPS = [
  { id: 'project', label: 'Build / cài đặt trong project', color: 'var(--g-project)' },
  { id: 'cache', label: 'Cache', color: 'var(--g-cache)' },
  { id: 'docker', label: 'Docker', color: 'var(--g-docker)' },
  { id: 'dupe', label: 'Tệp trùng lặp', color: 'var(--g-dupe)' },
  { id: 'large', label: 'Tệp lớn', color: 'var(--g-large)' },
  { id: 'system', label: 'Hệ thống (cần quyền root)', color: 'var(--g-system)' },
];
const CIRC = 2 * Math.PI * 100;

let items = [];
let disk = null;
const selected = new Set();
let phase = 'idle'; // idle | scanning | ready | cleaning | done
let doneTimer;
let settings = {};
let query = '';
let levelFilter = 'all';
let sortBy = 'size';
const collapsed = new Set();

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

const visible = () => {
  const q = query.trim().toLowerCase();
  const list = items.filter((i) => (levelFilter === 'all' || i.level === levelFilter)
    && (!q || (i.title + ' ' + i.note).toLowerCase().includes(q)));
  return sortBy === 'name' ? list.sort((a, b) => a.title.localeCompare(b.title)) : list.sort((a, b) => b.size - a.size);
};

// Tô sáng phần khớp tìm kiếm mà vẫn dùng textContent.
function hl(text) {
  const q = query.trim();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return [text];
  return [text.slice(0, i), el('mark', { textContent: text.slice(i, i + q.length) }), text.slice(i + q.length)];
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const fmt = (b) => (b >= GB ? (b / GB).toFixed(1) + ' GB' : Math.max(1, Math.round(b / MB)) + ' MB');
const split = (b) => (b >= GB ? [(b / GB).toFixed(1), 'GB'] : [String(Math.round(b / MB)), 'MB']);

// Tạo phần tử bằng textContent để tên thư mục không thể chèn HTML.
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

// ---------- Vòng tròn + số đếm ----------
function setArc(arc, startFrac, lenFrac) {
  const len = Math.max(0, Math.min(lenFrac, 1)) * CIRC;
  arc.style.strokeDasharray = `${len} ${CIRC}`;
  arc.style.transform = `rotate(${startFrac * 360 - 90}deg)`;
}

const shown = { value: 0 }; // giá trị số đang hiển thị ở giữa vòng (đơn vị: số trước khi format)
function countTo(target, unit) {
  const from = shown.value;
  const t0 = performance.now();
  $('#cUnit').textContent = unit;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 800);
    const v = from + (target - from) * (1 - Math.pow(1 - k, 3));
    $('#cNum').textContent = unit === 'GB' ? v.toFixed(1) : Math.round(v);
    shown.value = v;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function selectedBytes() {
  return items.filter((i) => selected.has(i.id)).reduce((a, i) => a + i.size, 0);
}

function updateRing() {
  const wrap = $('#ringWrap');
  wrap.className = phase === 'cleaning' ? 'scanning' : phase;
  if (!disk) return;
  const used = disk.total - disk.free;
  const sel = phase === 'ready' ? Math.min(selectedBytes(), used) : 0;
  setArc($('#arcUsed'), 0, (used - sel) / disk.total);
  setArc($('#arcClean'), (used - sel) / disk.total, sel / disk.total);
}

function updateCenter(freed) {
  if (!disk) return;
  const used = disk.total - disk.free;
  if (phase === 'scanning' || phase === 'cleaning') {
    $('#cLabel').textContent = phase === 'scanning' ? 'Đang quét' : 'Đang dọn';
    $('#cSub').textContent = '';
    return;
  }
  if (phase === 'done') {
    const [n, u] = split(freed);
    $('#cLabel').textContent = 'Đã giải phóng';
    countTo(parseFloat(n), u);
    $('#cSub').textContent = `Còn trống ${fmt(disk.free)}`;
  } else if (phase === 'ready') {
    const [n, u] = split(selectedBytes());
    $('#cLabel').textContent = 'Có thể dọn';
    countTo(parseFloat(n), u);
    $('#cSub').textContent = `trên tổng ${fmt(used)} đã dùng`;
  } else {
    $('#cLabel').textContent = 'Đã dùng';
    countTo(Math.round((used / disk.total) * 100), '%');
    $('#cSub').textContent = `${fmt(used)} / ${fmt(disk.total)}`;
  }
}

function updateDiskLine() {
  if (!disk) return;
  $('#diskLine').replaceChildren('Ổ ', el('b', { textContent: '/' }), ` · còn trống `, el('b', { textContent: fmt(disk.free) }), ` / ${fmt(disk.total)}`);
}

// ---------- Chú giải nhóm ----------
function renderLegend() {
  const box = $('#legend');
  box.replaceChildren();
  const sums = GROUPS.map((g) => ({ g, sum: items.filter((i) => i.group === g.id).reduce((a, i) => a + i.size, 0) })).filter((x) => x.sum);
  const max = Math.max(...sums.map((x) => x.sum), 1);
  for (const { g, sum } of sums) {
    const bar = el('i', { style: `background:${g.color};width:0` });
    box.append(el('div', { className: 'lg', onclick: () => document.getElementById('group-' + g.id)?.scrollIntoView({ behavior: 'smooth' }) },
      el('span', { className: 'dot', style: `background:${g.color}` }),
      el('span', { textContent: g.label }),
      el('span', { className: 'sz', textContent: fmt(sum) }),
      el('div', { className: 'mb' }, bar)));
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = (sum / max) * 100 + '%'; }));
  }
}

// ---------- Danh sách ----------
function renderList() {
  const list = $('#list');
  list.replaceChildren();
  applyView();
  if (!items.length) {
    const text = { idle: 'Chưa quét. Kết quả sẽ hiện ở đây.', scanning: 'Đang tìm rác trên máy...' }[phase] || 'Máy đang sạch, không còn gì đáng dọn.';
    list.append(el('div', { className: 'empty' }, el('div', { className: 'big-emoji', textContent: phase === 'idle' ? '🧹' : phase === 'scanning' ? '🔍' : '✨' }),
      el('p', { textContent: text })));
    return;
  }
  const vis = visible();
  if (!vis.length) {
    list.append(el('div', { className: 'empty' }, el('div', { className: 'big-emoji', textContent: '🔎' }), el('p', { textContent: 'Không có mục nào khớp bộ lọc.' })));
    return;
  }
  const max = Math.max(...vis.map((i) => i.size), 1);
  let n = 0;
  for (const g of GROUPS) {
    const rows = vis.filter((i) => i.group === g.id);
    if (!rows.length) continue;
    const allOn = rows.every((i) => selected.has(i.id));
    const selectable = rows;
    const gcb = el('input', { type: 'checkbox', checked: allOn && selectable.length > 0, disabled: !selectable.length, title: 'Chọn cả nhóm',
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => { for (const i of selectable) e.target.checked ? selected.add(i.id) : selected.delete(i.id); renderList(); refresh(); } });
    const box = el('div', { className: 'group' + (collapsed.has(g.id) ? ' collapsed' : ''), id: 'group-' + g.id, style: `--gc:${g.color}` },
      el('h3', { onclick: () => { collapsed.has(g.id) ? collapsed.delete(g.id) : collapsed.add(g.id); box.classList.toggle('collapsed'); } },
        el('span', { className: 'gl' }, el('span', { className: 'caret', textContent: '▾' }), gcb, el('i'), `${g.label} (${rows.length})`),
        el('span', { textContent: fmt(rows.reduce((a, i) => a + i.size, 0)) })));
    for (const it of rows) {
      const canClean = true;
      const info = el('div', { className: 'info' },
        el('div', { className: 'title' }, ...hl(it.title),
          el('span', { className: 'badge ' + it.level, textContent: it.level === 'safe' ? 'An toàn' : 'Xem lại' })),
        el('div', { className: 'sub', textContent: it.note + (it.rebuild ? ` · Tạo lại: ${it.rebuild}` : '') }));
      if (it.cmd) {
        const sub = el('div', { className: 'sub' }, el('span', { className: 'cmd', textContent: it.cmd }));
        if (!canClean) sub.append(el('button', { className: 'copy', textContent: 'Sao chép', onclick: (e) => { e.stopPropagation(); api.copy(it.cmd); toast('Đã sao chép lệnh'); } }));
        info.append(sub);
      }
      const acts = el('div', { className: 'acts' });
      if (it.paths) acts.append(el('button', { textContent: 'Mở', title: 'Mở thư mục chứa', onclick: (e) => { e.stopPropagation(); api.reveal(it.id); } }));
      acts.append(el('button', { textContent: 'Bỏ qua', title: 'Không hiện mục này nữa',
        onclick: async (e) => {
          e.stopPropagation();
          await api.ignore(it.id);
          items = items.filter((x) => x.id !== it.id);
          selected.delete(it.id);
          settings = await api.getSettings();
          renderList(); renderLegend(); refresh();
          toast('Đã ẩn mục này. Khôi phục trong Cài đặt.');
        } }));
      const cb = canClean
        ? el('input', { type: 'checkbox', checked: selected.has(it.id), onclick: (e) => e.stopPropagation(),
            onchange: (e) => { e.target.checked ? selected.add(it.id) : selected.delete(it.id); refresh(); syncGroupBoxes(); } })
        : el('span', { style: 'width:16px' });
      const row = el('div', { className: 'row-item', style: `--w:${((it.size / max) * 100).toFixed(1)};animation-delay:${Math.min(n++, 25) * 22}ms`,
        onclick: () => { if (cb.click && canClean) cb.click(); } });
      row.append(cb, info, acts, el('div', { className: 'size', textContent: fmt(it.size) }));
      box.append(row);
    }
    list.append(box);
  }
}

// Cập nhật ô chọn của tiêu đề nhóm sau khi chọn lẻ từng mục.
function syncGroupBoxes() {
  const vis = visible();
  for (const g of GROUPS) {
    const sel = vis.filter((i) => i.group === g.id);
    const cb = document.querySelector(`#group-${g.id} h3 input`);
    if (cb && sel.length) cb.checked = sel.every((i) => selected.has(i.id));
  }
}

function renderStats() {
  const box = $('#stats');
  box.replaceChildren();
  if (settings.totalFreed) box.append('Tổng đã giải phóng: ', el('b', { textContent: fmt(settings.totalFreed) }), ` · ${settings.cleanCount} mục`);
}

// ---------- Nút chính ----------
function updateButtons() {
  const btn = $('#mainBtn');
  const sel = items.filter((i) => selected.has(i.id));
  btn.classList.toggle('clean', phase === 'ready' && sel.length > 0);
  if (phase === 'scanning') { btn.textContent = 'Đang quét...'; btn.disabled = true; }
  else if (phase === 'cleaning') { btn.textContent = 'Đang dọn...'; btn.disabled = true; }
  else if (phase === 'ready' && sel.length) { btn.textContent = `Dọn ${fmt(selectedBytes())} (${sel.length} mục)`; btn.disabled = false; }
  else if (phase === 'ready') { btn.textContent = 'Quét lại'; btn.disabled = false; }
  else { btn.textContent = phase === 'done' ? 'Quét lại' : 'Quét máy'; btn.disabled = false; }
  const showSel = phase === 'ready' && items.length > 0;
  $('#selSafe').hidden = $('#selNone').hidden = !showSel;
  $('#cancelBtn').hidden = phase !== 'scanning';
}

// Cập nhật phần phụ thuộc vào lựa chọn (không vẽ lại danh sách để checkbox không bị nháy).
function refresh() {
  updateRing();
  updateCenter();
  updateButtons();
}

function setPhase(p, freed) {
  phase = p;
  updateRing();
  updateCenter(freed);
  updateButtons();
}

// ---------- Luồng chính ----------
async function scan() {
  clearTimeout(doneTimer);
  items = [];
  setPhase('scanning');
  renderList();
  $('#status').textContent = 'Đang quét...';
  const r = await api.scan();
  if (r.cancelled) { setPhase('idle'); renderList(); $('#status').textContent = 'Đã huỷ quét.'; return; }
  if (r.error) { setPhase('idle'); $('#status').textContent = 'Lỗi: ' + r.error; return; }
  items = r.items;
  disk = r.disk;
  selected.clear();
  for (const i of items) if (i.level === 'safe' && i.kind !== 'root') selected.add(i.id);
  const total = items.reduce((a, i) => a + i.size, 0);
  $('#status').textContent = items.length
    ? `Tìm thấy ${items.length} mục, tổng ${fmt(total)}. Mục "An toàn" đã được chọn sẵn, mục "Xem lại" cần bạn tự cân nhắc.`
    : 'Không tìm thấy gì đáng dọn.';
  updateDiskLine();
  renderList();
  renderLegend();
  setPhase('ready');
}

function confirmClean() {
  const chosen = items.filter((i) => selected.has(i.id));
  $('#confirmText').textContent = `Dọn ${chosen.length} mục, giải phóng khoảng ${fmt(selectedBytes())}:`;
  const hasLarge = chosen.some((i) => i.group === 'large' || i.group === 'dupe');
  $('#confirmNote').innerHTML = '';
  $('#confirmNote').append(hasLarge && settings.trashLarge
    ? 'Tệp lớn sẽ được chuyển vào thùng rác; các mục còn lại bị '
    : 'Các mục này bị ', el('b', { textContent: 'xoá vĩnh viễn' }), ' (không vào thùng rác).',
    chosen.some((i) => i.kind === 'root') ? ' Mục hệ thống sẽ hiện hộp thoại nhập mật khẩu.' : '');
  const ul = $('#confirmList');
  ul.replaceChildren(...chosen.slice(0, 50).map((i) => el('li', { textContent: `${i.title} (${fmt(i.size)})` })));
  if (chosen.length > 50) ul.append(el('li', { textContent: `...và ${chosen.length - 50} mục khác` }));
  const dlg = $('#confirm');
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    setPhase('cleaning');
    const r = await api.clean(chosen.map((i) => i.id));
    if (r.error) { setPhase('ready'); $('#status').textContent = 'Lỗi: ' + r.error; return; }
    const done = new Set(r.done);
    items = items.filter((i) => !done.has(i.id));
    for (const id of done) selected.delete(id);
    disk = await api.disk();
    settings.totalFreed = r.totalFreed;
    settings.cleanCount = (settings.cleanCount || 0) + r.done.length;
    renderStats();
    $('#status').textContent = `Đã dọn ${r.done.length} mục.`
      + (r.trashed ? ` ${fmt(r.trashed)} tệp lớn đã vào thùng rác, dọn thùng rác để lấy lại dung lượng.` : '')
      + (r.errors.length ? ` Có ${r.errors.length} lỗi: ${r.errors.join('; ')}` : '');
    toast(r.freed ? `Đã giải phóng ${fmt(r.freed)}` : `Đã xử lý ${r.done.length} mục`);
    updateDiskLine();
    renderList();
    renderLegend();
    setPhase('done', r.freed);
    const wrap = $('#ringWrap');
    wrap.classList.add('burst');
    setTimeout(() => wrap.classList.remove('burst'), 1600);
    // Sau vài giây quay lại màn hình kết quả còn lại
    doneTimer = setTimeout(() => { if (phase === 'done') setPhase('ready'); }, 4500);
  };
  dlg.showModal();
}

$('#mainBtn').onclick = () => {
  const hasSel = phase === 'ready' && items.some((i) => selected.has(i.id));
  if (hasSel) confirmClean(); else scan();
};
$('#selSafe').onclick = () => { selected.clear(); items.filter((i) => i.level === 'safe' && i.kind !== 'root').forEach((i) => selected.add(i.id)); renderList(); refresh(); };
$('#selNone').onclick = () => { selected.clear(); renderList(); refresh(); };
$('#cancelBtn').onclick = () => api.cancelScan();
$('#search').oninput = (e) => { query = e.target.value; renderList(); };
$('#sort').onchange = (e) => { sortBy = e.target.value; renderList(); };
$('#chips').onclick = (e) => {
  const f = e.target.dataset?.f;
  if (!f) return;
  levelFilter = f;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.f === f));
  renderList();
};
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !$('#toolbar').hidden) { e.preventDefault(); $('#search').focus(); $('#search').select(); }
  if (e.key === 'Escape' && document.activeElement === $('#search')) { $('#search').value = ''; query = ''; renderList(); $('#search').blur(); }
});

// ---------- Cài đặt ----------
function openSettings() {
  $('#oTrash').checked = settings.trashLarge;
  $('#oLarge').checked = settings.scanLarge;
  $('#oDup').checked = settings.dupScan;
  $('#oBg').checked = settings.background;
  $('#oDupMB').value = settings.dupMB;
  $('#oRemind').value = settings.remindDays;
  $('#oMin').value = settings.minSizeMB;
  $('#oLargeMB').value = settings.largeMB;
  const box = $('#ignoredBox');
  box.replaceChildren();
  const ign = settings.ignored || [];
  if (ign.length) {
    box.append(el('h4', { textContent: `Mục đã ẩn (${ign.length})` }));
    for (const id of ign) {
      box.append(el('div', { className: 'ig' }, el('span', { textContent: settings.ignoredTitles?.[id] || id }),
        el('button', { type: 'button', textContent: 'Khôi phục', onclick: (e) => {
          settings.ignored = settings.ignored.filter((x) => x !== id);
          e.target.closest('.ig').remove();
        } })));
    }
  }
  const dlg = $('#settings');
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') { settings = await api.getSettings(); return; }
    settings = await api.setSettings({
      trashLarge: $('#oTrash').checked, scanLarge: $('#oLarge').checked, dupScan: $('#oDup').checked, background: $('#oBg').checked,
      dupMB: $('#oDupMB').value, remindDays: $('#oRemind').value,
      minSizeMB: $('#oMin').value, largeMB: $('#oLargeMB').value, ignored: settings.ignored,
    });
    toast('Đã lưu cài đặt. Quét lại để áp dụng ngưỡng mới.');
  };
  dlg.showModal();
}
$('#settingsBtn').onclick = openSettings;

api.onProgress((msg) => { if (phase === 'scanning' || phase === 'cleaning') $('#status').textContent = msg; });

(async () => {
  settings = await api.getSettings();
  disk = await api.disk();
  updateDiskLine();
  renderStats();
  renderList();
  setPhase('idle');
})();

// ---------- Xuất CSV ----------
$('#exportBtn').onclick = async () => {
  const r = await api.exportCsv(visible().map((i) => i.id));
  if (r.error) toast('Lỗi: ' + r.error);
  else if (!r.cancelled) toast(`Đã xuất ${r.count} mục ra ${r.path}`, 5000);
};

// ---------- Tab + treemap ----------
let view = 'list';
let treeDir = [];
const PALETTE = ['#0f766e', '#6d28d9', '#0369a1', '#b45309', '#be185d', '#4d7c0f', '#b91c1c', '#4338ca', '#0e7490', '#a16207'];

function applyView() {
  $('#list').hidden = view !== 'list';
  $('#treeView').hidden = view !== 'tree';
  $('#toolbar').hidden = view !== 'list' || !items.length;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.v === view));
}

// Squarified treemap: xếp ô sao cho gần hình vuông nhất.
function squarify(nodes, x, y, w, h) {
  const out = [];
  const rest = nodes.slice();
  const worst = (areas, side, sum) => {
    const max = Math.max(...areas), min = Math.min(...areas);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  while (rest.length) {
    const side = Math.min(w, h);
    const row = [];
    let sum = 0, best = Infinity;
    while (rest.length) {
      const n = rest[0];
      const wr = worst([...row, n].map((c) => c.a), side, sum + n.a);
      if (row.length && wr > best) break;
      row.push(n); sum += n.a; best = wr; rest.shift();
    }
    if (w >= h) {
      const rw = sum / h; let cy = y;
      for (const n of row) { const nh = n.a / rw; out.push({ n, x, y: cy, w: rw, h: nh }); cy += nh; }
      x += rw; w -= rw;
    } else {
      const rh = sum / w; let cx = x;
      for (const n of row) { const nw = n.a / rh; out.push({ n, x: cx, y, w: nw, h: rh }); cx += nw; }
      y += rh; h -= rh;
    }
  }
  return out;
}

function renderCrumbs(total) {
  const box = $('#crumbs');
  box.replaceChildren();
  const parts = ['~', ...treeDir];
  parts.forEach((name, i) => {
    if (i) box.append(el('span', { textContent: '/' }));
    box.append(el('button', { type: 'button', textContent: name, onclick: () => loadTree(treeDir.slice(0, i)) }));
  });
  if (total) box.append(el('span', { className: 'total', textContent: fmt(total) }));
}

async function loadTree(dir) {
  treeDir = dir;
  renderCrumbs(0);
  const map = $('#treemap');
  map.replaceChildren(el('div', { className: 'msg', textContent: 'Đang đo dung lượng… (thư mục home có thể mất vài chục giây)' }));
  const r = await api.tree(dir.join('/'));
  if (dir !== treeDir) return; // người dùng đã đi nơi khác trong lúc chờ
  if (r.error) { map.replaceChildren(el('div', { className: 'msg', textContent: 'Lỗi: ' + r.error })); return; }
  renderCrumbs(r.total);
  drawTree(r);
}

function drawTree(r) {
  const map = $('#treemap');
  const entries = r.entries.filter((e) => e.size > 0);
  if (!entries.length) { map.replaceChildren(el('div', { className: 'msg', textContent: 'Thư mục trống' })); return; }
  const W = map.clientWidth, H = map.clientHeight;
  const sum = entries.reduce((a, e) => a + e.size, 0);
  const cells = squarify(entries.map((e) => ({ ...e, a: (e.size / sum) * W * H })), 0, 0, W, H);
  map.replaceChildren(...cells.map(({ n, x, y, w, h }, i) => {
    const cell = el('div', { className: 'cell' + (n.dir ? ' dir' : ''), title: `${n.name} · ${fmt(n.size)} (${((n.size / r.total) * 100).toFixed(1)}%)`,
      style: `left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${n.dir ? PALETTE[i % PALETTE.length] : '#475569'}` });
    if (w > 54 && h > 34) cell.append(el('b', { textContent: n.name }), el('span', { textContent: fmt(n.size) }));
    if (n.dir) cell.onclick = () => loadTree([...treeDir, n.name]);
    cell.oncontextmenu = (e) => { e.preventDefault(); api.revealPath([...treeDir, n.name].join('/')); };
    return cell;
  }));
  map._last = r;
}

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    view = t.dataset.v;
    applyView();
    if (view === 'tree' && !$('#treemap').children.length) loadTree(treeDir);
  };
});
window.addEventListener('resize', () => { const r = $('#treemap')._last; if (view === 'tree' && r) drawTree(r); });

api.onTrayScan(() => { if (phase !== 'scanning' && phase !== 'cleaning') scan(); });
