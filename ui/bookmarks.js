'use strict';

// ---------------------------------------------------------------------------
// Bookmark bar: chips + folders, drag & drop (reorder / file into folders /
// drop onto tabs or the page), the Chrome-style add/edit bubble and folder
// chooser dialog, the folder dropdown, and the right-click context menus.
// Depends on the globals in dom.js (elements, ICONS, state, reportLayout,
// escapeHtml, showToast/notImplemented, faviconFail) and i18n.js (tr).
// ---------------------------------------------------------------------------

// Children of a folder (null = bar root) as one ordered list — folders and
// bookmarks interleaved by their `order` field.
function bmChildren(parentId) {
  const p = parentId ?? null;
  const items = [
    ...(state.bookmarkFolders || []).filter((f) => (f.parentId ?? null) === p).map((item) => ({ kind: 'folder', item })),
    ...(state.bookmarks || []).filter((b) => (b.parentId ?? null) === p).map((item) => ({ kind: 'bookmark', item })),
  ];
  return items.sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0));
}

// Top-level bar items in order, plus the tail that doesn't fit. The bar never
// scrolls horizontally (Chrome-style): chips that overflow are hidden and listed
// in the » overflow menu instead.
let bmBarItems = [];
let bmOverflowItems = [];

const overflowBtn = document.createElement('button');
overflowBtn.className = 'bm-overflow';
overflowBtn.hidden = true;
overflowBtn.innerHTML = svgIcon('<path d="M4 4l4 4-4 4M9 4l4 4-4 4"/>'); // »
overflowBtn.onclick = (e) => { e.stopPropagation(); toggleOverflowPop(); };

function renderBookmarks() {
  bookmarkbar.replaceChildren();
  bmBarItems = bmChildren(null);
  for (const { kind, item } of bmBarItems) {
    bookmarkbar.append(kind === 'folder' ? makeFolderChip(item) : makeBookmarkChip(item));
  }
  if (bmBarItems.length) { overflowBtn.title = tr('bm_more'); bookmarkbar.append(overflowBtn); }
  reportLayout();
  reflowBookmarks();
}

// Hide the chips that don't fit and surface them through the » button. Chips are
// left-packed, so the overflow is always a suffix — find the first chip whose
// right edge passes the bar (minus the » button's reserved space) and cut there.
function reflowBookmarks() {
  const chips = [...bookmarkbar.querySelectorAll('.bm')];
  if (!chips.length) { overflowBtn.hidden = true; bmOverflowItems = []; return; }
  for (const c of chips) c.style.display = '';
  overflowBtn.hidden = true;
  const rightEdge = bookmarkbar.getBoundingClientRect().right - 10; // minus right padding
  if (chips[chips.length - 1].getBoundingClientRect().right <= rightEdge + 0.5) {
    bmOverflowItems = [];
    if (!bmoverflowpop.hidden) closeOverflowPop();
    return;
  }
  overflowBtn.hidden = false;
  const limit = rightEdge - overflowBtn.getBoundingClientRect().width - 4;
  let cut = chips.length;
  for (let i = 0; i < chips.length; i++) {
    if (chips[i].getBoundingClientRect().right > limit) { cut = i; break; }
  }
  for (let i = cut; i < chips.length; i++) chips[i].style.display = 'none';
  bmOverflowItems = bmBarItems.slice(cut);
  if (!bmoverflowpop.hidden) renderOverflowPop();   // keep an open menu in sync
}
// Recompute when the window (hence the bar) changes width. Coalesce the burst of
// resize events into one reflow per frame — reflowBookmarks reads layout, so
// running it per event would force a reflow on every pixel of a drag-resize.
let reflowRaf = 0;
window.addEventListener('resize', () => {
  if (reflowRaf) return;
  reflowRaf = requestAnimationFrame(() => { reflowRaf = 0; reflowBookmarks(); });
});

function toggleOverflowPop() { if (bmoverflowpop.hidden) openOverflowPop(); else closeOverflowPop(); }
function openOverflowPop() {
  closeFolderPop(); closeCtx();
  if (!bmedit.hidden) { commitName(); closeBookmarkEditor(); }
  renderOverflowPop();
  bmoverflowpop.hidden = false;
  // Right-align under the » button (it sits at the bar's right edge).
  const r = overflowBtn.getBoundingClientRect();
  bmoverflowpop.style.top = Math.round(r.bottom + 4) + 'px';
  bmoverflowpop.style.left = Math.max(4, Math.round(r.right - bmoverflowpop.getBoundingClientRect().width)) + 'px';
  reportLayout();
}
function closeOverflowPop() {
  if (bmoverflowpop.hidden) return;
  bmoverflowpop.hidden = true;
  reportLayout();
}
function renderOverflowPop() {
  bmoverflowpop.replaceChildren();
  const mk = (html, onClick) => {
    const b = document.createElement('button');
    b.className = 'menuitem';
    b.innerHTML = html;
    b.onclick = onClick;
    bmoverflowpop.append(b);
    return b;
  };
  for (const { kind, item } of bmOverflowItems) {
    if (kind === 'folder') {
      mk(`<span class="ico">${ICONS.folder}</span><span>${escapeHtml(item.title)}</span><span class="arrow">›</span>`,
        (e) => { e.stopPropagation(); closeOverflowPop(); openFolderPop(item.id, overflowBtn); });
    } else {
      const row = mk(`${favIco(item.favicon)}<span>${escapeHtml(item.title || item.url)}</span>`,
        () => { window.api.go(item.url); closeOverflowPop(); });
      wireBgTabAux(row, item.url, closeOverflowPop);
    }
  }
}
// Outside-click / Escape dismiss the overflow menu (capture phase, like bmctx).
document.addEventListener('click', (e) => {
  if (!bmoverflowpop.hidden && !bmoverflowpop.contains(e.target)
      && e.target !== overflowBtn && !overflowBtn.contains(e.target)) closeOverflowPop();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverflowPop(); }, true);

// A bookmark row's leading favicon as an HTML string (globe fallback), in the
// menu/overflow `.ico` slot. Bar chips build the icon as a `.fico` element instead.
function favIco(favicon) {
  const fav = pickFavicon(favicon);
  return `<span class="ico">${fav ? faviconImg(fav, { draggable: false }) : ICONS.globe}</span>`;
}
// Middle-click → open the url in a background tab (focus stays put). `after` runs
// afterwards, e.g. to close the menu the row lives in.
function wireBgTabAux(el, url, after) {
  el.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    window.api.newBackgroundTab(url);
    after?.();
  });
}

