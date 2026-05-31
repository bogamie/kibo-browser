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
}

function timeStr(ts) {
  try { return new Date(ts).toLocaleString('ko-KR'); } catch { return ''; }
}

async function renderHistory() {
  panelTitle.textContent = tr('panel_history');
  const list = await window.api.listHistory();
  panelBody.replaceChildren();
  panelBody.append(clearHeader('clearAll', () => { window.api.clearHistory(); renderHistory(); }));
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
  panelBody.append(clearHeader('clearList', () => { window.api.clearDownloads(); renderDownloads(); }));
  if (!list.length) { panelBody.append(emptyMsg(tr('noDownloads'))); return; }
  for (const d of list) panelBody.append(downloadRow(d));
}

function downloadRow(d) {
  const { row, main, u: sub } = listItemBase(d.filename);
  const pct = d.total > 0 ? Math.round((d.received / d.total) * 100) : 0;
  const human = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + 'MB' : Math.round(b / 1e3) + 'KB';
  if (d.state === 'progressing') sub.textContent = `${human(d.received)} / ${d.total > 0 ? human(d.total) : '?'} (${pct}%)`;
  else if (d.state === 'completed') sub.textContent = tr('dl_done', human(d.received));
  else sub.textContent = d.state === 'cancelled' ? tr('dl_cancelled') : tr('dl_failed');
  if (d.state === 'completed') main.onclick = () => window.api.openDownload(d.id);

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

// ---- small render helpers -------------------------------------------------
// Right-aligned header holding a single "clear all/list" button.
function clearHeader(labelKey, onClear) {
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:6px';
  const clear = document.createElement('button');
  clear.className = 'mini'; clear.textContent = tr(labelKey);
  clear.onclick = onClear;
  head.append(clear);
  return head;
}
// Shared skeleton for a `.list-item`: a `.main` wrapper holding a `.t` title line
// and a `.u` subtitle line, already appended (`main` -> row). Callers fill `.u`
// and add any trailing action buttons.
function listItemBase(titleText) {
  const row = document.createElement('div'); row.className = 'list-item';
  const main = document.createElement('div'); main.className = 'main';
  const t = document.createElement('div'); t.className = 't'; t.textContent = titleText;
  const u = document.createElement('div'); u.className = 'u';
  main.append(t, u); row.append(main);
  return { row, main, t, u };
}
function listRow({ title, url, meta, onOpen, onRemove }) {
  const { row, main, u } = listItemBase(title || url);
  u.textContent = url; main.onclick = onOpen;
  const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta || '';
  const del = document.createElement('button'); del.innerHTML = ICONS.close; del.title = tr('delete'); del.onclick = onRemove;
  row.append(m, del);
  return row;
}
function emptyMsg(text) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = text; return d; }
