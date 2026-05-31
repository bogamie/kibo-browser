'use strict';

// ---------------------------------------------------------------------------
// Custom overlay scrollbar. A thin indicator that floats OVER the content — it
// reserves no layout width, so showing/hiding it never shifts the page (the
// native scrollbar is hidden in CSS). It only appears while you're scrolling and
// fades out a beat after you stop. Chromium dropped real overlay scrollbars (the
// OverlayScrollbar flag) in 115, hence this hand-rolled version.
//
// INTERACTIVE: the thumb can be dragged and the track click-pages (like a real
// browser scrollbar), and the whole bar thickens while the pointer hovers it.
// To stay true to the "never swallows a click" philosophy it is pointer-events:
// none EXCEPT while the pointer is actually within the right-edge hover zone (or
// a drag is in progress) — so content under the bar is fully clickable any time
// you're not reaching for the scrollbar itself.
//
// Structure: a `rail` (the full-height track hit area, normally click-through)
// holds the visible `thumb`. `target` is either a scrollable element (e.g. a
// panel body) or `window`/the document for the main page scroll. tabPreload.js
// carries a mirror copy for web pages (it can't load this file). Classic script:
// defines one global.
// ---------------------------------------------------------------------------
function overlayScrollbar(target) {
  if (!target) return;
  const isWin = target === window || target === document
    || target === document.documentElement || target === document.scrollingElement;
  const scroller = isWin ? (document.scrollingElement || document.documentElement) : target;
  const scrollSrc = isWin ? window : target;

  const THIN = 3;     // idle thumb width
  const THICK = 7;    // hovered/dragged thumb width
  const ZONE = 14;    // right-edge hover/hit strip width
  const MIN = 28;     // smallest thumb so it stays grabbable-looking
  const PAGE = 0.9;   // viewport fraction a track-click jumps

  // rail = invisible full-height track (the click/drag hit area); thumb = handle.
  const rail = document.createElement('div');
  rail.style.cssText =
    'position:fixed;width:' + ZONE + 'px;opacity:0;pointer-events:none;'
    + 'z-index:2147483647;transition:opacity .3s ease;';
  const thumb = document.createElement('div');
  thumb.style.cssText =
    'position:absolute;width:' + THIN + 'px;border-radius:' + (THICK / 2) + 'px;'
    + 'background:rgba(140,140,150,.62);'
    + 'transition:width .12s ease, background .12s ease;';
  rail.appendChild(thumb);
  document.body.appendChild(rail);

  let active = false;     // within the post-scroll visible window?
  let hovering = false;   // pointer inside the hover zone?
  let dragging = false;
  let timer = null;
  let raf = 0;
  let moveRaf = 0, lastX = 0, lastY = 0;

  function metrics() {
    const ch = isWin ? window.innerHeight : scroller.clientHeight;
    const sh = scroller.scrollHeight;
    if (sh <= ch + 1) return null;
    let vTop, vH, right;
    if (isWin) { vTop = 0; vH = window.innerHeight; right = 2; }
    else {
      const r = scroller.getBoundingClientRect();
      if (r.height === 0) return null;
      vTop = r.top; vH = r.height; right = window.innerWidth - r.right + 2;
    }
    const th = Math.max(MIN, vH * (ch / sh));
    const maxTravel = vH - th;
    const range = sh - ch;
    const top = vTop + (maxTravel <= 0 ? 0 : (scroller.scrollTop / range) * maxTravel);
    return { ch, sh, vTop, vH, right, th, maxTravel, range, top };
  }

  function render() {
    raf = 0;
    const m = metrics();
    const thick = hovering || dragging;
    if (m) {
      rail.style.top = m.vTop + 'px';
      rail.style.height = m.vH + 'px';
      rail.style.right = (isWin ? 0 : m.right) + 'px';
      thumb.style.right = (isWin ? m.right : 0) + 'px';
      thumb.style.height = m.th + 'px';
      thumb.style.top = (m.top - m.vTop) + 'px';
      thumb.style.width = (thick ? THICK : THIN) + 'px';
      thumb.style.background = thick ? 'rgba(120,120,130,.9)' : 'rgba(140,140,150,.62)';
    }
    rail.style.opacity = (m && (active || hovering || dragging)) ? '1' : '0';
    rail.style.pointerEvents = (m && (hovering || dragging)) ? 'auto' : 'none';
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(render); };

  function hitTest(x, y) {
    const m = metrics();
    if (!m) return false;
    const railRight = window.innerWidth - (isWin ? 0 : m.right);
    const railLeft = railRight - ZONE;
    const rightBound = isWin ? window.innerWidth : railRight + 2;
    return x >= railLeft && x <= rightBound && y >= m.vTop && y <= m.vTop + m.vH;
  }

  // ---- drag the thumb -------------------------------------------------------
  function startDrag(e) {
    e.preventDefault();
    if (!metrics()) return;
    dragging = true;
    // Incremental drag: move by the pointer DELTA since the last move (not an
    // absolute map from the grab point). If content reflows mid-drag and the thumb
    // shifts, the next move nudges it from where it is — it never teleports to the
    // cursor, so the thumb/cursor gap is preserved.
    let lastY = e.clientY;
    const onMove = (ev) => {
      const m = metrics();          // re-read each move: content may reflow mid-drag
      if (m && m.maxTravel > 0) {
        const next = scroller.scrollTop + (ev.clientY - lastY) * m.range / m.maxTravel;
        scroller.scrollTop = Math.max(0, Math.min(m.range, next));
      }
      lastY = ev.clientY;
    };
    const onUp = (ev) => {
      dragging = false;
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      hovering = hitTest(ev.clientX, ev.clientY);
      schedule();
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    schedule();
  }

  // ---- click the track: page toward the click, repeating while held ---------
  function startPage(e) {
    e.preventDefault();
    const dirAt = (cy) => { const m = metrics(); if (!m) return 0; return cy < m.top ? -1 : (cy > m.top + m.th ? 1 : 0); };
    const dir = dirAt(e.clientY);
    if (!dir) return;
    let lastCy = e.clientY;
    const page = () => {
      const m = metrics(); if (!m) return;
      scroller.scrollTop = Math.max(0, Math.min(m.range, scroller.scrollTop + dir * m.ch * PAGE));
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

  rail.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.target === thumb) startDrag(e); else startPage(e);
  });

  // ---- show on scroll, then fade --------------------------------------------
  scrollSrc.addEventListener('scroll', () => {
    active = true;
    schedule();
    clearTimeout(timer);
    timer = setTimeout(() => { active = false; schedule(); }, 1100);
  }, { passive: true });

  // ---- hover detection by pointer proximity (no permanent hit area) ---------
  window.addEventListener('mousemove', (e) => {
    lastX = e.clientX; lastY = e.clientY;
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (dragging) return;
      const h = hitTest(lastX, lastY);
      if (h !== hovering) { hovering = h; schedule(); }
    });
  }, { passive: true, capture: true });

  window.addEventListener('resize', () => schedule(), { passive: true });

  // The pointer can leave the window (or focus can be lost) while inside the hover
  // zone — no further mousemove fires to drop `hovering`, so the rail would stay
  // clickable over content. Clear it explicitly on those events.
  const clearHover = () => { if (hovering) { hovering = false; schedule(); } };
  document.documentElement.addEventListener('mouseleave', clearHover, { passive: true });
  window.addEventListener('blur', clearHover, { passive: true });

  // Keep the bar in sync when content changes without a scroll or window resize
  // (a panel's list replaced, settings toggled, async/image load) — otherwise the
  // thumb sits stale until the next scroll. NOT a ResizeObserver: re-measuring
  // writes styles into the bar, which trips ResizeObserver's resize-loop guard and
  // stops its delivery. MutationObserver (DOM changes) has no such guard; a
  // capture-phase `load` covers images/media that reflow without a DOM change.
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => schedule()).observe(scroller, { childList: true, subtree: true });
  }
  window.addEventListener('load', () => schedule(), { capture: true, passive: true });
}