function makeBookmarkChip(b) {
  const el = document.createElement('div');
  el.className = 'bm';
  el.title = b.title || b.url;
  const ico = document.createElement('span');
  ico.className = 'fico';
  const fav = pickFavicon(b.favicon);
  ico.innerHTML = fav ? faviconImg(fav, { draggable: false }) : ICONS.globe;
  const t = document.createElement('span');
  t.className = 'lbl';
  t.textContent = b.title || b.url;
  el.append(ico, t);
  el.onclick = () => window.api.go(b.url);
  wireBgTabAux(el, b.url);   // middle-click → background tab
  el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); openBookmarkCtx(e, b); };
  makeChipDraggable(el, b.id, 'bookmark', b.url);
  return el;
}

// Bookmark favicons that fail to load fall back to the globe icon — on the bar
// itself and inside the folder dropdown (helper in dom.js).
wireFaviconFallback(bookmarkbar, '.fico', ICONS.globe);
wireFaviconFallback(bmfolderpop, '.ico', ICONS.globe);
wireFaviconFallback(bmoverflowpop, '.ico', ICONS.globe);

function makeFolderChip(f) {
  const el = document.createElement('div');
  el.className = 'bm folder';
  el.title = f.title;
  const ico = document.createElement('span');
  ico.className = 'fico';
  ico.innerHTML = ICONS.folder;
  const t = document.createElement('span');
  t.className = 'lbl';
  t.textContent = f.title;
  el.append(ico, t);
  el.onclick = (e) => { e.stopPropagation(); openFolderPop(f.id, el); };
  el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); openFolderCtx(e, f, el); };
  makeChipDraggable(el, f.id, 'folder');
  return el;
}

// ---------------------------------------------------------------------------
// Bookmark-bar drag & drop: reorder chips, or drop onto a folder to file it in.
// ---------------------------------------------------------------------------
let dragItem = null;            // { id, kind } currently being dragged
let dragPreview = null;         // floating icon+label that follows the cursor
const dropLine = document.createElement('div');
dropLine.className = 'bm-drop-line';
// 1x1 transparent GIF used to suppress the (opaque-on-Wayland) drag image.
const DRAG_BLANK = new Image();
DRAG_BLANK.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Place the floating preview at the cursor. Done synchronously (no rAF) so
// there's no extra frame of latency — native DnD already throttles dragover.
function moveDragPreview(clientX, clientY) {
  if (dragPreview) dragPreview.style.transform = `translate(${clientX}px, ${clientY}px) translate(-50%, -50%)`;
}
// Capture phase: the open folder dropdown stopPropagation()s its own dragover,
// so a bubble-phase listener would freeze the preview while the cursor is over it.
// This also fires for the whole window (bar, dropdown, page), so it's the single
// place to spring-close a folder once the cursor leaves its region (chip+dropdown).
document.addEventListener('dragover', (e) => {
  moveDragPreview(e.clientX, e.clientY);
  if (springRegion && !inSpringRegion(e.clientX, e.clientY)) {
    closeFolderPop();   // clears springChip/springRegion; re-arms if a folder is re-entered
  }
}, true);

// Shared drag bootstrap for bar chips and folder-dropdown rows. previewNode is a
// `.bm` element that floats by the cursor — Wayland renders native drag images
// opaque (boxing the icon+label in black), so we suppress it with a blank image
// and move this real DOM node on each `drag`/`dragover` instead.
function startBmDrag(e, item, previewNode) {
  dragItem = item;
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/plain', item.url || String(item.id));
  e.dataTransfer.setDragImage(DRAG_BLANK, 0, 0);
  dragPreview = previewNode;
  dragPreview.classList.add('drag-float');
  // Position at the cursor before it paints — otherwise the preview flashes at
  // (0,0) (its default fixed position) until the first dragover moves it.
  moveDragPreview(e.clientX, e.clientY);
  document.body.appendChild(dragPreview);
  // Cover the whole window so drops onto the page (below the bar) reach us,
  // and disable the window-move regions so they don't stutter the drag.
  bmDragActive = true; reportLayout();
  document.body.classList.add('bm-dragging');
}
function endBmDrag() {
  dragItem = null;
  dragPreview?.remove();
  dragPreview = null;
  dragChips = null;
  dragBarRect = null;
  tabDrop = null;
  tabStripRect = null;
  tabDropTarget = null;
  document.body.classList.remove('bm-dragging');
  bmDragActive = false; reportLayout();
  // Close the dropdown if we spring-opened it, or if an item was pulled out of it
  // and dropped elsewhere (un-filed / opened) rather than reordered back inside.
  if (springOpened || (draggedFromPop && !droppedInPop)) closeFolderPop();
  else setSpringChip(null);   // dropdown stays open but the drag is over → drop the highlight
  springOpened = false; draggedFromPop = false; droppedInPop = false;
  clearDropHints();
  clearTabDropHints();
  clearDdDropLine();
}

function makeChipDraggable(el, id, kind, url) {
  el.draggable = true;
  // updateDropTarget() reads these to detect "drop into a folder" vs reorder.
  el.dataset.id = String(id);
  el.dataset.kind = kind;
  el.addEventListener('dragstart', (e) => {
    closeFolderPop();
    startBmDrag(e, { id, kind, url }, el.cloneNode(true));
    requestAnimationFrame(() => el.classList.add('dragging'));
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    endBmDrag();
  });
}

// Drag a row out of an open folder dropdown — drop on the bar to un-file it (the
// reverse of dropping a chip into a folder), or on the page to open it. Reuses
// the bar's drop targets via the shared dragItem/dropTarget machinery.
function makeFolderItemDraggable(el, kind, item) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    draggedFromPop = true;   // started inside the dropdown → close it if pulled out
    startBmDrag(e, { id: item.id, kind, url: item.url }, bmDragPreview(kind, item));
    // Keep the dropdown open during the drag so it can be reordered in place;
    // it sits below the bar, so dropping back onto the bar (to un-file) and
    // onto the page (to open) still work.
  });
  el.addEventListener('dragend', endBmDrag);
}

