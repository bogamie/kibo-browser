'use strict';

// ---------------------------------------------------------------------------
// Internal password manager (mybrowser://passwords), rendered as a real browser
// tab. Zen-style master/detail layout: a searchable, sortable account list on
// the left (search + add on one row, a sort dropdown + count below); the
// selected account on the right — clickable website, username + copy, password
// with show/hide + copy, and Edit/Delete in the header — plus add/edit forms
// with a strong-password generator. Talks to main
// only through the privileged passwords preload (window.api):
//   status() / list() / reveal(id) / remove(id) / save(cred) / update(id,cred) /
//   openSite(origin) / unlock(pw) / lock() / setMaster(pw) / disableMaster() /
//   onState(cb)
// Reuses the chrome's i18n layer (i18n.js); styling lives in passwords.html.
// ---------------------------------------------------------------------------

// ---- element refs ----------------------------------------------------------
const gate     = document.getElementById('pass-gate');
const split    = document.getElementById('pass-split');
const searchEl = document.getElementById('pass-search');
const addBtn   = document.getElementById('pass-add');
const sortByEl = document.getElementById('pass-sortby');
const sortSel  = document.getElementById('pass-sort');
const countEl  = document.getElementById('pass-count');
const noteEl   = document.getElementById('pass-note');
const listEl   = document.getElementById('pass-list');
const masterEl = document.getElementById('pass-master');
const rightEl  = document.getElementById('pass-right');
const detailEl = document.getElementById('pass-detail');

// Normalized vault status (status() and the state broadcast use different keys).
let vault = { available: true, osEncryption: true, hasMaster: false, locked: false };

// Last-fetched (masked) list + the UI state that must survive an onState
// re-render (search/sort/selection/open form).
let entries = [];
const ui = { query: '', sort: 'name-asc', selectedId: null, mode: 'view', draft: null, revealedId: null };
let maskTimer = null;

