// Helpers and the chip record form, shared by the catalog page and the chip page.
const enc = encodeURIComponent;

async function api(url, body, method = 'PUT') {
  const opts = body instanceof Blob ? { method, body }
    : body && { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(url, opts);
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

const CHIP_FIELDS = `
  <label class="f">Internal name <input name="internal_name"></label>
  <label class="f">Official (foundry / MPW) designation <input name="designation"></label>
  <label class="f">Foundry / technology <input name="technology" list="techs"><span class="lyp"></span></label>
  <datalist id="techs"></datalist>
  <label class="f">Run (month / year) <input name="run" type="month" placeholder="YYYY-MM" pattern="\\d{4}-\\d{2}"></label>
  <label class="f">GitHub repository <input name="github" type="url" pattern="https?://.*" placeholder="https://github.com/..."></label>
  <div class="f">Authors</div>
  <div class="authors"></div>
  <div class="row"><button type="button" class="addauthor" title="Add an author">+</button></div>
  <label class="f">Notes <textarea name="notes"></textarea></label>
  <div class="f">Wafers <small>(none for a one-off die)</small></div>
  <div class="wafers"></div>
  <div class="row"><button type="button" class="addwafer">+ Add wafer</button></div>`;

// The .lyp file that the server uses for a technology name (see lyp_for in server.py).
const lypFor = (cfg, tech) => cfg.techs.find(t => tech && t.toLowerCase() === tech.toLowerCase());

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

function waferRow(cfg, w) {
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
  rm.onclick = () => { if (!w.id || confirm(`Remove wafer "${name.value}" and its die records when you save?`)) row.remove(); };
  row.append(name, map, rm);
  return row;
}

// Put the chip fields into the .fields element of a form.
function setupChipForm(form, cfg) {
  form.querySelector('.fields').innerHTML = CHIP_FIELDS;
  form.querySelector('#techs').replaceChildren(...cfg.techs.map(t => new Option(t)));
  const tech = form.elements.technology;
  tech.oninput = () => {
    const t = lypFor(cfg, tech.value.trim());
    form.querySelector('.lyp').textContent = ` layers: ${t ? `${t}.lyp` : 'default colours'}`;
  };
  form.querySelector('.addauthor').onclick = () => {
    const row = authorRow();
    form.querySelector('.authors').append(row);
    row.firstChild.focus();
  };
  form.querySelector('.addwafer').onclick = () => {
    const maps = Object.keys(cfg.wafermaps);
    if (!maps.length) return alert('The catalog has no wafer maps. Add a file to wafermaps/ first.');
    form.querySelector('.wafers').append(waferRow(cfg, { name: `Wafer ${form.querySelector('.wafers').children.length + 1}`, map: maps[0] }));
  };
}

function fillChipForm(form, cfg, chip) {
  for (const k of ['internal_name', 'designation', 'technology', 'run', 'github', 'notes']) form.elements[k].value = chip[k];
  form.querySelector('.authors').replaceChildren(...chip.authors.map(a => authorRow(a)));
  form.querySelector('.wafers').replaceChildren(...chip.wafers.map(w => waferRow(cfg, w)));
  form.elements.technology.oninput();
}

function readChipForm(form) {
  const f = form.elements;
  return {
    internal_name: f.internal_name.value.trim(), designation: f.designation.value.trim(),
    technology: f.technology.value.trim(), run: f.run.value.trim(), github: f.github.value.trim(), notes: f.notes.value,
    authors: [...form.querySelectorAll('.authors input')].map(i => i.value.trim()).filter(Boolean),
    wafers: [...form.querySelector('.wafers').children].map(r => ({ id: r.dataset.id || undefined, name: r.children[0].value.trim(), map: r.children[1].value })),
  };
}