// Compact chip-style float for a row being dragged out of a folder dropdown.
function bmDragPreview(kind, item) {
  const el = document.createElement('div');
  el.className = kind === 'folder' ? 'bm folder' : 'bm';
  const ico = document.createElement('span');
  ico.className = 'fico';
  const fav = pickFavicon(item.favicon);
  ico.innerHTML = kind === 'folder' ? ICONS.folder
    : (fav ? faviconImg(fav, { draggable: false }) : ICONS.globe);
  const t = document.createElement('span');
  t.className = 'lbl';
  t.textContent = item.title || item.url || '';
  el.append(ico, t);
  return el;
}

function clearDropHints() {
  dropLine.remove();
  // Leave the open folder's chip lit — its highlight tracks the dropdown, not the cursor.
  for (const c of bookmarkbar.querySelectorAll('.bm.drop-into')) {
    if (c !== springChip) c.classList.remove('drop-into');
  }
  lastDropKey = null;
}

// Can this folder accept the dragged item? (No dropping a folder into itself
// or one of its own descendants.)
function canDropInto(folderId) {
  if (dragItem.kind !== 'folder') return true;
  return !folderDescendants(dragItem.id).has(folderId);
}

let dropTarget = null;  // { mode:'into', folderId } | { mode:'reorder', index }
let dragChips = null;   // cached chip geometry for the current drag (avoids per-event reflow)
let dragBarRect = null; // cached bar geometry, for positioning the fixed drop line
let lastDropKey = null; // last applied hint; skip DOM work while it's unchanged

// Show the reorder line at the boundary for insert position `index`. Fixed
// position from cached geometry — no DOM insertion, so the chips never shift.
function showDropLine(index) {
  let x;
  if (index >= dragChips.length) x = dragChips.length ? dragChips[dragChips.length - 1].right + 2 : dragBarRect.left + 4;
  else x = dragChips[index].left - 2;
  dropLine.style.left = (x - 1) + 'px';
  dropLine.style.top = (dragBarRect.top + 4) + 'px';
  dropLine.style.height = (dragBarRect.height - 8) + 'px';
  if (!dropLine.isConnected) document.body.appendChild(dropLine);
}

// Spring-loaded folders: while dragging, hovering a folder chip opens its dropdown
// immediately (no dwell delay) so you can see inside and drop at a precise position.
// The open folder's chip stays highlighted for as long as its dropdown is up.
let springOpened = false;    // did we spring-open a dropdown this drag? (close it on drop)
let springChip = null;       // bar chip whose dropdown is open - kept lit until it closes
let draggedFromPop = false;  // did this drag start inside the open folder dropdown?
let droppedInPop = false;    // ...and did it land back inside it (reorder) vs. get pulled out?
let springRegion = null;     // cached "keep open" box = spring chip ∪ its open dropdown
// Light exactly one chip (the open folder's), clearing the previously-lit one.
function setSpringChip(el) {
  if (springChip === el) return;
  if (springChip) springChip.classList.remove('drop-into');
  springChip = el;
  springRegion = null;       // recomputed by armSpring once the new dropdown is positioned
  if (el) el.classList.add('drop-into');
}
function armSpring(folderId, anchor) {
  if (!dragItem || !canDropInto(folderId)) return;
  setSpringChip(anchor);                 // keep this chip lit while its dropdown is open
  if (bmFolderId === folderId) return;   // already showing this folder
  openFolderPop(folderId, anchor);       // open immediately
  springOpened = true;
  cacheSpringRegion();                   // measure chip+dropdown once (no per-dragover reflow)
}
// The folder's drag region: its bar chip, the dropdown below it, and the thin
// gap bridging the two. NOT their bounding box — the dropdown is anchored at the
// chip's left and is usually wider, so a box would stretch the region rightward
// past the chip and make a rightward exit along the bar feel "sticky" while a
// leftward one closed at once. Keep these as separate rects so that at bar level
// only the chip's width counts (symmetric exit both ways), while the descent into
// the wider dropdown stays generous. Measured once on open (getBoundingClientRect
// mid-dragover would stutter the bar).
function cacheSpringRegion() {
  if (!springChip || bmfolderpop.hidden) { springRegion = null; return; }
  const c = springChip.getBoundingClientRect();
  const p = bmfolderpop.getBoundingClientRect();
  springRegion = {
    cl: c.left, cr: c.right, ct: c.top, cb: c.bottom,  // chip rect
    pl: p.left, pr: p.right, pt: p.top, pb: p.bottom,  // dropdown rect
  };
}
function inSpringRegion(x, y) {
  const r = springRegion;
  if (!r) return false;
  const inChip = x >= r.cl && x <= r.cr && y >= r.ct && y <= r.cb;
  const inPop  = x >= r.pl && x <= r.pr && y >= r.pt && y <= r.pb;
  const inGap  = x >= r.pl && x <= r.pr && y >= r.cb && y <= r.pt; // chip↔dropdown bridge
  return inChip || inPop || inGap;
}

function updateDropTarget(clientX) {
  // Measure once per drag — getBoundingClientRect mid-dragover forces a reflow,
  // which is what stuttered the bar.
  if (!dragChips) {
    dragBarRect = bookmarkbar.getBoundingClientRect();
    dragChips = [...bookmarkbar.querySelectorAll('.bm')]
      // Exclude the dragged chip by identity, NOT the `.dragging` class: that class
      // is added a frame late (rAF in dragstart, so the native drag image snapshots
      // first), and the first dragover often beats it — leaving the dragged chip in
      // this once-built cache. The reorder index would then be counted over N chips
      // while the store inserts into the siblings minus the dragged one (N-1), so
      // reorders intermittently overshot or snapped back. dragItem is set synchronously
      // at dragstart, so it's reliable here.
      .filter((c) => !(Number(c.dataset.id) === dragItem.id && c.dataset.kind === dragItem.kind))
      .map((c) => {
        const r = c.getBoundingClientRect();
        return { el: c, left: r.left, right: r.right, width: r.width, kind: c.dataset.kind, id: Number(c.dataset.id) };
      });
  }

  // Over the middle of a folder → file into it. Works for any folder, empty or
  // not: a non-empty folder appends to its end (open it to drop at a position).
  for (const c of dragChips) {
    if (c.kind !== 'folder') continue;
    if (clientX > c.left + c.width * 0.3 && clientX < c.right - c.width * 0.3 && canDropInto(c.id)) {
      dropTarget = { mode: 'into', folderId: c.id };
      dropLine.remove();        // not reordering → hide the insert line
      armSpring(c.id, c.el);    // open the folder immediately and keep its chip lit
      lastDropKey = 'into:' + c.id;
      return;
    }
  }

  // Not over a folder → show the reorder line. A spring-opened dropdown stays up
  // (and its chip lit) while the cursor is still in its region — the capture-phase
  // dragover above closes it once you leave; drop here to reorder/un-file.
  let index = dragChips.length;
  for (let i = 0; i < dragChips.length; i++) {
    if (clientX < dragChips[i].left + dragChips[i].width / 2) { index = i; break; }
  }
  dropTarget = { mode: 'reorder', index };
  const key = 'reorder:' + index;
  if (key !== lastDropKey) {
    clearDropHints();
    showDropLine(index);
    lastDropKey = key;
  }
}