// ---- icons (the chrome's ICONS map isn't loaded on this page) --------------
function icon(paths) {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
const EYE     = icon('<path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>');
const EYEOFF  = icon('<path d="M2 2l12 12"/><path d="M6.2 6.3A2 2 0 0 0 8 10a2 2 0 0 0 1.7-.9"/><path d="M4 4.6C2.5 5.6 1.5 8 1.5 8s2.5 4.2 6.5 4.2c1 0 1.9-.2 2.7-.6M11.5 10.6c1.4-1 2.5-2.6 2.5-2.6S11.5 3.8 8 3.8c-.4 0-.8 0-1.1.1"/>');
const TRASH   = icon('<path d="M3.5 4.5h9"/><path d="M6.3 4.5V3.2h3.4v1.3"/><path d="M5 4.7l.5 8.1h5l.5-8.1"/>');
const COPY    = icon('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>');
const CHECK   = icon('<path d="M3.5 8.6l3 3 6-6.7"/>');
const PENCIL  = icon('<path d="M3 13l.6-2.6 6.8-6.8 2 2-6.8 6.8z"/><path d="M9.6 3.9l2 2"/>');
const PLUS    = icon('<path d="M8 3.5v9M3.5 8h9"/>');
const SEARCH  = icon('<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>');
const REFRESH = icon('<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7"/><path d="M13.5 2.6v3h-3"/>');
const GLOBE   = icon('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2.2 1.8 2.2 10.2 0 12M8 2c-2.2 1.8-2.2 10.2 0 12"/>');

// ---- small element helpers -------------------------------------------------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function noteMsg(t) { return el('div', 'note', t); }
function emptyMsg(t) { return el('div', 'empty', t); }
function iconSpan(svg) { const s = el('span', 'bi'); s.innerHTML = svg; return s; }
function passBtn(text, onclick, primary) {
  const b = el('button', 'mini' + (primary ? ' primary' : ''), text);
  b.type = 'button'; b.onclick = onclick;
  return b;
}
function iconBtn(svg, title, onclick) {
  const b = el('button', 'iconbtn'); b.type = 'button'; b.innerHTML = svg; b.title = title;
  if (onclick) b.onclick = onclick;
  return b;
}
// Transparent icon+label button (Edit / Delete).
function ghostBtn(svg, label, onclick) {
  const b = el('button', 'ghostbtn'); b.type = 'button';
  b.append(iconSpan(svg), document.createTextNode(label));
  if (onclick) b.onclick = onclick;
  return b;
}
function passInput(ph) {
  const i = el('input', 'passinput');
  i.type = 'password'; i.placeholder = ph; i.autocapitalize = 'off'; i.spellcheck = false;
  return i;
}
function formInput(type, ph, value) {
  const i = el('input', 'passinput');
  i.type = type; i.placeholder = ph; i.value = value || '';
  i.autocapitalize = 'off'; i.spellcheck = false; i.autocomplete = 'off';
  return i;
}
function originHost(origin) { try { return new URL(origin).host || origin; } catch { return origin; } }
function clearMask() { if (maskTimer) { clearTimeout(maskTimer); maskTimer = null; } }

// ---- favicons --------------------------------------------------------------
// Per-host cache of the site's own favicon as a data: URI (fetched by main over
// the profile session). The list re-renders on every onState, so we cache the
// fetch Promise per host (awaiting a settled Promise is free, so this both
// dedups in-flight requests and serves later renders without re-hitting main).
// Resolves to a data-URI string or null; the GLOBE placeholder stays until a
// real favicon arrives.
const favCache = new Map();

async function applyFavicon(iconEl, origin) {
  let host;
  try { host = new URL(origin).host; } catch { return; }
  if (!host) return;
  let p = favCache.get(host);
  if (!p) {
    // Wrap so a rejected invoke can't break rendering.
    p = window.api.favicon(origin).catch(() => null);
    favCache.set(host, p);
  }
  const val = await p;
  if (val) {
    iconEl.innerHTML = '<img class="favicon" src="' + val + '" alt="" />';
    const img = iconEl.querySelector('img');
    if (img) img.onerror = () => { iconEl.innerHTML = GLOBE; }; // bad/non-image → globe
  }
}

// Mirror main.js toOrigin() so we can find the resulting entry after an add.
function normOrigin(input) {
  let s = (input || '').trim(); if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch { return null; }
}

// ---- left column: search / sort / list -------------------------------------
const SORT_OPTS = [
  ['name-asc', 'pass_sortNameAsc'], ['name-desc', 'pass_sortNameDesc'],
  ['user-asc', 'pass_sortUserAsc'], ['user-desc', 'pass_sortUserDesc'],
  ['modified', 'pass_sortModified'],
];

function sortRows(rows, sort) {
  const a = rows.slice();
  const byName = (x, y) => originHost(x.origin).localeCompare(originHost(y.origin));
  const byUser = (x, y) => {
    const xu = x.username || '', yu = y.username || '';
    if (!xu && yu) return 1;
    if (xu && !yu) return -1;
    return xu.localeCompare(yu);
  };
  switch (sort) {
    case 'name-desc': a.sort((x, y) => byName(y, x)); break;
    case 'user-asc': a.sort((x, y) => byUser(x, y) || byName(x, y)); break;
    case 'user-desc': a.sort((x, y) => byUser(y, x) || byName(x, y)); break;
    case 'modified': a.sort((x, y) => (y.ts || 0) - (x.ts || 0) || byName(x, y)); break;
    default: a.sort((x, y) => byName(x, y) || byUser(x, y)); break; // name-asc
  }
  return a;
}

function accountRow(c) {
  const row = el('div', 'pass-row' + (c.id === ui.selectedId ? ' selected' : ''));
  const ico = el('span', 'ico'); ico.innerHTML = GLOBE; row.append(ico);
  const main = el('div', 'main');
  main.append(el('div', 't', originHost(c.origin)), el('div', 'u', c.username || tr('pass_noUsername')));
  row.append(main);
  row.onclick = () => selectEntry(c.id);
  applyFavicon(ico, c.origin); // swap the globe for the site's own favicon (cache hit = instant)
  return row;
}

function selectEntry(id) {
  ui.selectedId = id; ui.mode = 'view'; ui.revealedId = null; clearMask();
  renderLeft(); renderRight();
}

function updateCount() { if (countEl) countEl.textContent = tr('pass_count', entries.length); }

async function renderLeft(prefetched) {
  entries = prefetched || (await window.api.list()) || [];
  updateCount();
  const q = ui.query.trim().toLowerCase();
  let rows = q
    ? entries.filter((c) => (c.origin || '').toLowerCase().includes(q) || (c.username || '').toLowerCase().includes(q))
    : entries.slice();
  rows = sortRows(rows, ui.sort);
  listEl.replaceChildren();
  if (!entries.length) listEl.append(emptyMsg(tr('noPasswords')));
  else if (!rows.length) listEl.append(emptyMsg(tr('pass_noResults')));
  else for (const c of rows) listEl.append(accountRow(c));
}

function buildSortOptions() {
  sortSel.replaceChildren();
  for (const [val, key] of SORT_OPTS) {
    const o = el('option'); o.value = val; o.textContent = tr(key);
    sortSel.append(o);
  }
  sortSel.value = ui.sort;
}

// ---- right column: detail / add / edit -------------------------------------
function renderRight() {
  clearMask();
  detailEl.replaceChildren();
  if (ui.mode === 'add' || ui.mode === 'edit') { detailEl.append(formView()); return; }
  const c = entries.find((x) => x.id === ui.selectedId);
  if (!c) { detailEl.append(emptyMsg(tr('pass_selectHint'))); return; }
  detailEl.append(detailView(c));
}

function field2(labelKey, rowNodes) {
  const f = el('div', 'pass-field2');
  f.append(el('div', 'lbl', tr(labelKey)));
  const row = el('div', 'row');
  for (const n of rowNodes) if (n) row.append(n);
  f.append(row);
  return f;
}

async function copyToClip(btn, getText) {
  let text;
  try { text = await getText(); } catch { return; }
  if (text == null || text === '') return;
  try { await navigator.clipboard.writeText(text); } catch { return; }
  const prev = btn.innerHTML;
  btn.classList.add('ok');
  btn.replaceChildren(iconSpan(CHECK), document.createTextNode(tr('pass_copied')));
  setTimeout(() => { btn.classList.remove('ok'); btn.innerHTML = prev; }, 1000);
}
function copyBtn(getText) {
  const b = el('button', 'copybtn'); b.type = 'button';
  b.append(iconSpan(COPY), document.createTextNode(tr('pass_copy')));
  b.onclick = () => copyToClip(b, getText);
  return b;
}

function deleteControl(c) {
  // Width-stable confirm: both labels share one grid cell so the wider of
  // "Delete" / "Delete?" always reserves the width — toggling to the confirm
  // state never changes the button's size, so the Edit button can't shift.
  const btn = el('button', 'ghostbtn'); btn.type = 'button';
  btn.append(iconSpan(TRASH));
  const stack = el('span', 'lblstack');
  stack.append(el('span', 'l', tr('delete')), el('span', 'l', tr('pass_deleteConfirm')));
  btn.append(stack);
  let armed = false, t = null;
  const reset = () => { armed = false; if (t) { clearTimeout(t); t = null; } btn.classList.remove('confirming'); };
  btn.onclick = () => {
    if (!armed) { armed = true; btn.classList.add('confirming'); t = setTimeout(reset, 3000); return; }
    if (t) clearTimeout(t);
    window.api.remove(c.id);
    ui.selectedId = null; ui.mode = 'view'; clearMask();
    renderLeft(); renderRight();
  };
  return btn;
}

function detailView(c) {
  const box = el('div');

  // header: globe + site title, Edit/Delete pushed right
  const head = el('div', 'pass-detail-head');
  const hico = el('span', 'ico'); hico.innerHTML = GLOBE; head.append(hico);
  applyFavicon(hico, c.origin); // same favicon as the list row, shown larger
  head.append(el('div', 'title', originHost(c.origin)));
  const ha = el('div', 'head-actions');
  ha.append(ghostBtn(PENCIL, tr('pass_edit'), () => startEdit(c)), deleteControl(c));
  head.append(ha);
  box.append(head);

  // website (clickable → open in a normal tab)
  const site = el('a', 'val link'); site.textContent = c.origin; site.href = '#';
  site.title = tr('pass_open');
  site.onclick = (e) => { e.preventDefault(); window.api.openSite(c.origin); };
  box.append(field2('pass_fieldSite', [site]));

  // username + copy
  const user = el('div', 'val', c.username || tr('pass_noUsername'));
  box.append(field2('pass_fieldUser', [user, c.username ? copyBtn(() => c.username) : null]));

  // password: masked by default; reveal via reveal(id), auto-mask after 10s; copy
  const pw = el('div', 'val mono', '••••••••');
  const eye = iconBtn(EYE, tr('pass_show'));
  eye.onclick = async () => {
    if (ui.revealedId === c.id) {
      clearMask(); ui.revealedId = null;
      pw.textContent = '••••••••';
      eye.innerHTML = EYE; eye.title = tr('pass_show');
      return;
    }
    const full = await window.api.reveal(c.id);
    if (!full) return;
    ui.revealedId = c.id; pw.textContent = full.password;
    eye.innerHTML = EYEOFF; eye.title = tr('pass_hide');
    clearMask();
    maskTimer = setTimeout(() => {
      maskTimer = null;
      if (ui.revealedId !== c.id) return;
      ui.revealedId = null; pw.textContent = '••••••••';
      eye.innerHTML = EYE; eye.title = tr('pass_show');
    }, 10000);
  };
  const pwCopy = copyBtn(async () => { const full = await window.api.reveal(c.id); return full && full.password; });
  box.append(field2('pass_fieldPass', [pw, eye, pwCopy]));

  return box;
}

// ---- add / edit form -------------------------------------------------------
function defaultGen() {
  return { len: 16, upper: true, lower: true, digit: true, symbol: true, symbols: '!@#$%^&*-_=+' };
}
function startAdd() {
  ui.mode = 'add'; ui.selectedId = null; ui.revealedId = null; clearMask();
  ui.draft = { id: null, origin: '', username: '', password: '', gen: defaultGen() };
  renderLeft(); renderRight();
}
async function startEdit(c) {
  let pw = '';
  const full = await window.api.reveal(c.id); // pre-fill the real password
  if (full) pw = full.password;
  ui.mode = 'edit'; ui.selectedId = c.id; ui.revealedId = null; clearMask();
  ui.draft = { id: c.id, origin: c.origin, username: c.username || '', password: pw, gen: defaultGen() };
  renderRight();
}

// label + input wrapper used by each add/edit form field.
function formField(labelKey, inputNode) {
  const f = el('div', 'field');
  f.append(el('label', null, tr(labelKey)), inputNode);
  return f;
}

function formView() {
  const d = ui.draft;
  const box = el('div', 'pass-form');
  const head = el('div', 'pass-detail-head');
  head.append(el('div', 'title', tr(ui.mode === 'add' ? 'pass_addTitle' : 'pass_editTitle')));
  box.append(head);

  const siteIn = formInput('text', tr('pass_sitePh'), d.origin);
  siteIn.oninput = () => { d.origin = siteIn.value; };
  box.append(formField('pass_fieldSite', siteIn));

  const userIn = formInput('text', tr('pass_userPh'), d.username);
  userIn.oninput = () => { d.username = userIn.value; };
  box.append(formField('pass_fieldUser', userIn));

  const pwIn = formInput('text', tr('pass_passPh'), d.password); pwIn.classList.add('mono');
  pwIn.oninput = () => { d.password = pwIn.value; };
  const pwEye = iconBtn(EYEOFF, tr('pass_hide'));
  pwEye.onclick = () => {
    const hide = pwIn.type === 'text';
    pwIn.type = hide ? 'password' : 'text';
    pwEye.innerHTML = hide ? EYE : EYEOFF;
    pwEye.title = hide ? tr('pass_show') : tr('pass_hide');
  };
  const pwWrap = el('div', 'pass-pwwrap');
  pwWrap.append(pwIn, pwEye);
  box.append(formField('pass_fieldPass', pwWrap));

  box.append(generatorPanel(pwIn));

  const err = el('div', 'err');
  box.append(err);
  const actions = el('div', 'passactions');
  actions.append(
    passBtn(tr('pass_cancel'), () => { ui.mode = 'view'; renderRight(); }),
    passBtn(tr('pass_save'), () => submitForm(siteIn, userIn, pwIn, err), true),
  );
  box.append(actions);

  setTimeout(() => (ui.mode === 'add' ? siteIn : pwIn).focus(), 0);
  return box;
}

async function submitForm(siteIn, userIn, pwIn, err) {
  const origin = siteIn.value.trim();
  const username = userIn.value.trim();
  const password = pwIn.value;
  if (!origin) { err.textContent = tr('pass_errSite'); siteIn.focus(); return; }
  if (!password) { err.textContent = tr('pass_errPass'); pwIn.focus(); return; }

  const list = ui.mode === 'add'
    ? await window.api.save({ origin, username, password })
    : await window.api.update(ui.draft.id, { origin, username, password });
  if (!list) { err.textContent = tr('pass_errSave'); return; }

  entries = list;
  let sel;
  if (ui.mode === 'edit') {
    sel = ui.draft.id;
  } else {
    const norm = normOrigin(origin);
    const m = list.find((x) => x.origin === norm && (x.username || '') === username);
    sel = m ? m.id : (list[0] && list[0].id);
  }
  ui.mode = 'view'; ui.selectedId = sel != null ? sel : null; ui.revealedId = null;
  renderLeft(list); renderRight();
}

// ---- strong-password generator ---------------------------------------------
const SET_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const SET_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SET_DIGIT = '0123456789';

// Uniform random integer in [0, max) via rejection sampling (no modulo bias).
function randInt(max) {
  const a = new Uint32Array(1);
  const lim = Math.floor(0xFFFFFFFF / max) * max;
  do { crypto.getRandomValues(a); } while (a[0] >= lim);
  return a[0] % max;
}

function generate(gen) {
  const sets = [];
  if (gen.lower) sets.push(SET_LOWER);
  if (gen.upper) sets.push(SET_UPPER);
  if (gen.digit) sets.push(SET_DIGIT);
  if (gen.symbol && gen.symbols) {
    const syms = [...new Set([...gen.symbols].filter((ch) => ch.trim()))].join('');
    if (syms) sets.push(syms);
  }
  if (!sets.length) return '';
  const pool = sets.join('');
  const n = Math.max(4, Math.min(64, gen.len | 0));
  const out = [];
  for (const s of sets) if (out.length < n) out.push(s[randInt(s.length)]); // ≥1 per selected set
  while (out.length < n) out.push(pool[randInt(pool.length)]);
  for (let i = out.length - 1; i > 0; i--) { const j = randInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}

function generatorPanel(pwIn) {
  const g = ui.draft.gen;
  const wrap = el('div', 'pass-gen');
  const regen = () => { const pw = generate(g); ui.draft.password = pw; pwIn.value = pw; if (pwIn.type !== 'text') pwIn.type = 'text'; };

  const top = el('div', 'pass-gen-top');
  top.append(el('span', 'lbl', tr('pass_gen')));
  top.append(iconBtn(REFRESH, tr('pass_regenerate'), regen));
  wrap.append(top);

  const lenRow = el('div', 'pass-gen-len');
  lenRow.append(el('span', 'lbl', tr('pass_genLen')));
  const range = el('input'); range.type = 'range'; range.min = '4'; range.max = '64'; range.value = String(g.len);
  const num = el('span', 'num', String(g.len));
  range.oninput = () => { g.len = parseInt(range.value, 10) || g.len; num.textContent = String(g.len); regen(); };
  lenRow.append(range, num);
  wrap.append(lenRow);

  const classes = el('div', 'pass-gen-classes');
  const symsInput = el('input', 'pass-gen-syms');
  const toggles = [
    ['upper', 'pass_genUpper'], ['lower', 'pass_genLower'],
    ['digit', 'pass_genDigit'], ['symbol', 'pass_genSymbol'],
  ];
  const boxes = {};
  for (const [key, label] of toggles) {
    const chip = el('label', 'pass-chip');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!g[key];
    boxes[key] = cb;
    cb.onchange = () => {
      const others = toggles.some(([k]) => k !== key && boxes[k].checked);
      if (!cb.checked && !others) { cb.checked = true; return; } // keep at least one
      g[key] = cb.checked;
      if (key === 'symbol') symsInput.disabled = !cb.checked;
      regen();
    };
    chip.append(cb, document.createTextNode(tr(label)));
    classes.append(chip);
  }
  wrap.append(classes);

  symsInput.value = g.symbols; symsInput.placeholder = tr('pass_genSymbolsPh');
  symsInput.disabled = !g.symbol;
  symsInput.oninput = () => { g.symbols = symsInput.value; regen(); };
  wrap.append(symsInput);

  return wrap;
}

// ---- master-password controls (vault lock) ---------------------------------
function masterButtons() {
  if (vault.hasMaster) {
    return [
      passBtn(tr('pass_lockNow'), () => { window.api.lock(); vault.locked = true; render(); }),
      passBtn(tr('pass_masterOff'), async () => { await window.api.disableMaster(); vault.hasMaster = false; render(); }),
    ];
  }
  return [passBtn(tr('pass_masterOn'), showSetMaster)];
}

function unlockForm() {
  const box = el('div', 'passform');
  const input = passInput(tr('pass_masterPh'));
  const err = el('div', 'err');
  const submit = async () => {
    const ok = await window.api.unlock(input.value);
    if (ok) { vault.locked = false; return render(); }
    err.textContent = tr('pass_wrong'); input.value = ''; input.focus();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  box.append(noteMsg(tr('pass_lockedNote')), input, err, passBtn(tr('pass_unlock'), submit, true));
  showGate([box]);
  setTimeout(() => input.focus(), 0);
}

function showSetMaster() {
  const box = el('div', 'passform');
  const p1 = passInput(tr('pass_masterNew')), p2 = passInput(tr('pass_masterConfirm'));
  const err = el('div', 'err');
  const save = async () => {
    if (!p1.value || p1.value !== p2.value) { err.textContent = tr('pass_masterMismatch'); return; }
    const ok = await window.api.setMaster(p1.value);
    if (ok) { vault.hasMaster = true; vault.locked = false; return render(); }
    err.textContent = tr('pass_masterFail');
  };
  const actions = el('div', 'passactions');
  actions.append(passBtn(tr('pass_cancel'), render), passBtn(tr('pass_masterSave'), save, true));
  box.append(noteMsg(tr('pass_masterSetNote')), p1, p2, err, actions);
  showGate([box]);
  setTimeout(() => p1.focus(), 0);
}

// ---- top-level render ------------------------------------------------------
function showGate(nodes) {
  split.hidden = true;
  gate.hidden = false;
  gate.replaceChildren(...nodes);
}
function hideGate() {
  gate.hidden = true; gate.replaceChildren();
  split.hidden = false;
}

function renderLeftChrome() {
  masterEl.replaceChildren(...masterButtons());
  noteEl.replaceChildren();
  if (!vault.osEncryption && !vault.hasMaster) noteEl.append(noteMsg(tr('pass_noteNoKeyring')));
}

function render() {
  clearMask();
  if (!vault.available) { // incognito — vault never persists
    showGate([noteMsg(tr('pass_noteIncognito')), emptyMsg(tr('noPasswords'))]);
    return;
  }
  if (vault.locked) { unlockForm(); return; } // master set but not unlocked
  hideGate();
  renderLeftChrome();
  renderLeft();
  renderRight();
}

// ---- language + state ------------------------------------------------------
function applyLang(lang) {
  const l = (lang === 'ko') ? 'ko' : 'en';
  if (l === getLang()) return false;
  setLang(l);
  document.documentElement.lang = l;
  return true;
}
function updateChrome() {
  applyStaticI18n();
  searchEl.value = ui.query;
  sortByEl.textContent = tr('pass_sortBy') + ':';
  buildSortOptions();
  addBtn.innerHTML = PLUS; addBtn.title = tr('pass_add');
  document.title = tr('panel_passwords');
  updateCount();
}

// Live updates from main. broadcastState fires after EVERY mutation (including
// our own), so preserve the UI: only force a full re-render on a vault state
// transition; otherwise refresh the list + reconcile, leaving an open form.
window.api.onState((s) => {
  const langChanged = s.settings && s.settings.lang ? applyLang(s.settings.lang) : false;
  const prev = vault;
  vault = {
    available: s.vaultAvailable, osEncryption: s.osEncryption,
    hasMaster: s.vaultHasMaster, locked: s.vaultLocked,
  };
  const transition = prev.available !== vault.available || prev.locked !== vault.locked || prev.hasMaster !== vault.hasMaster;
  if (langChanged) updateChrome();
  if (transition || !vault.available || vault.locked) { ui.mode = 'view'; render(); return; }
  hideGate();
  renderLeftChrome();
  renderLeft().then(() => {
    if (ui.mode !== 'view') return; // leave an open add/edit form untouched
    if (ui.selectedId != null && !entries.some((c) => c.id === ui.selectedId)) ui.selectedId = null;
    renderRight();
  });
});

// ---- bootstrap -------------------------------------------------------------
searchEl.oninput = () => { ui.query = searchEl.value; renderLeft(); };
sortSel.onchange = () => { ui.sort = sortSel.value; renderLeft(); };
addBtn.onclick = startAdd;
document.getElementById('pass-search-ico').innerHTML = SEARCH;

(async () => {
  try {
    const s = await window.api.status();
    if (s) {
      setLang(s.lang === 'ko' ? 'ko' : 'en');
      document.documentElement.lang = getLang();
      vault = { available: s.available, osEncryption: s.osEncryption, hasMaster: s.hasMaster, locked: s.locked };
    }
  } catch { /* keep defaults; onState will fill in */ }
  updateChrome();
  render();
})();

// Thin overlay scrollbars for the two independent scroll containers.
overlayScrollbar(listEl);
overlayScrollbar(rightEl);
