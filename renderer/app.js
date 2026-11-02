const $ = (s) => document.querySelector(s);

const GROUPS = [
  { id: 'project', label: 'Build / cài đặt trong project', color: 'var(--g-project)' },
  { id: 'cache', label: 'Cache', color: 'var(--g-cache)' },
  { id: 'docker', label: 'Docker', color: 'var(--g-docker)' },
  { id: 'system', label: 'Hệ thống (cần terminal)', color: 'var(--g-system)' },
];
const CIRC = 2 * Math.PI * 100;

let items = [];
let disk = null;
const selected = new Set();
let phase = 'idle'; // idle | scanning | ready | cleaning | done
let doneTimer;

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
  if (!items.length) {
    const text = { idle: 'Chưa quét. Kết quả sẽ hiện ở đây.', scanning: 'Đang tìm rác trên máy...' }[phase] || 'Máy đang sạch, không còn gì đáng dọn.';
    list.append(el('div', { className: 'empty' }, el('div', { className: 'big-emoji', textContent: phase === 'idle' ? '🧹' : phase === 'scanning' ? '🔍' : '✨' }),
      el('p', { textContent: text })));
    return;
  }
  const max = Math.max(...items.map((i) => i.size), 1);
  let n = 0;
  for (const g of GROUPS) {
    const rows = items.filter((i) => i.group === g.id);
    if (!rows.length) continue;
    const box = el('div', { className: 'group', id: 'group-' + g.id, style: `--gc:${g.color}` },
      el('h3', {}, el('span', { textContent: g.label }), el('span', { textContent: fmt(rows.reduce((a, i) => a + i.size, 0)) })));
    for (const it of rows) {
      const canClean = it.kind !== 'sudo';
      const info = el('div', { className: 'info' },
        el('div', { className: 'title' }, it.title,
          el('span', { className: 'badge ' + it.level, textContent: it.level === 'safe' ? 'An toàn' : 'Xem lại' })),
        el('div', { className: 'sub', textContent: it.note + (it.rebuild ? ` · Tạo lại: ${it.rebuild}` : '') }));
      if (it.cmd) {
        const sub = el('div', { className: 'sub' }, el('span', { className: 'cmd', textContent: it.cmd }));
        if (!canClean) sub.append(el('button', { className: 'copy', textContent: 'Sao chép', onclick: () => api.copy(it.cmd) }));
        info.append(sub);
      }
      const row = el('div', { className: 'row-item', style: `--w:${((it.size / max) * 100).toFixed(1)};animation-delay:${Math.min(n++, 25) * 22}ms` });
      row.append(canClean
        ? el('input', { type: 'checkbox', checked: selected.has(it.id), onchange: (e) => { e.target.checked ? selected.add(it.id) : selected.delete(it.id); refresh(); } })
        : el('span', { style: 'width:16px' }));
      row.append(info, el('div', { className: 'size', textContent: fmt(it.size) }));
      box.append(row);
    }
    list.append(box);
  }
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
  if (r.error) { setPhase('idle'); $('#status').textContent = 'Lỗi: ' + r.error; return; }
  items = r.items;
  disk = r.disk;
  selected.clear();
  for (const i of items) if (i.level === 'safe' && i.kind !== 'sudo') selected.add(i.id);
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
    $('#status').textContent = `Đã dọn ${r.done.length} mục.` + (r.errors.length ? ` Có ${r.errors.length} lỗi: ${r.errors.join('; ')}` : '');
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
$('#selSafe').onclick = () => { selected.clear(); items.filter((i) => i.level === 'safe' && i.kind !== 'sudo').forEach((i) => selected.add(i.id)); renderList(); refresh(); };
$('#selNone').onclick = () => { selected.clear(); renderList(); refresh(); };
api.onProgress((msg) => { if (phase === 'scanning' || phase === 'cleaning') $('#status').textContent = msg; });

(async () => {
  disk = await api.disk();
  updateDiskLine();
  renderList();
  setPhase('idle');
})();