bookmarkbar.addEventListener('dragover', (e) => {
  if (!dragItem) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  updateDropTarget(e.clientX);
});
bookmarkbar.addEventListener('drop', (e) => {
  if (!dragItem || !dropTarget) return;
  e.preventDefault();
  if (dropTarget.mode === 'into') {
    window.api.moveBookmark({ id: dragItem.id, kind: dragItem.kind, parentId: dropTarget.folderId, index: -1 });
  } else {
    window.api.moveBookmark({ id: dragItem.id, kind: dragItem.kind, parentId: null, index: dropTarget.index });
  }
  clearDropHints();
  dropTarget = null;
});
bookmarkbar.addEventListener('dragleave', (e) => {
  if (!bookmarkbar.contains(e.relatedTarget)) { clearDropHints(); dropTarget = null; }
});

// ---------------------------------------------------------------------------
// Reorder / file inside an open folder dropdown. Dropping here files the item
// into the folder currently shown (bmFolderId) at the cursor position, which
// also covers reordering items already in the folder.
// ---------------------------------------------------------------------------
const ddDropLine = document.createElement('div');
ddDropLine.className = 'bm-dd-drop-line';

function clearDdDropLine() {
  ddDropLine.remove();
  const e = bmfolderpop.querySelector('.empty.drop-into');
  if (e) e.classList.remove('drop-into');
}
// Item rows in the dropdown (skips the back row, separators and the empty hint).
function ddItemRows() { return [...bmfolderpop.querySelectorAll('button.menuitem[data-id]')]; }
function ddIsDragged(r) {
  return dragItem && Number(r.dataset.id) === dragItem.id && r.dataset.kind === dragItem.kind;
}
// Insert position (index among the folder's children) for cursor Y, skipping
// the row being dragged. -1 means append at the end.
function ddDropIndex(clientY) {
  let idx = 0;
  for (const r of ddItemRows()) {
    if (ddIsDragged(r)) continue;
    const b = r.getBoundingClientRect();
    if (clientY < b.top + b.height / 2) return idx;
    idx++;
  }
  return -1;
}
function showDdDropLine(clientY) {
  const rows = ddItemRows().filter((r) => !ddIsDragged(r));
  const pop = bmfolderpop.getBoundingClientRect();
  // Empty folder: no rows to slot between — highlight the "empty" hint itself as
  // the drop target instead of drawing a (meaningless) insert line.
  if (!rows.length) {
    ddDropLine.remove();
    const e = bmfolderpop.querySelector('.empty');
    if (e) e.classList.add('drop-into');
    return;
  }
  let target = null;
  for (const r of rows) { const b = r.getBoundingClientRect(); if (clientY < b.top + b.height / 2) { target = r; break; } }
  let y;
  if (target) y = target.getBoundingClientRect().top - 1;
  else if (rows.length) y = rows[rows.length - 1].getBoundingClientRect().bottom - 1;
  else y = pop.top + 6;
  ddDropLine.style.left = (pop.left + 6) + 'px';
  ddDropLine.style.width = (pop.width - 12) + 'px';
  ddDropLine.style.top = y + 'px';
  if (!ddDropLine.isConnected) document.body.appendChild(ddDropLine);
}

bmfolderpop.addEventListener('dragover', (e) => {
  if (!dragItem || bmFolderId == null || !canDropInto(bmFolderId)) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  clearDropHints(); dropTarget = null; // suppress bar hints while over the dropdown
  showDdDropLine(e.clientY);
});
bmfolderpop.addEventListener('drop', (e) => {
  if (!dragItem || bmFolderId == null || !canDropInto(bmFolderId)) { clearDdDropLine(); return; }
  e.preventDefault();
  e.stopPropagation();
  droppedInPop = true;   // landed back inside the folder → keep the dropdown open
  window.api.moveBookmark({ id: dragItem.id, kind: dragItem.kind, parentId: bmFolderId, index: ddDropIndex(e.clientY) });
  clearDdDropLine();
});
bmfolderpop.addEventListener('dragleave', (e) => {
  if (!bmfolderpop.contains(e.relatedTarget)) clearDdDropLine();
});

// ---------------------------------------------------------------------------
// Drop a bookmark onto the tab strip: over a tab's middle replaces (navigates)
// that tab; over a tab edge / the gaps opens a new tab at that position.
// Replace target → tab highlight; insert target → a vertical line (mirrors the
// bookmark-bar reorder line) rather than the arrow Chrome uses.
// ---------------------------------------------------------------------------
let tabDrop = null;        // cached tab geometry for the current drag
let tabStripRect = null;   // cached strip geometry, for the fixed insert line
let tabDropTarget = null;  // { mode:'replace', id } | { mode:'insert', index }
let lastTabDropKey = null;
const tabDropLine = document.createElement('div');
tabDropLine.className = 'tab-drop-line';

