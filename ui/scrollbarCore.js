'use strict';

// ---------------------------------------------------------------------------
// Shared overlay-scrollbar core: the constants, geometry, styles and pointer
// interactions that the thin floating scrollbar is built from. ONE source of
// truth for both surfaces that draw it:
//   - ui/overlayScrollbar.js — the chrome's own pages (settings, panels), a
//     classic <script> that reads the `ScrollbarCore` global this file sets.
//   - tabPreload.js — every web page, a sandboxed content preload. Sandboxed
//     preloads can't `require()` local files at runtime, so esbuild inlines
//     this module into dist/tabPreload.js at build time (see build.js).
// UMD so the single file serves both load mechanisms.
//
// What stays OUTSIDE this file (it genuinely differs per surface): resolving
// the scroll target, the single-rail vs many-rails lifecycle, and which DOM
// events are wired. This file owns only the parts that must never drift.
// ---------------------------------------------------------------------------
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // preload (esbuild)
  else root.ScrollbarCore = api;                                             // chrome <script> global
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const THIN = 3;     // idle thumb width
  const THICK = 7;    // hovered/dragged thumb width
  const ZONE = 14;    // right-edge hover/hit strip width
  const MIN = 28;     // smallest thumb so it stays grabbable-looking
  const PAGE = 0.9;   // viewport fraction a track-click jumps
  const IDLE_BG = 'rgba(140,140,150,.62)';
  const THICK_BG = 'rgba(120,120,130,.9)';

  // User stylesheet that hides every native scrollbar (no reserved gutter →
  // content never shifts). Used by the content preload via webFrame.insertCSS;
  // the universal selector covers scrollbar-width, which isn't inherited.
  const NATIVE_HIDE_CSS =
    '* { scrollbar-width: none !important; }\n'
    + '::-webkit-scrollbar { width: 0 !important; height: 0 !important; }';

  // rail = invisible full-height track (the click/drag hit area, normally
  // click-through); thumb = the visible handle inside it.
  const railCss =
    'position:fixed;width:' + ZONE + 'px;opacity:0;pointer-events:none;'
    + 'z-index:2147483647;transition:opacity .3s ease;';
  const thumbCss =
    'position:absolute;width:' + THIN + 'px;border-radius:' + (THICK / 2) + 'px;'
    + 'background:' + IDLE_BG + ';transition:width .12s ease, background .12s ease;';

  // Pure geometry. Given the measured dimensions of a scroll target, returns the
  // thumb size/position — or null when it isn't actually scrollable. `vTop` is the
  // target's top in viewport coords (0 for the document); `right` is the px gap
  // from the viewport's right edge to where the bar sits.
  function compute({ ch, sh, vTop, vH, right, scrollTop }) {
    if (sh <= ch + 1) return null;
    const th = Math.max(MIN, vH * (ch / sh));
    const maxTravel = vH - th;
    const range = sh - ch;
    const top = vTop + (maxTravel <= 0 ? 0 : (scrollTop / range) * maxTravel);
    return { ch, sh, vTop, vH, right, th, maxTravel, range, top };
  }

  // Write the rail/thumb styles from computed metrics `m`. `isDoc` flips which
  // side carries the right-offset (the document bar hugs the viewport edge; an
  // element bar sits at the element's right). `thick` = hovered or dragging.
  function applyStyles(rail, thumb, m, isDoc, thick) {
    rail.style.top = m.vTop + 'px';
    rail.style.height = m.vH + 'px';
    rail.style.right = (isDoc ? 0 : m.right) + 'px';
    thumb.style.right = (isDoc ? m.right : 0) + 'px';
    thumb.style.height = m.th + 'px';
    thumb.style.top = (m.top - m.vTop) + 'px';
    thumb.style.width = (thick ? THICK : THIN) + 'px';
    thumb.style.background = thick ? THICK_BG : IDLE_BG;
  }

  // Is (x,y) within the bar's hit region for metrics `m`?
  function hitTest(x, y, m, isDoc, innerWidth) {
    const railRight = innerWidth - (isDoc ? 0 : m.right);
    const railLeft = railRight - ZONE;
    const rightBound = isDoc ? innerWidth : railRight + 2;
    return x >= railLeft && x <= rightBound && y >= m.vTop && y <= m.vTop + m.vH;
  }

  // Incremental thumb drag: move by the pointer DELTA since the last move (not an
  // absolute map from the grab point), so a mid-drag reflow nudges the thumb from
  // where it is instead of teleporting it to the cursor. `getMetrics` is re-read
  // each move; `getScroller` returns the element whose scrollTop we set; `onEnd`
  // runs on mouseup. Returns false (and does nothing) if the target isn't
  // scrollable right now, true once the drag is wired.
  function startDrag(e, { getMetrics, getScroller, onEnd }) {
    e.preventDefault();
    if (!getMetrics()) return false;
    const sc = getScroller();
    let lastY = e.clientY;
    const onMove = (ev) => {
      const m = getMetrics();
      if (m && m.maxTravel > 0) {
        const next = sc.scrollTop + (ev.clientY - lastY) * m.range / m.maxTravel;
        sc.scrollTop = Math.max(0, Math.min(m.range, next));
      }
      lastY = ev.clientY;
    };
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      if (onEnd) onEnd(ev);
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    return true;
  }

  // Click the track to page toward the cursor, repeating while held until the
  // thumb reaches it.
  function startPage(e, { getMetrics, getScroller }) {
    e.preventDefault();
    const dirAt = (cy) => { const m = getMetrics(); if (!m) return 0; return cy < m.top ? -1 : (cy > m.top + m.th ? 1 : 0); };
    const dir = dirAt(e.clientY);
    if (!dir) return;
    const sc = getScroller();
    let lastCy = e.clientY;
    const page = () => {
      const m = getMetrics(); if (!m) return;
      sc.scrollTop = Math.max(0, Math.min(m.range, sc.scrollTop + dir * m.ch * PAGE));
    };
    page();
    let holdT = null, repT = null;
    const onMove = (ev) => { lastCy = ev.clientY; };
    const stop = () => {
      clearTimeout(holdT); clearInterval(repT);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', stop, true);
    };
    holdT = setTimeout(() => {
      repT = setInterval(() => {
        if (dirAt(lastCy) !== dir) { stop(); return; } // thumb has reached the cursor
        page();
      }, 60);
    }, 300);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', stop, true);
  }

  return { THIN, THICK, ZONE, MIN, PAGE, NATIVE_HIDE_CSS, railCss, thumbCss,
    compute, applyStyles, hitTest, startDrag, startPage };
});
