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

  // ---- middle-click autoscroll (pan) ---------------------------------------
  // Find the nearest scrollable ancestor of `el` (either axis), else the
  // document scroller, else null when nothing under the pointer scrolls.
  function findScroller(el) {
    for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const y = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight - n.clientHeight > 1;
      const x = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && n.scrollWidth - n.clientWidth > 1;
      if (y || x) return n;
    }
    const de = document.scrollingElement || document.documentElement;
    if (de && (de.scrollHeight - de.clientHeight > 1 || de.scrollWidth - de.clientWidth > 1)) return de;
    return null;
  }

  const AS_DEAD = 10;    // px radius around the anchor that doesn't scroll
  const AS_SPEED = 14;   // scroll px/sec per px the cursor is past the deadzone
  let asActive = null;   // the running instance ({ stop }) — autoscroll is a toggle

  // Pan glyph: chevrons only on the axes that actually scroll (↕ / ↔ / both)
  // plus a center dot, so the cursor advertises exactly which directions work.
  // No width/height attrs — sized by the shadow CSS below; stroked to match the
  // chrome's line-icon set (per the project's icon convention).
  function asGlyph(canX, canY) {
    // Round-capped chevrons at the badge edges around a small center dot. Arms
    // are kept narrow so that in the 4-way case the diagonals stay open (wide
    // arms make the four heads merge into a single diamond outline).
    let p = '<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>';
    if (canY) p += '<path d="M9.5 6.5 12 4l2.5 2.5M9.5 17.5 12 20l2.5-2.5"/>';
    if (canX) p += '<path d="M6.5 9.5 4 12l2.5 2.5M17.5 9.5 20 12l-2.5 2.5"/>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
      + ' stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  }

  // Arm a one-shot suppressor for the auxclick that trails a middle-press, so the
  // page can't act on it once we've consumed the mousedown.
  function swallowNextAux() {
    window.addEventListener('auxclick',
      (ev) => { ev.preventDefault(); ev.stopPropagation(); }, { capture: true, once: true });
  }

  // A middle-button mousedown `e` TOGGLES autoscroll. Returns false — leaving the
  // event untouched — when it shouldn't engage: on a link (so middle-click still
  // opens it in a new tab), in an editable field (so the Linux middle-click paste
  // still works), or when nothing under the pointer scrolls. While running it
  // pins an anchor at the press point and scrolls toward the cursor each frame; a
  // second middle-click (or Esc / wheel / a non-middle click / blur) ends it.
  function autoScroll(e) {
    if (e.button !== 1) return false;
    // Already running → this middle-click toggles it off (don't open a new one).
    if (asActive) { e.preventDefault(); e.stopPropagation(); asActive.stop(); swallowNextAux(); return true; }

    const t = e.target;
    if (t && t.closest && t.closest('a[href],area[href]')) return false;
    if (t && t.closest && t.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"]')) return false;
    const sc = findScroller(t);
    if (!sc) return false;
    const canY = sc.scrollHeight - sc.clientHeight > 1;
    const canX = sc.scrollWidth - sc.clientWidth > 1;
    if (!canY && !canX) return false;

    e.preventDefault();
    e.stopPropagation();
    swallowNextAux();

    const ox = e.clientX, oy = e.clientY;
    let mx = ox, my = oy;

    // Full-window overlay: carries the pan cursor and shields the page from the
    // dismiss click. The anchor glyph lives in a closed shadow root so the page
    // can neither style nor read it (same isolation as the password picker).
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    overlay.style.setProperty('cursor', (canY && canX) ? 'all-scroll' : (canY ? 'ns-resize' : 'ew-resize'), 'important');
    const root = overlay.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent =
      '.a{position:fixed;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;'
      + 'background:rgba(255,255,255,.94);color:#3c4043;display:flex;align-items:center;justify-content:center;'
      + 'box-shadow:0 2px 7px rgba(0,0,0,.25),0 0 0 1px rgba(0,0,0,.08)}'
      + '.a svg{width:22px;height:22px}'
      + '@media(prefers-color-scheme:dark){.a{background:rgba(50,52,57,.95);color:#e8eaed;'
      + 'box-shadow:0 2px 7px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.12)}}';
    const anchor = document.createElement('div');
    anchor.className = 'a';
    anchor.style.left = ox + 'px';
    anchor.style.top = oy + 'px';
    anchor.innerHTML = asGlyph(canX, canY);
    root.append(style, anchor);
    document.documentElement.appendChild(overlay);

    // Sub-pixel accumulators so slow pans (cursor just past the deadzone) still
    // advance — scrollTop reads back rounded, which would otherwise stall them.
    let accX = 0, accY = 0, lastT = 0, raf = 0;
    const step = (delta, dt) => {
      const a = Math.abs(delta);
      return a <= AS_DEAD ? 0 : Math.sign(delta) * (a - AS_DEAD) * AS_SPEED * dt;
    };
    function frame(ts) {
      if (!lastT) lastT = ts;
      const dt = Math.min(0.05, (ts - lastT) / 1000);
      lastT = ts;
      if (canY) { accY += step(my - oy, dt); const i = Math.trunc(accY); if (i) { sc.scrollTop += i; accY -= i; } }
      if (canX) { accX += step(mx - ox, dt); const i = Math.trunc(accX); if (i) { sc.scrollLeft += i; accX -= i; } }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    const onMove = (ev) => { mx = ev.clientX; my = ev.clientY; };
    const onWheel = () => stop();
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); stop(); } };
    // A non-middle click ends it; middle-clicks are handled by the toggle guard
    // at the top of autoScroll, so ignore them here to avoid a double stop.
    const onDown = (ev) => { if (ev.button === 1) return; ev.preventDefault(); ev.stopPropagation(); stop(); };
    function stop() {
      if (asActive !== handle) return;   // already stopped (or superseded)
      asActive = null;
      cancelAnimationFrame(raf);
      overlay.remove();
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', stop, true);
    }
    const handle = { stop };
    asActive = handle;
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', stop, true);
    return true;
  }

  return { THIN, THICK, ZONE, MIN, PAGE, NATIVE_HIDE_CSS, railCss, thumbCss,
    compute, applyStyles, hitTest, startDrag, startPage, autoScroll };
});