function clearTabDropHints() {
  tabDropLine.remove();
  for (const el of tabstrip.querySelectorAll('.tab.drop-target')) el.classList.remove('drop-target');
  lastTabDropKey = null;
}
function showTabInsertLine(index) {
  let x;
  if (index >= tabDrop.length) x = tabDrop.length ? tabDrop[tabDrop.length - 1].right + 2 : tabStripRect.left + 4;
  else x = tabDrop[index].left - 2;
  tabDropLine.style.left = (x - 1) + 'px';
  tabDropLine.style.top = (tabStripRect.top + 3) + 'px';
  tabDropLine.style.height = (tabStripRect.height - 6) + 'px';
  if (!tabDropLine.isConnected) document.body.appendChild(tabDropLine);
}
function updateTabDrop(clientX) {
  if (!tabDrop) {
    tabStripRect = tabstrip.getBoundingClientRect();
    tabDrop = [...tabstrip.querySelectorAll('.tab')].map((el) => {
      const r = el.getBoundingClientRect();
      return { el, id: Number(el.dataset.tabId), left: r.left, right: r.right, width: r.width };
    });
  }
  // Over the middle of a tab → replace it.
  for (const t of tabDrop) {
    if (clientX >= t.left && clientX <= t.right) {
      if (clientX > t.left + t.width * 0.25 && clientX < t.right - t.width * 0.25) {
        tabDropTarget = { mode: 'replace', id: t.id };
        const key = 'replace:' + t.id;
        if (key !== lastTabDropKey) { clearTabDropHints(); t.el.classList.add('drop-target'); lastTabDropKey = key; }
        return;
      }
      break; // near an edge → fall through to insert
    }
  }
  // Insert before the first tab whose center is past the cursor (else at the end).
  let index = tabDrop.length;
  for (let i = 0; i < tabDrop.length; i++) {
    if (clientX < tabDrop[i].left + tabDrop[i].width / 2) { index = i; break; }
  }
  tabDropTarget = { mode: 'insert', index };
  const key = 'insert:' + index;
  if (key !== lastTabDropKey) { clearTabDropHints(); showTabInsertLine(index); lastTabDropKey = key; }
}
function draggingBookmarkUrl() {
  return dragItem && dragItem.kind === 'bookmark' && dragItem.url;
}
tabstrip.addEventListener('dragover', (e) => {
  if (!draggingBookmarkUrl()) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  clearDropHints(); dropTarget = null; // suppress bar reorder hints while over the tabs
  updateTabDrop(e.clientX);
});
tabstrip.addEventListener('drop', (e) => {
  if (!draggingBookmarkUrl() || !tabDropTarget) return;
  e.preventDefault();
  if (tabDropTarget.mode === 'replace') window.api.navigateTab(tabDropTarget.id, dragItem.url);
  else window.api.newTabAt(dragItem.url, tabDropTarget.index);
  clearTabDropHints();
  tabDropTarget = null;
});
tabstrip.addEventListener('dragleave', (e) => {
  if (!tabstrip.contains(e.relatedTarget)) { clearTabDropHints(); tabDropTarget = null; }
});

// Drop a bookmark onto the page (anywhere below the bar) → open in a new tab.
// Works because bmDragActive makes the chrome cover the whole window mid-drag.
function overContent(e) {
  return e.clientY > bar.getBoundingClientRect().bottom;
}
document.addEventListener('dragover', (e) => {
  if (dragItem && dragItem.kind === 'bookmark' && dragItem.url && overContent(e)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});
document.addEventListener('drop', (e) => {
  if (dragItem && dragItem.kind === 'bookmark' && dragItem.url && overContent(e)) {
    e.preventDefault();
    window.api.newTab(dragItem.url);
  }
});

// ---------------------------------------------------------------------------
// Bookmark add/edit popup (Chrome-style) + bookmark-bar folder dropdown
// ---------------------------------------------------------------------------
const bmeditName = $('#bmedit-name');
const bmeditFolder = $('#bmedit-folder');
const bmtreeName = $('#bmtree-name');
const bmtreeList = $('#bmtree-list');
const bmtreeHead = bmtree.querySelector('.bmtree-head');
const bmtreeNewBtn = $('#bmtree-newfolder');

let bmEditId = null;      // bookmark id currently being edited
let bmEditFallback = null; // record to use until state:update catches up (IPC race)
let bmFolderId = null;    // folder id currently shown in the bar dropdown
let _prevFolderValue = ''; // folder picker value before the chooser was opened
let bmTreeSel = null;     // selected existing folder (id / null=root) in the chooser
let bmTreePending = null; // uncommitted new folder { name, parentId } or null
let bmDialogMode = 'editBookmark'; // 'editBookmark' | 'newFolder' | 'editFolder'
let bmTreeExclude = null;  // folder ids hidden from the chooser tree (a folder can't be moved into itself/its descendants)
const CHOOSE = '__choose__';

async function addBookmarkAndEdit() {
  const rec = await window.api.addBookmark();
  if (rec) openBookmarkEditor(rec.id, rec);
}
// Ctrl+D (handled in main) asks us to open the editor for a freshly-added mark.
window.api.onBookmarkEdit((id) => openBookmarkEditor(id));

// `rec` is the record returned by the add IPC; we fall back to it because the
// state:update broadcast may not have reached us yet (the invoke reply can win
// the race), which would otherwise make the editor open-then-immediately-close.
function openBookmarkEditor(id, rec) {
  bmEditId = id;
  bmEditFallback = rec || null;
  closeFolderPop();
  bmedit.hidden = false;
  if (!syncBookmarkEditor()) { closeBookmarkEditor(); return; }
  _prevFolderValue = bmeditFolder.value;
  bmeditName.focus();
  bmeditName.select();
  reportLayout();
}

// Refresh editor fields from current state. False if the bookmark is gone.
function syncBookmarkEditor() {
  const b = (state.bookmarks || []).find((x) => x.id === bmEditId) || bmEditFallback;
  if (!b) return false;
  if (document.activeElement !== bmeditName) bmeditName.value = b.title || '';
  buildFolderOptions(bmeditFolder, b.parentId ?? null);
  return true;
}

// Fill a <select> with the folder tree (indented) plus root and "new folder".
function buildFolderOptions(sel, selectedId) {
  sel.replaceChildren();
  const add = (value, label) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = label; sel.append(o);
  };
  add('', tr('bookmarksBar'));
  const walk = (parentId, depth) => {
    const subs = (state.bookmarkFolders || []).filter((x) => (x.parentId ?? null) === parentId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const f of subs) {
      add(String(f.id), '　'.repeat(depth) + f.title);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  add(CHOOSE, tr('chooseFolder'));
  sel.value = selectedId == null ? '' : String(selectedId);
}

function commitName() {
  if (bmEditId == null) return;
  window.api.updateBookmark(bmEditId, { title: bmeditName.value });
}

bmeditName.addEventListener('change', commitName);
bmeditName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { commitName(); closeBookmarkEditor(); }
  if (e.key === 'Escape') closeBookmarkEditor();
});

