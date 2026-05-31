'use strict';

// ---------------------------------------------------------------------------
// Custom overlay scrollbar for the chrome's own pages (settings, history /
// downloads / passwords panels, the folder dialog). A thin indicator that
// floats OVER the content — it reserves no layout width, so showing/hiding it
// never shifts the page (the native scrollbar is hidden in CSS). It appears
// only while you're scrolling and fades out a beat after you stop. Chromium
// dropped real overlay scrollbars (the OverlayScrollbar flag) in 115, hence
// this hand-rolled version.
//
// INTERACTIVE: the thumb drags and the track click-pages like a real browser
// scrollbar, and the bar thickens while the pointer hovers it. To stay true to
// the "never swallows a click" philosophy the rail is pointer-events:none
// EXCEPT while the pointer is in its right-edge hover zone (or a drag is in
// progress), so content under the bar is fully clickable otherwise.
//
// The shared geometry / styles / interactions live in ScrollbarCore
// (scrollbarCore.js, loaded just before this); tabPreload.js draws the same bar
// on web pages from the very same module. This file owns only the single-target
// lifecycle and event wiring. Classic script: defines one global.
// ---------------------------------------------------------------------------
function overlayScrollbar(target) {
  if (!target) return;
  const C = ScrollbarCore;
  const isWin = target === window || target === document
    || target === document.documentElement || target === document.scrollingElement;
  const scroller = isWin ? (document.scrollingElement || document.documentElement) : target;
  const scrollSrc = isWin ? window : target;

  const rail = document.createElement('div');
  rail.style.cssText = C.railCss;
  const thumb = document.createElement('div');
  thumb.style.cssText = C.thumbCss;
  rail.appendChild(thumb);
  document.body.appendChild(rail);

  let active = false;     // within the post-scroll visible window?
  let hovering = false;   // pointer inside the hover zone?
  let dragging = false;
  let timer = null;
  let raf = 0;
  let moveRaf = 0, lastX = 0, lastY = 0;

  // Read this target's live dimensions and hand them to the shared geometry.
  function metrics() {
    let ch, sh, vTop, vH, right;
    if (isWin) {
      ch = window.innerHeight; sh = scroller.scrollHeight; vTop = 0; vH = window.innerHeight; right = 2;
    } else {
      ch = scroller.clientHeight; sh = scroller.scrollHeight;
      const r = scroller.getBoundingClientRect();
      if (r.height === 0) return null;
      vTop = r.top; vH = r.height; right = window.innerWidth - r.right + 2;
    }
    return C.compute({ ch, sh, vTop, vH, right, scrollTop: scroller.scrollTop });
  }

  function render() {
    raf = 0;
    const m = metrics();
    const thick = hovering || dragging;
    if (m) C.applyStyles(rail, thumb, m, isWin, thick);
    rail.style.opacity = (m && (active || hovering || dragging)) ? '1' : '0';
    rail.style.pointerEvents = (m && (hovering || dragging)) ? 'auto' : 'none';
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(render); };

  function hitTest(x, y) {
    const m = metrics();
    return m ? C.hitTest(x, y, m, isWin, window.innerWidth) : false;
  }

  function startDrag(e) {
    const started = C.startDrag(e, {
      getMetrics: metrics,
      getScroller: () => scroller,
      onEnd: (ev) => { dragging = false; hovering = hitTest(ev.clientX, ev.clientY); schedule(); },
    });
    if (!started) return;
    dragging = true;
    schedule();
  }

  rail.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.target === thumb) startDrag(e);
    else C.startPage(e, { getMetrics: metrics, getScroller: () => scroller });
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

// Middle-click autoscroll for the chrome's own scrollable surfaces (panels,
// settings, the folder dialog). Wired once per page — the shared core finds the
// scroller under the press and no-ops when nothing scrolls there (e.g. a
// middle-click on the toolbar or a tab, leaving those handlers untouched).
window.addEventListener('mousedown', (e) => { if (e.button === 1) ScrollbarCore.autoScroll(e); }, true);
