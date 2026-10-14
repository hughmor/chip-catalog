const $ = s => document.querySelector(s);
const enc = encodeURIComponent;
const ID = new URLSearchParams(location.search).get('id');
const API = `/api/chips/${enc(ID)}`;
const SVG = 'http://www.w3.org/2000/svg';
let chip, cfg;

async function api(url, body) {
  const r = await fetch(url, body && { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- GDS viewer ----------
// The server renders the visible region with KLayout. While a new image loads, the old one is scaled to the new view.
const cv = $('#canvas'), ctx = cv.getContext('2d');
let W = 1, H = 1, dpr = 1, view = { cx: 0, cy: 0, s: 1 }; // s: microns per CSS pixel
let img = null, imgBox = null, seq = 0, timer, highlights = [];

const toScreen = (x, y) => [(x - view.cx) / view.s + W / 2, H / 2 - (y - view.cy) / view.s];
const toWorld = (px, py) => [(px - W / 2) * view.s + view.cx, (H / 2 - py) * view.s + view.cy];
const viewBox = () => [...toWorld(0, H), ...toWorld(W, 0)];

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (img) {
    const [x1, y1] = toScreen(imgBox[0], imgBox[3]), [x2, y2] = toScreen(imgBox[2], imgBox[1]);
    ctx.drawImage(img, x1, y1, x2 - x1, y2 - y1);
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#0ff';
  ctx.fillStyle = 'rgba(0,255,255,0.15)';
  for (const [l, b, r, t] of highlights) {
    const [x1, y1] = toScreen(l, t), [x2, y2] = toScreen(r, b);
    const w = Math.max(x2 - x1, 3), h = Math.max(y2 - y1, 3);
    ctx.fillRect(x1, y1, w, h);
    ctx.strokeRect(x1, y1, w, h);
  }
}

function update() {
  draw();
  clearTimeout(timer);
  timer = setTimeout(() => {
    const box = viewBox(), id = ++seq, im = new Image();
    im.onload = () => { if (id === seq) { img = im; imgBox = box; draw(); } };
    im.src = `${API}/render.png?box=${box.map(v => v.toFixed(4)).join(',')}&w=${Math.round(W * dpr)}&h=${Math.round(H * dpr)}&v=${enc(chip.technology)}`;
  }, 120);
}

function fitTo([l, b, r, t], margin = 1.05) {
  view = { cx: (l + r) / 2, cy: (b + t) / 2, s: Math.max((r - l) / W, (t - b) / H, 1e-4) * margin };
  update();
}

new ResizeObserver(() => {
  dpr = window.devicePixelRatio || 1;
  W = cv.clientWidth || 1;
  H = cv.clientHeight || 1;
  cv.width = W * dpr;
  cv.height = H * dpr;
  if (chip) update();
}).observe(cv);

cv.addEventListener('wheel', e => {
  e.preventDefault();
  const [wx, wy] = toWorld(e.offsetX, e.offsetY);
  view.s = Math.min(Math.max(view.s * Math.exp(e.deltaY * 0.002), 1e-4), 1e3);
  view.cx = wx - (e.offsetX - W / 2) * view.s;
  view.cy = wy - (H / 2 - e.offsetY) * view.s;
  update();
}, { passive: false });

let drag = null;
cv.addEventListener('pointerdown', e => { drag = [e.clientX, e.clientY]; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; });
cv.addEventListener('pointerup', () => { drag = null; cv.style.cursor = ''; });
cv.addEventListener('pointermove', e => {
  const [x, y] = toWorld(e.offsetX, e.offsetY);
  $('#coords').textContent = `x ${x.toFixed(3)}  y ${y.toFixed(3)} µm`;
  if (!drag) return;
  view.cx -= (e.clientX - drag[0]) * view.s;
  view.cy += (e.clientY - drag[1]) * view.s;
  drag = [e.clientX, e.clientY];
  update();
});
$('#fit').onclick = () => fitTo(chip.bbox);
$('#clear').onclick = () => highlight(null);

// ---------- cells ----------
async function highlight(name) {
  document.querySelectorAll('.cellname.sel').forEach(e => e.classList.remove('sel'));
  highlights = [];
  $('#hlinfo').classList.toggle('hidden', !name);
  if (!name) return draw();
  document.querySelectorAll('.cellname').forEach(e => e.classList.toggle('sel', e.dataset.name === name));
  const { boxes, truncated } = await api(`${API}/boxes?cell=${enc(name)}`);
  highlights = boxes;
  $('#hlinfo').textContent = `${name}: ${boxes.length}${truncated ? '+' : ''} placement${boxes.length === 1 ? '' : 's'}`;
  if (!boxes.length) return draw();
  fitTo([Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
         Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))], 1.3);
}

function cellNode(c) {
  const name = el('span', 'cellname', c.name);
  name.dataset.name = c.name;
  name.title = 'Highlight in the layout';
  name.onclick = e => { e.preventDefault(); highlight(c.name); };
  const label = [name];
  if (c.count > 1) label.push(el('span', 'count', ` ×${c.count}`));
  if (c.leaf) {
    const d = el('div', 'leaf');
    d.append(...label);
    return d;
  }
  const d = el('details'), s = el('summary');
  s.append(...label);
  d.append(s);
  d.addEventListener('toggle', async () => {
    if (!d.open || d.loaded) return;
    d.loaded = true;
    const kids = await api(`${API}/cells?parent=${enc(c.name)}`);
    d.append(...kids.map(cellNode));
  });
  return d;
}

function showTree() {
  const root = cellNode({ name: chip.top, count: 1, leaf: false });
  $('#celltree').replaceChildren(root);
  root.open = true;
}

let qtimer;
$('#cellq').oninput = e => {
  clearTimeout(qtimer);
  qtimer = setTimeout(async () => {
    const q = e.target.value.trim();
    if (!q) return showTree();
    const names = await api(`${API}/cells?q=${enc(q)}`);
    $('#celltree').replaceChildren(...(names.length ? names.map(n => cellNode({ name: n, count: 1, leaf: true })) : [el('div', 'msg', 'No match')]));
  }, 200);
};

// ---------- info ----------
const form = $('#info');

function waferRow(w) {
  const row = el('div', 'row');
  row.dataset.id = w.id || '';
  const name = el('input');
  name.value = w.name;
  name.placeholder = 'Wafer name, e.g. undercut';
  const map = el('select');
  for (const [k, m] of Object.entries(cfg.wafermaps)) map.append(new Option(m.name || k, k));
  map.value = w.map;
  const rm = el('button', '', '×');
  rm.type = 'button';
  rm.title = 'Remove this wafer and its die records';
  rm.onclick = () => { if (confirm(`Remove wafer "${name.value}" and its die records when you save?`)) row.remove(); };
  row.append(name, map, rm);
  return row;
}

function authorRow(name = '') {
  const row = el('div', 'row'), input = el('input'), rm = el('button', '', '×');
  input.value = name;
  input.placeholder = 'Author name';
  rm.type = 'button';
  rm.title = 'Remove this author';
  rm.onclick = () => row.remove();
  row.append(input, rm);
  return row;
}

$('#addauthor').onclick = () => {
  const row = authorRow();
  $('#authors-edit').append(row);
  row.firstChild.focus();
};

$('#addwafer').onclick = () => {
  if (!Object.keys(cfg.wafermaps).length) return alert('The catalog has no wafer maps. Add a file to wafermaps/ first.');
  $('#wafers-edit').append(waferRow({ name: `Wafer ${$('#wafers-edit').children.length + 1}`, map: Object.keys(cfg.wafermaps)[0] }));
};

function infoRow(term, ...values) {
  const dd = el('dd');
  values = values.filter(v => v);
  if (values.length) dd.append(...values);
  else dd.append(el('span', 'msg', '—'));
  return [el('dt', '', term), dd];
}

function fillInfo() {
  document.title = $('#name').textContent = chip.internal_name;
  for (const k of ['internal_name', 'designation', 'technology', 'run', 'github', 'notes']) form.elements[k].value = chip[k];
  $('#authors-edit').replaceChildren(...chip.authors.map(a => authorRow(a)));
  const layers = chip.lyp ? `layers: ${chip.lyp}` : 'layers: default colours';
  $('#lyp').textContent = ` ${layers}`;
  $('#wafers-edit').replaceChildren(...chip.wafers.map(waferRow));
  saved = JSON.stringify(formBody());

  let gh = null;
  if (chip.github) {
    gh = el('a', '', chip.github.replace(/^https?:\/\//, ''));
    Object.assign(gh, { href: chip.github, target: '_blank', rel: 'noopener' });
  }
  const run = chip.run && new Date(`${chip.run}-01T00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
  $('#infoview').replaceChildren(
    ...infoRow('Official designation', chip.designation),
    ...infoRow('Foundry / technology', chip.technology && `${chip.technology} `, el('span', 'msg', layers)),
    ...infoRow('Run', run),
    ...infoRow('GitHub repository', gh),
    ...infoRow('Authors', ...chip.authors.map(a => el('div', '', a))),
    ...infoRow('Notes', chip.notes && el('div', 'notes', chip.notes)),
    ...infoRow('Wafers', ...chip.wafers.map(w => el('div', '', `${w.name} (${cfg.wafermaps[w.map]?.name || w.map})`))),
    ...infoRow('File', `${chip.file}, top cell ${chip.top}`),
  );
}

function formBody() {
  const f = form.elements;
  return {
    internal_name: f.internal_name.value.trim(), designation: f.designation.value.trim(),
    technology: f.technology.value.trim(), run: f.run.value.trim(), github: f.github.value.trim(), notes: f.notes.value,
    authors: [...document.querySelectorAll('#authors-edit input')].map(i => i.value.trim()).filter(Boolean),
    wafers: [...$('#wafers-edit').children].map(r => ({ id: r.dataset.id || undefined, name: r.children[0].value.trim(), map: r.children[1].value })),
  };
}

// Read-only by default. Edit mode unlocks the chip record and the die status.
let editing = false, saved = '';
function setEditing(on) {
  if (!on && JSON.stringify(formBody()) !== saved && !confirm('Discard the changes that you did not save?')) return;
  if (!on) fillInfo();
  editing = on;
  document.body.classList.toggle('editing', on);
  $('#edit').textContent = on ? 'Done' : 'Edit';
  $('#edit').classList.toggle('on', on);
  $('#infoview').classList.toggle('hidden', on);
  form.classList.toggle('hidden', !on);
  drawWafer();
}
$('#edit').onclick = () => setEditing(!editing);
$('#cancel').onclick = () => fillInfo();
window.addEventListener('beforeunload', e => { if (editing && JSON.stringify(formBody()) !== saved) e.preventDefault(); });

form.onsubmit = async e => {
  e.preventDefault();
  const tech = chip.technology;
  try {
    await api(API, formBody());
    chip = await api(API);
    fillInfo();
    fillWafers();
    if (chip.technology !== tech) update(); // new layer colours
    $('#savemsg').textContent = 'Saved';
  } catch (err) {
    $('#savemsg').textContent = `Not saved: ${err.message}`;
  }
  setTimeout(() => { $('#savemsg').textContent = ''; }, 4000);
};

// ---------- wafers ----------
const statuses = () => Object.keys(cfg.statuses);
let brush = 'cycle', mode = 'map';
const wafer = () => chip.wafers.find(w => w.id === $('#wafer').value);
const dieOf = (w, label) => w.dies[label] || { status: statuses()[0], notes: '' };

async function setDie(label, change) {
  const w = wafer();
  w.dies[label] = await api(`${API}/wafers/${enc(w.id)}/dies/${enc(label)}`, change);
  drawWafer();
}

function fillWafers() {
  const sel = $('#wafer'), prev = sel.value;
  sel.replaceChildren(...chip.wafers.map(w => new Option(`${w.name} (${cfg.wafermaps[w.map]?.name || w.map})`, w.id)));
  if (chip.wafers.some(w => w.id === prev)) sel.value = prev;
  $('#nowafers').classList.toggle('hidden', chip.wafers.length > 0);
  $('#waferui').classList.toggle('hidden', !chip.wafers.length);
  drawWafer();
}

function drawWafer() {
  const w = wafer();
  if (!w) return;
  const m = cfg.wafermaps[w.map];
  if (!m) return $('#wafermap').replaceChildren(el('p', 'msg', `Wafer map "${w.map}" is missing from wafermaps/.`));
  const rows = m.rows.map(r => r.trim().split(/\s+/));
  const labels = rows.flat().filter(t => t !== '.');
  const counts = {};
  for (const l of labels) counts[dieOf(w, l).status] = (counts[dieOf(w, l).status] || 0) + 1;

  const legend = [['cycle', null, 'Click cycles status']].concat(statuses().map(s => [s, cfg.statuses[s], `Click sets "${s}"`]));
  $('#readhint').classList.toggle('hidden', editing);
  $('#legend').replaceChildren(...legend.filter(([s]) => editing || s !== 'cycle').map(([s, colour, tip]) => {
    const b = el(editing ? 'button' : 'span', editing && s === brush ? 'on legendkey' : 'legendkey');
    b.title = tip;
    if (colour) { const sw = el('span', 'swatch'); sw.style.background = colour; b.append(sw); }
    b.append(colour ? `${s} (${counts[s] || 0})` : 'cycle');
    b.onclick = () => { brush = s; drawWafer(); };
    return b;
  }));

  // map: die (row r, column c) sits at ((c - ncols/2) * dw, (r - nrows/2) * dh), wafer centre at (0, 0)
  const [dw, dh] = m.die_size || [1, 1], ncols = Math.max(...rows.map(r => r.length)), nrows = rows.length;
  const R = (m.wafer_diameter || 0) / 2, gx = ncols * dw / 2, gy = nrows * dh / 2;
  const hw = Math.max(R, gx) * 1.02, hh = Math.max(R, gy) * 1.02;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `${-hw} ${-hh} ${2 * hw} ${2 * hh}`);
  const font = Math.min(dw, dh) * 0.4;
  svg.setAttribute('font-size', font);
  if (R) {
    const c = document.createElementNS(SVG, 'circle');
    c.setAttribute('r', R);
    svg.append(c);
  }
  rows.forEach((row, r) => row.forEach((label, c) => {
    if (label === '.') return;
    const d = dieOf(w, label), g = document.createElementNS(SVG, 'g');
    const rect = document.createElementNS(SVG, 'rect');
    Object.entries({ x: (c - ncols / 2) * dw, y: (r - nrows / 2) * dh, width: dw, height: dh, fill: cfg.statuses[d.status] || '#666' })
      .forEach(([k, v]) => rect.setAttribute(k, v));
    if (d.notes) rect.classList.add('noted');
    const title = document.createElementNS(SVG, 'title');
    title.textContent = `Die ${label}: ${d.status}${d.notes ? '\n' + d.notes : ''}`;
    const text = document.createElementNS(SVG, 'text');
    text.setAttribute('x', (c - ncols / 2 + 0.5) * dw);
    text.setAttribute('y', (r - nrows / 2 + 0.5) * dh);
    text.textContent = label;
    if (editing) rect.onclick = () => {
      const s = statuses();
      setDie(label, { status: brush === 'cycle' ? s[(s.indexOf(d.status) + 1) % s.length] : brush });
    };
    g.append(rect, title, text);
    svg.append(g);
  }));
  $('#wafermap').replaceChildren(svg);

  $('#dietable tbody').replaceChildren(...labels.map(label => {
    const d = dieOf(w, label), tr = el('tr'), td = x => { const t = el('td'); t.append(x); return t; };
    if (!editing) {
      const st = el('span', '', d.status);
      st.style.borderLeft = `6px solid ${cfg.statuses[d.status] || '#666'}`;
      st.style.paddingLeft = '4px';
      tr.append(td(label), td(st), td(d.notes));
      return tr;
    }
    const st = el('select'), notes = el('input');
    for (const s of statuses()) st.append(new Option(s, s));
    st.value = d.status;
    st.style.borderLeft = `6px solid ${cfg.statuses[d.status]}`;
    st.onchange = () => setDie(label, { status: st.value });
    notes.value = d.notes;
    notes.onchange = () => setDie(label, { notes: notes.value });
    tr.append(td(label), td(st), td(notes));
    return tr;
  }));
  $('#wafermap').classList.toggle('hidden', mode !== 'map');
  $('#dietable').classList.toggle('hidden', mode !== 'table');
}

$('#wafer').onchange = drawWafer;
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
  mode = b.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
  drawWafer();
});

// ---------- tabs and start ----------
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
  for (const t of ['info', 'cells', 'wafers']) $(`#tab-${t}`).classList.toggle('hidden', t !== b.dataset.tab);
});

(async () => {
  [cfg, chip] = await Promise.all([api('/api/config'), api(API)]);
  $('#techs').replaceChildren(...cfg.techs.map(t => new Option(t)));
  fillInfo();
  fillWafers();
  showTree();
  fitTo(chip.bbox);
})();