bmeditFolder.addEventListener('focus', () => { _prevFolderValue = bmeditFolder.value; });
bmeditFolder.addEventListener('change', () => {
  const v = bmeditFolder.value;
  if (v === CHOOSE) {
    bmeditFolder.value = _prevFolderValue;   // keep picker off the action row
    openBookmarkDialog(bmEditId, bmeditName.value);  // hand off to the full dialog
    return;
  }
  _prevFolderValue = v;
  if (bmEditId != null) window.api.updateBookmark(bmEditId, { parentId: v ? Number(v) : null });
});

$('#bmedit-remove').onclick = () => {
  if (bmEditId != null) window.api.removeBookmark(bmEditId);
  closeBookmarkEditor();
};
$('#bmedit-done').onclick = () => { commitName(); closeBookmarkEditor(); };

function closeBookmarkEditor() {
  if (bmedit.hidden) return;
  bmedit.hidden = true;
  bmEditId = null;
  bmEditFallback = null;
  reportLayout();
}

// A folder id plus all of its nested folder ids (mirrors store.removeFolder).
function folderDescendants(id) {
  const set = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of (state.bookmarkFolders || [])) {
      if (!set.has(f.id) && f.parentId != null && set.has(f.parentId)) { set.add(f.id); grew = true; }
    }
  }
  return set;
}
function folderHasContents(id) {
  const set = folderDescendants(id);
  return set.size > 1 || (state.bookmarks || []).some((b) => set.has(b.parentId));
}
// Recursive delete is destructive and we have no undo, so confirm when non-empty.
function confirmFolderDelete(id, name) {
  if (!folderHasContents(id)) return true;
  return window.confirm(tr('confirmDeleteFolder', name));
}

// Delete from the chooser tree: drop locally for an instant update (the IPC
// broadcast will reconcile), then fix up any now-dangling selection.
function deleteFolderInChooser(id, name) {
  if (!confirmFolderDelete(id, name)) return;
  const doomed = folderDescendants(id);
  state.bookmarkFolders = (state.bookmarkFolders || []).filter((f) => !doomed.has(f.id));
  if (doomed.has(bmTreeSel)) bmTreeSel = null;
  if (bmTreePending && doomed.has(bmTreePending.parentId)) bmTreePending = null;
  window.api.removeBookmarkFolder(id);
  renderFolderTree();
}

// Dismiss every transient bookmark popup (inline bubble, folder fly-out,
// right-click menu) — run before opening one of the modal dialogs below.
function closeBookmarkPopups() { closeBookmarkEditor(); closeFolderPop(); closeCtx(); }

// --- full "edit bookmark" dialog (modal) -----------------------------------
// Centered dialog (Chrome's BookmarkEditorView): rename + choose folder + make
// a new folder. Opened by the right-click "Edit…" or the bubble's "Choose
// another folder…". Nothing is written until Save — Cancel/outside-click/Esc discards.
function openBookmarkDialog(id, nameOverride) {
  const b = (state.bookmarks || []).find((x) => x.id === id);
  if (!b) return;
  closeBookmarkPopups();
  bmDialogMode = 'editBookmark';
  bmEditId = id;
  bmTreeExclude = null;
  bmtreeHead.textContent = tr('dialog_editBookmark');
  bmtreeNewBtn.hidden = false;
  bmtreeName.value = nameOverride != null ? nameOverride : (b.title || '');
  bmTreeSel = b.parentId ?? null;
  bmTreePending = null;
  bmtree.hidden = false;
  renderFolderTree();
  bmtreeName.focus();
  bmtreeName.select();
  reportLayout();
}

// Edit an existing folder: rename + re-parent. Same dialog as "Edit…" on a
// bookmark, but the folder being edited (and its descendants) are hidden from
// the chooser tree so it can't be moved inside itself.
function openFolderDialog(id) {
  const f = (state.bookmarkFolders || []).find((x) => x.id === id);
  if (!f) return;
  closeBookmarkPopups();
  bmDialogMode = 'editFolder';
  bmEditId = id;
  bmTreeExclude = folderDescendants(id);
  bmtreeHead.textContent = tr('dialog_editFolder');
  bmtreeNewBtn.hidden = false;
  bmtreeName.value = f.title || '';
  bmTreeSel = f.parentId ?? null;
  bmTreePending = null;
  bmtree.hidden = false;
  renderFolderTree();
  bmtreeName.focus();
  bmtreeName.select();
  reportLayout();
}

// Create a brand-new folder: Name = the folder, tree = where to put it.
function openNewFolderDialog(parentId) {
  closeBookmarkPopups();
  bmDialogMode = 'newFolder';
  bmEditId = null;
  bmTreeExclude = null;
  bmtreeHead.textContent = tr('dialog_newFolder');
  bmtreeNewBtn.hidden = true;   // no nested "new folder" button in this mode
  bmtreeName.value = tr('newFolder_name');
  bmTreeSel = parentId ?? null;
  bmTreePending = null;
  bmtree.hidden = false;
  renderFolderTree();
  bmtreeName.focus();
  bmtreeName.select();
  reportLayout();
}

function renderFolderTree() {
  bmtreeList.replaceChildren();

  const realRow = (id, label, depth) => {
    const r = document.createElement('button');
    const selected = !bmTreePending && (bmTreeSel ?? null) === (id ?? null);
    r.className = 'treerow' + (selected ? ' sel' : '');
    r.style.paddingLeft = (8 + depth * 16) + 'px';
    r.innerHTML = `<span class="ico">${ICONS.folder}</span><span class="lbl">${escapeHtml(label)}</span>`;
    r.onclick = () => { bmTreeSel = id; bmTreePending = null; renderFolderTree(); };
    if (id != null) {            // every folder except the bar root can be deleted
      const del = document.createElement('span');
      del.className = 'del'; del.title = tr('deleteFolder'); del.innerHTML = ICONS.trash;
      del.onclick = (e) => { e.stopPropagation(); deleteFolderInChooser(id, label); };
      r.append(del);
    }
    bmtreeList.append(r);
  };
  // The not-yet-saved new folder, rendered with an inline rename field.
  const pendingRow = (depth) => {
    const r = document.createElement('div');
    r.className = 'treerow sel pending';
    r.style.paddingLeft = (8 + depth * 16) + 'px';
    const ico = document.createElement('span'); ico.className = 'ico'; ico.innerHTML = ICONS.folder;
    const inp = document.createElement('input');
    inp.type = 'text'; inp.spellcheck = false; inp.value = bmTreePending.name;
    inp.oninput = () => { bmTreePending.name = inp.value; };  // no re-render: keep caret
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveBookmarkDialog(); }
      if (e.key === 'Escape') { e.preventDefault(); closeBookmarkDialog(); }
    };
    r.append(ico, inp);
    bmtreeList.append(r);
  };

  // The pending folder appears as the first child of its parent.
  const childrenOf = (parentId, depth) => {
    if (bmTreePending && (bmTreePending.parentId ?? null) === (parentId ?? null)) pendingRow(depth);
    const subs = (state.bookmarkFolders || []).filter((x) => (x.parentId ?? null) === parentId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const f of subs) {
      if (bmTreeExclude && bmTreeExclude.has(f.id)) continue; // can't re-parent a folder into itself
      realRow(f.id, f.title, depth);
      childrenOf(f.id, depth + 1);
    }
  };

  realRow(null, tr('bookmarksBar'), 0);
  childrenOf(null, 1);
}

