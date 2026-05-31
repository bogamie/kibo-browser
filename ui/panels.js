'use strict';

// ---------------------------------------------------------------------------
// Full-window overlay panels: history / downloads / passwords.
// (Settings is no longer a panel — it opens as a real tab; see ui/settings.js.)
// Each render* function fills #panelbody for the matching panel kind.
// Depends on dom.js globals (panel, panelTitle, panelBody, ICONS, state) and
// i18n.js (tr / getLang).
// ---------------------------------------------------------------------------
$('#panelclose').onclick = () => closePanel();

function closePanel() { panel.hidden = true; panel.dataset.kind = ''; reportLayout(); }

async function openPanel(kind) {
  panel.dataset.kind = kind;
  panel.hidden = false;
  reportLayout();
  if (kind === 'history') await renderHistory();
  else if (kind === 'downloads') await renderDownloads();
  else if (kind === 'passwords') await renderPasswords();
}

function timeStr(ts) {
  try { return new Date(ts).toLocaleString('ko-KR'); } catch { return ''; }
}

async function renderHistory() {
  panelTitle.textContent = tr('panel_history');
  const list = await window.api.listHistory();
  panelBody.replaceChildren();
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:6px';
  const clear = document.createElement('button');
  clear.className = 'mini'; clear.textContent = tr('clearAll');
  clear.onclick = () => { window.api.clearHistory(); renderHistory(); };
  head.append(clear); panelBody.append(head);
  if (!list.length) { panelBody.append(emptyMsg(tr('noHistory'))); return; }
  for (const h of list) {
    panelBody.append(listRow({
      title: h.title, url: h.url, meta: timeStr(h.ts),
      onOpen: () => { window.api.newTab(h.url); closePanel(); },
      onRemove: () => { window.api.removeHistory(h.id); renderHistory(); },
    }));
  }
}

async function renderDownloads() {
  panelTitle.textContent = tr('panel_downloads');
  const list = await window.api.listDownloads();
  panelBody.replaceChildren();
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:6px';
  const clear = document.createElement('button');
  clear.className = 'mini'; clear.textContent = tr('clearList');
  clear.onclick = () => { window.api.clearDownloads(); renderDownloads(); };
  head.append(clear); panelBody.append(head);
  if (!list.length) { panelBody.append(emptyMsg(tr('noDownloads'))); return; }
  for (const d of list) panelBody.append(downloadRow(d));
}

function downloadRow(d) {
  const row = document.createElement('div');
  row.className = 'list-item';
  const main = document.createElement('div'); main.className = 'main';
  const t = document.createElement('div'); t.className = 't'; t.textContent = d.filename;
  const sub = document.createElement('div'); sub.className = 'u';
  const pct = d.total > 0 ? Math.round((d.received / d.total) * 100) : 0;
  const human = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + 'MB' : Math.round(b / 1e3) + 'KB';
  if (d.state === 'progressing') sub.textContent = `${human(d.received)} / ${d.total > 0 ? human(d.total) : '?'} (${pct}%)`;
  else if (d.state === 'completed') sub.textContent = tr('dl_done', human(d.received));
  else sub.textContent = d.state === 'cancelled' ? tr('dl_cancelled') : tr('dl_failed');
  main.append(t, sub);
  if (d.state === 'completed') main.onclick = () => window.api.openDownload(d.id);
  row.append(main);

  if (d.state === 'progressing') {
    const cancel = document.createElement('button'); cancel.innerHTML = ICONS.close;
    cancel.title = tr('dl_cancel'); cancel.onclick = () => window.api.cancelDownload(d.id);
    row.append(cancel);
  } else if (d.state === 'completed') {
    const folder = document.createElement('button'); folder.innerHTML = ICONS.folder;
    folder.title = tr('dl_showInFolder'); folder.style.color = 'var(--accent)';
    folder.onclick = () => window.api.revealDownload(d.id);
    row.append(folder);
  }
  return row;
}

async function renderPasswords() {
  panelTitle.textContent = tr('panel_passwords');
  const list = await window.api.listPasswords();
  panelBody.replaceChildren();
  if (!state.vaultAvailable) panelBody.append(noteMsg(tr('pass_noteIncognito')));
  else if (!state.osEncryption) panelBody.append(noteMsg(tr('pass_noteNoKeyring')));
  if (!list || !list.length) { panelBody.append(emptyMsg(tr('noPasswords'))); return; }
  for (const c of list) panelBody.append(passwordRow(c));
}

function passwordRow(c) {
  const row = document.createElement('div');
  row.className = 'list-item';
  const main = document.createElement('div'); main.className = 'main';
  const t = document.createElement('div'); t.className = 't'; t.textContent = c.origin;
  const u = document.createElement('div'); u.className = 'u';
  u.textContent = `${c.username || tr('pass_noUsername')} · ${c.password}`;
  main.append(t, u); row.append(main);

  const show = document.createElement('button'); show.innerHTML = ICONS.eye; show.title = tr('pass_show');
  show.style.color = 'var(--accent)';
  let shown = false;
  show.onclick = async () => {
    shown = !shown;
    if (shown) { const full = await window.api.revealPassword(c.id); if (full) u.textContent = `${c.username || tr('pass_noUsername')} · ${full.password}`; }
    else u.textContent = `${c.username || tr('pass_noUsername')} · ••••••••`;
  };
  const del = document.createElement('button'); del.innerHTML = ICONS.trash; del.title = tr('delete');
  del.onclick = () => { window.api.removePassword(c.id); renderPasswords(); };
  row.append(show, del);
  return row;
}

// ---- small render helpers -------------------------------------------------
function listRow({ title, url, meta, onOpen, onRemove }) {
  const row = document.createElement('div'); row.className = 'list-item';
  const main = document.createElement('div'); main.className = 'main';
  const t = document.createElement('div'); t.className = 't'; t.textContent = title || url;
  const u = document.createElement('div'); u.className = 'u'; u.textContent = url;
  main.append(t, u); main.onclick = onOpen;
  const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta || '';
  const del = document.createElement('button'); del.innerHTML = ICONS.closeSm; del.title = tr('delete'); del.onclick = onRemove;
  row.append(main, m, del);
  return row;
}
function emptyMsg(text) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = text; return d; }
function noteMsg(text) { const d = document.createElement('div'); d.className = 'note'; d.textContent = text; return d; }