// Stage a new folder under the current selection and focus its field.
$('#bmtree-newfolder').onclick = () => {
  bmTreePending = { name: tr('newFolder_name'), parentId: bmTreeSel ?? null };
  renderFolderTree();
  const inp = bmtreeList.querySelector('.treerow.pending input');
  if (inp) { inp.focus(); inp.select(); }
};
// Modal: only Cancel/Save (or Esc) close it — never an outside click.
bmtree.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBookmarkDialog(); });
bmtreeName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBookmarkDialog();
});
$('#bmtree-cancel').onclick = () => closeBookmarkDialog();
$('#bmtree-save').onclick = () => saveBookmarkDialog();

// Commit: create a folder (newFolder mode), or apply name + chosen folder to
// the bookmark (editBookmark mode, creating the pending folder first).
async function saveBookmarkDialog() {
  if (bmDialogMode === 'newFolder') {
    const name = (bmtreeName.value || '').trim() || tr('newFolder_name');
    await window.api.addBookmarkFolder(name, bmTreeSel ?? null);
    closeBookmarkDialog();
    return;
  }
  if (bmDialogMode === 'editFolder') {
    if (bmEditId == null) { closeBookmarkDialog(); return; }
    let parentId = bmTreeSel ?? null;
    if (bmTreePending) {
      const pname = (bmTreePending.name || '').trim() || tr('newFolder_name');
      const nf = await window.api.addBookmarkFolder(pname, bmTreePending.parentId);
      if (nf) parentId = nf.id;
    }
    window.api.updateBookmarkFolder(bmEditId, { title: bmtreeName.value, parentId });
    closeBookmarkDialog();
    return;
  }
  if (bmEditId == null) { closeBookmarkDialog(); return; }
  let parentId = bmTreeSel ?? null;
  if (bmTreePending) {
    const name = (bmTreePending.name || '').trim() || tr('newFolder_name');
    const f = await window.api.addBookmarkFolder(name, bmTreePending.parentId);
    if (f) parentId = f.id;
  }
  window.api.updateBookmark(bmEditId, { title: bmtreeName.value, parentId });
  closeBookmarkDialog();
}

function closeBookmarkDialog() {
  if (bmtree.hidden) return;
  bmtree.hidden = true;
  bmTreePending = null;
  bmEditId = null;
  bmTreeExclude = null;
  reportLayout();
}

// --- bookmark-bar folder dropdown (navigates nested folders in place) ------
function openFolderPop(folderId, anchor) {
  closeBookmarkEditor();
  bmfolderpop.classList.remove('closing');                       // cancel any in-progress close
  bmfolderpop.removeEventListener('animationend', finishClosePop);
  bmfolderpop.hidden = false;
  renderFolderPop(folderId, anchor);
  reportLayout();
}

function renderFolderPop(folderId, anchor) {
  const folder = (state.bookmarkFolders || []).find((f) => f.id === folderId);
  if (!folder) { closeFolderPop(); return; }
  bmFolderId = folderId;
  bmfolderpop.replaceChildren();

  const mkItem = (cls, html, onClick) => {
    const b = document.createElement('button');
    b.className = 'menuitem' + (cls ? ' ' + cls : '');
    b.innerHTML = html;
    b.onclick = onClick;
    bmfolderpop.append(b);
    return b;
  };
  const sep = () => {
    const s = document.createElement('div'); s.className = 'menusep'; bmfolderpop.append(s);
  };

  // Nested folders keep a back row to navigate up; no name label is shown.
  if (folder.parentId != null) {
    mkItem('back', `<span class="ico">${ICONS.folder}</span><span>←</span>`,
      () => renderFolderPop(folder.parentId, anchor));
    sep();
  }

  const kids = bmChildren(folderId);
  if (!kids.length) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = tr('folderEmpty');
    bmfolderpop.append(e);
  }
  for (const { kind, item } of kids) {
    let row;
    if (kind === 'folder') {
      row = mkItem('', `<span class="ico">${ICONS.folder}</span><span>${escapeHtml(item.title)}</span><span class="arrow">›</span>`,
        () => renderFolderPop(item.id, anchor));
    } else {
      row = mkItem('', `${favIco(item.favicon)}<span>${escapeHtml(item.title || item.url)}</span>`,
        () => { window.api.go(item.url); closeFolderPop(); });
      wireBgTabAux(row, item.url, closeFolderPop);
    }
    row.dataset.id = String(item.id);
    row.dataset.kind = kind;
    // Right-click a row inside the dropdown → same menu as the bar chip would show,
    // but keep the dropdown open behind it (stopPropagation so the document
    // contextmenu handler doesn't re-close the menu).
    row.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      const opts = { keepFolderPop: true };
      if (kind === 'folder') openFolderCtx(e, item, row, opts); else openBookmarkCtx(e, item, opts);
      clearCtxActive();              // drop any previously-lit row
      row.classList.add('ctx-active');  // keep this row lit while its menu is open
    };
    makeFolderItemDraggable(row, kind, item);
  }

  if (anchor) {
    const r = anchor.getBoundingClientRect();
    bmfolderpop.style.left = Math.round(r.left) + 'px';
    bmfolderpop.style.top = Math.round(r.bottom + 4) + 'px';
  }
}

function finishClosePop() {
  bmfolderpop.classList.remove('closing');
  bmfolderpop.hidden = true;
  reportLayout();
}
function closeFolderPop() {
  if (bmfolderpop.hidden || bmfolderpop.classList.contains('closing')) return;
  bmFolderId = null;                  // inert to drops while it fades out
  setSpringChip(null);                // release the chip highlight
  bmfolderpop.classList.add('closing');
  bmfolderpop.addEventListener('animationend', finishClosePop, { once: true });
  reportLayout();
}

// --- right-click context menu for bookmark-bar items -----------------------
// items: array of ['label', fn] / ['label', fn, {danger:true, disabled:true}] / 'sep'.
function showCtx(x, y, items, opts) {
  closeBookmarkEditor();
  if (!opts || !opts.keepFolderPop) closeFolderPop();  // keep the dropdown up when invoked from inside it
  bmctx.replaceChildren();
  for (const it of items) {
    if (it === 'sep') {
      const s = document.createElement('div'); s.className = 'menusep'; bmctx.append(s); continue;
    }
    const [label, fn, opts] = it;
    const b = document.createElement('button');
    b.className = 'menuitem' + (opts && opts.danger ? ' danger' : '');
    b.innerHTML = `<span>${escapeHtml(label)}</span>`;
    if (opts && opts.disabled) {
      b.disabled = true;   // greyed out, no handler (mirrors Chrome's empty-folder items)
    } else {
      // stopPropagation so the opening click doesn't bubble to the document
      // outside-click handler and immediately close what fn() just opened.
      b.onclick = (e) => { e.stopPropagation(); closeCtx(); fn(); };
    }
    bmctx.append(b);
  }
  bmctx.hidden = false;
  bmctx.style.left = x + 'px';
  bmctx.style.top = y + 'px';
  // Horizontal clamp only: the chrome view is full-width so innerWidth is
  // reliable, but at this instant it's still only bar-height (overlay hasn't
  // applied yet), so innerHeight would be wrong — the bar is at the top and the
  // menu opens downward, so no vertical clamp is needed.
  const r = bmctx.getBoundingClientRect();
  if (r.right > window.innerWidth) bmctx.style.left = Math.max(4, window.innerWidth - r.width - 4) + 'px';
  reportLayout();
}
// Drop the lit-row highlight on any folder-dropdown item whose menu was open.
function clearCtxActive() {
  for (const r of bmfolderpop.querySelectorAll('.menuitem.ctx-active')) r.classList.remove('ctx-active');
}
function closeCtx() { if (bmctx.hidden) return; bmctx.hidden = true; clearCtxActive(); reportLayout(); }

function openBookmarkCtx(e, b, opts) {
  showCtx(e.clientX, e.clientY, [
    [tr('ctx_openNewTab'), () => window.api.newTab(b.url)],
    [tr('ctx_openNewWindow'), () => window.api.newWindow(b.url)],
    [tr('ctx_openSplit'), () => notImplemented()],
    [tr('ctx_openIncognito'), () => window.api.newIncognito(b.url)],
    'sep',
    [tr('ctx_edit'), () => openBookmarkDialog(b.id)],
    'sep',
    [tr('ctx_delete'), () => window.api.removeBookmark(b.id)],
    'sep',
    [tr('ctx_bmManager'), () => notImplemented()],
  ], opts);
}
function openFolderCtx(e, f, anchor, opts) {
  const all = allBookmarksUnder(f.id);
  const empty = all.length === 0;  // Chrome greys out the "open all" rows for an empty folder
  showCtx(e.clientX, e.clientY, [
    [tr('ctx_openAll', all.length), () => all.forEach((b) => window.api.newTab(b.url)), { disabled: empty }],
    [tr('ctx_openAllNewWindow'), () => notImplemented(), { disabled: empty }],
    [tr('ctx_openAllIncognito'), () => notImplemented(), { disabled: empty }],
    'sep',
    [tr('ctx_edit'), () => openFolderDialog(f.id)],
    'sep',
    [tr('ctx_delete'), () => { if (confirmFolderDelete(f.id, f.title)) window.api.removeBookmarkFolder(f.id); }],
    'sep',
    [tr('ctx_bmManager'), () => notImplemented()],
  ], opts);
}

// Every bookmark nested under a folder (null = bar root), depth-first.
function allBookmarksUnder(parentId) {
  const out = [];
  const walk = (pid) => {
    for (const { kind, item } of bmChildren(pid)) {
      if (kind === 'bookmark') out.push(item); else walk(item.id);
    }
  };
  walk(parentId ?? null);
  return out;
}

// Right-click on the empty bar area.
function openBarCtx(e) {
  const all = allBookmarksUnder(null);
  const items = [];
  if (all.length) {
    items.push([tr('ctx_openAll', all.length), () => all.forEach((b) => window.api.newTab(b.url))]);
    items.push('sep');
  }
  items.push([tr('ctx_addPage'), () => addBookmarkAndEdit()]);
  items.push([tr('ctx_addFolder'), () => openNewFolderDialog(null)]);
  showCtx(e.clientX, e.clientY, items);
}
bookmarkbar.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.bm')) return;   // chips have their own menu
  e.preventDefault(); e.stopPropagation();
  openBarCtx(e);
});

// Close the context menu on any click outside it. Capture phase so that buttons
// which stopPropagation in their own handler (e.g. the menu button, folder
// chips) can't keep a stale menu open.
document.addEventListener('click', (e) => {
  if (!bmctx.hidden && !bmctx.contains(e.target)) closeCtx();
}, true);
// Outside-click closes the bookmark popups (mirrors the menu behavior).
document.addEventListener('click', (e) => {
  // Tree dialog is modal — outside clicks do nothing; close only via Cancel/Save.
  if (!bmtree.hidden) return;
  if (!bmedit.hidden && !bmedit.contains(e.target) && e.target !== star && !star.contains(e.target)) {
    commitName(); closeBookmarkEditor();
  }
  if (!bmfolderpop.hidden && !bmfolderpop.contains(e.target) && !e.target.closest('.bm.folder')) {
    closeFolderPop();
  }
});
// A right-click anywhere other than a bar item dismisses an open context menu.
document.addEventListener('contextmenu', (e) => {
  if (!bmctx.hidden && !e.target.closest('.bm')) closeCtx();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); }, true);
