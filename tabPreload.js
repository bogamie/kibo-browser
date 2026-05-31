'use strict';

// ---------------------------------------------------------------------------
// Content preload — runs inside every web page in an isolated, sandboxed
// world. It exposes NOTHING to the page (no window globals); it only:
//   1. Reports when the pointer touches the top edge, so the main process can
//      reveal the auto-hidden chrome (Zen-style).
//   2. Captures username/password on login form submit and offers to save it.
//   3. Autofills saved credentials for the current origin on page load.
//   4. Restyles the page's scrollbars into a thin, idle-hiding minimal form.
// The DOM/ipc work talks to main over ipcRenderer and styles the frame via
// webFrame; the page itself can't see any of it.
// ---------------------------------------------------------------------------
const { ipcRenderer, webFrame } = require('electron');
// Shared overlay-scrollbar core. esbuild inlines this into dist/tabPreload.js at
// build time — a sandboxed preload can't require local files at runtime (see
// build.js). ui/overlayScrollbar.js draws the same bar on the chrome's own pages
// from this very module.
const C = require('./ui/scrollbarCore.js');

// ---- 1. Auto-hide reveal: pointer near the top edge -----------------------
// Two thresholds (hysteresis) so the bar doesn't flicker: reveal when the
// pointer reaches the top SHOW_AT px, hide once it moves below HIDE_BELOW px.
const SHOW_AT = 6;
const HIDE_BELOW = 150;
let shownTop = false; // false = pointer is in the "hidden" zone
let lastMove = 0;
function reportEdge(e) {
  const now = performance.now();
  if (now - lastMove < 100) return; // throttle: the reveal gesture is coarse
  lastMove = now;
  if (e.clientY <= SHOW_AT) {
    if (!shownTop) { shownTop = true; ipcRenderer.send('edge:enter'); }
  } else if (e.clientY > HIDE_BELOW) {
    if (shownTop) { shownTop = false; ipcRenderer.send('edge:leave'); }
  }
}
window.addEventListener('mousemove', reportEdge, { passive: true, capture: true });
// Also reveal when the pointer re-enters the page from the top edge.
window.addEventListener('mouseenter', reportEdge, { passive: true, capture: true });

// ---- thin overlay scrollbars (ALL scroll areas on the page) ---------------
// Hide every native scrollbar (no reserved gutter → content never shifts) and
// draw our own thin indicator over whatever is being scrolled — the main page OR
// any inner scroll container — so scrollbars look identical across every site.
// Each indicator shows only while its element is scrolling and fades ~1.1s after
// it stops. insertCSS is a user stylesheet (CSP-proof), re-applied per document;
// the universal selector covers scrollbar-width (which isn't inherited).
// The geometry / styles / interactions come from the shared ScrollbarCore (`C`,
// inlined above); this section owns only the per-page lifecycle — a rail+thumb
// per scrolled target, created on scroll and removed after it fades. To keep the
// "never swallows a click" promise each rail is pointer-events:none EXCEPT while
// the pointer is in its hover zone (or a drag is underway).
webFrame.insertCSS(C.NATIVE_HIDE_CSS);

const sbThumbs = new Map();   // scrolled target (Element or document) -> state

// Keep thumbs in sync when content SIZE changes without a scroll or window resize
// — images/fonts settling, lazy content, async DOM growth. Otherwise the bar sits
// stale (wrong size/position) until the next scroll, and visibly so mid-drag.
// The document's growth boxes (documentElement/body) grow with page content, so
// observing them catches the main page; inner scrollers are observed as created.
// Re-measure every thumb when content changes WITHOUT a scroll or window resize.
// NOT a ResizeObserver: re-measuring writes styles into our overlay rail/thumb,
// which trips ResizeObserver's resize-loop guard and makes it silently stop
// delivering after a notification or two (verified). MutationObserver has no such
// guard. It catches DOM-driven content growth (lazy/async/infinite scroll); a
// capture-phase `load` listener catches images/media that reflow without
// mutating the DOM. Both coalesce through sbPaint's rAF.
function sbSyncAll() { for (const [t, s] of sbThumbs) sbPaint(t, s); }
const sbMO = (typeof MutationObserver !== 'undefined') ? new MutationObserver(sbSyncAll) : null;
// This preload runs before the document is parsed — documentElement may still be
// null here, so observe once it exists rather than at top level (which would
// throw and abort the rest of the script).
function sbWatchContent() {
  try { if (sbMO && document.documentElement) sbMO.observe(document.documentElement, { childList: true, subtree: true }); } catch { /* not ready */ }
}
if (document.documentElement) sbWatchContent();
else document.addEventListener('DOMContentLoaded', sbWatchContent, { once: true });
window.addEventListener('load', sbSyncAll, { capture: true, passive: true });

function sbIsDoc(target) {
  return target === document || target === document.documentElement || target === document.scrollingElement;
}
function sbScroller(target) {
  return sbIsDoc(target) ? (document.scrollingElement || document.documentElement) : target;
}

function sbMetrics(target) {
  const isDoc = sbIsDoc(target);
  const sc = sbScroller(target);
  let ch, sh, vTop, vH, right;
  if (isDoc) {
    ch = window.innerHeight; sh = sc.scrollHeight; vTop = 0; vH = ch; right = 2;
  } else {
    if (!(target instanceof Element)) return null;
    ch = target.clientHeight; sh = target.scrollHeight;
    const r = target.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    vTop = r.top; vH = r.height; right = window.innerWidth - r.right + 2;
  }
  const m = C.compute({ ch, sh, vTop, vH, right, scrollTop: sc.scrollTop });
  if (m) m.isDoc = isDoc;   // callers (sbMeasure/sbHit) read this back
  return m;
}

function sbMeasure(target, s) {
  s.raf = 0;
  const m = sbMetrics(target);
  const thick = s.hovering || s.dragging;
  if (m) {
    s.isDoc = m.isDoc;
    C.applyStyles(s.rail, s.thumb, m, m.isDoc, thick);
  }
  s.rail.style.opacity = (m && (s.active || s.hovering || s.dragging)) ? '1' : '0';
  s.rail.style.pointerEvents = (m && (s.hovering || s.dragging)) ? 'auto' : 'none';
}
const sbPaint = (target, s) => { if (!s.raf) s.raf = requestAnimationFrame(() => sbMeasure(target, s)); };

function sbHit(target, x, y) {
  const m = sbMetrics(target);
  return m ? C.hitTest(x, y, m, m.isDoc, window.innerWidth) : false;
}

function sbEnsure(target) {
  let s = sbThumbs.get(target);
  if (s) return s;
  if (!sbMetrics(target)) return null;          // target isn't actually scrollable
  const rail = document.createElement('div');
  rail.style.cssText = C.railCss;
  const thumb = document.createElement('div');
  thumb.style.cssText = C.thumbCss;
  rail.appendChild(thumb);
  // Append to <html> (not <body>): a transform on body would make this fixed
  // rail scroll with the page.
  document.documentElement.appendChild(rail);
  s = { rail, thumb, active: false, hovering: false, dragging: false, raf: 0, hideT: null, killT: null, isDoc: sbIsDoc(target) };
  sbThumbs.set(target, s);
  sbWire(target, s);
  return s;
}

function sbScheduleHide(target, s) {
  clearTimeout(s.hideT);
  s.hideT = setTimeout(() => {
    if (s.hovering || s.dragging) return;
    s.active = false;
    sbPaint(target, s);
    s.killT = setTimeout(() => {
      if (s.hovering || s.dragging || s.isDoc) return; // keep the main-page bar for hover re-grab
      s.rail.remove();
      sbThumbs.delete(target);
    }, 320);
  }, 1100);
}

function sbShow(target) {
  const s = sbEnsure(target);
  if (!s) return;
  s.active = true;
  if (s.killT) { clearTimeout(s.killT); s.killT = null; }
  sbPaint(target, s);
  sbScheduleHide(target, s);
}

// ---- drag the thumb / page the track --------------------------------------
function sbStartDrag(target, s, e) {
  const started = C.startDrag(e, {
    getMetrics: () => sbMetrics(target),
    getScroller: () => sbScroller(target),
    onEnd: (ev) => {
      s.dragging = false;
      s.hovering = sbHit(target, ev.clientX, ev.clientY);
      if (!s.hovering) sbScheduleHide(target, s);
      sbPaint(target, s);
    },
  });
  if (!started) return;
  s.dragging = true;
  sbPaint(target, s);
}

function sbStartPage(target, e) {
  C.startPage(e, { getMetrics: () => sbMetrics(target), getScroller: () => sbScroller(target) });
}

function sbWire(target, s) {
  s.rail.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();                              // shield the page from scrollbar clicks
    if (e.target === s.thumb) sbStartDrag(target, s, e); else sbStartPage(target, e);
  });
}

// Capture phase: scroll events don't bubble, so capture catches them from the
// document AND from any inner scroll container.
document.addEventListener('scroll', (e) => sbShow(e.target), { capture: true, passive: true });
window.addEventListener('resize', () => {
  for (const [t, s] of sbThumbs) sbPaint(t, s);
}, { passive: true });

// Hover detection by pointer proximity — toggles thicken + interactivity per
// target without ever reserving a permanent click-swallowing strip. Also summons
// the persistent main-page bar when the pointer nears the right edge.
let sbMoveRaf = 0, sbLastX = 0, sbLastY = 0;
function sbHover() {
  sbMoveRaf = 0;
  if (sbLastX >= window.innerWidth - C.ZONE - 2 && sbMetrics(document)) sbEnsure(document);
  for (const [t, s] of sbThumbs) {
    if (s.dragging) continue;
    const h = sbHit(t, sbLastX, sbLastY);
    if (h === s.hovering) continue;
    s.hovering = h;
    if (h) { clearTimeout(s.hideT); if (s.killT) { clearTimeout(s.killT); s.killT = null; } }
    else { sbScheduleHide(t, s); }
    sbPaint(t, s);
  }
}
window.addEventListener('mousemove', (e) => {
  sbLastX = e.clientX; sbLastY = e.clientY;
  if (!sbMoveRaf) sbMoveRaf = requestAnimationFrame(sbHover);
}, { passive: true, capture: true });

// Pointer left the window / focus lost: no mousemove will fire to drop hover, so
// clear it explicitly — otherwise a rail could stay pointer-events:auto over
// content along the right edge.
function sbClearHover() {
  for (const [t, s] of sbThumbs) {
    if (!s.hovering) continue;
    s.hovering = false;
    sbScheduleHide(t, s);
    sbPaint(t, s);
  }
}
// Use `window` (always present; documentElement may not be yet): a mouseout with
// no relatedTarget means the pointer left the window entirely.
window.addEventListener('mouseout', (e) => { if (!e.relatedTarget) sbClearHover(); }, { passive: true, capture: true });
window.addEventListener('blur', sbClearHover, { passive: true });

// ---- password manager helpers ---------------------------------------------
function passwordFields() {
  return [...document.querySelectorAll('input[type="password"]')].filter((el) => el.offsetParent !== null || el.type === 'password');
}

// Find the username field most likely paired with a given password field:
// the closest preceding text/email/tel input inside the same form.
function usernameFor(pwEl) {
  const form = pwEl.form || document;
  const candidates = [...form.querySelectorAll('input')].filter((el) => {
    const t = (el.type || 'text').toLowerCase();
    return ['text', 'email', 'tel', 'username', ''].includes(t) && el !== pwEl;
  });
  // last text-like field before the password field wins
  let best = null;
  for (const el of candidates) {
    if (el.compareDocumentPosition(pwEl) & Node.DOCUMENT_POSITION_FOLLOWING) best = el;
  }
  return best || candidates[0] || null;
}

function captureFrom(formOrDoc) {
  const pw = [...formOrDoc.querySelectorAll('input[type="password"]')][0];
  if (!pw || !pw.value) return;
  const userEl = usernameFor(pw);
  ipcRenderer.send('password:captured', {
    origin: location.origin,
    username: userEl ? userEl.value : '',
    password: pw.value,
  });
}

// ---- 2. Capture on submit (and on Enter / button click fallbacks) ---------
window.addEventListener('submit', (e) => { try { captureFrom(e.target); } catch {} }, true);

// Some sites log in via JS without a real form submit — capture when a
// password field has a value and focus leaves it for a likely submit button.
document.addEventListener(
  'click',
  (e) => {
    const t = e.target;
    const looksLikeSubmit =
      t && (t.type === 'submit' || /log\s?in|sign\s?in|로그인|continue|다음/i.test(t.textContent || t.value || ''));
    if (looksLikeSubmit) {
      const pw = passwordFields().find((p) => p.value);
      if (pw) captureFrom(pw.form || document);
    }
  },
  true,
);

// ---- 3. Autofill on load --------------------------------------------------
async function autofill() {
  let creds;
  try { creds = await ipcRenderer.invoke('passwords:get', location.origin); } catch { return; }
  if (!creds || !creds.length) return;
  const pw = passwordFields()[0];
  if (!pw) return;
  const cred = creds[0]; // most recent
  const userEl = usernameFor(pw);
  const setVal = (el, v) => {
    if (!el || v == null) return;
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, v) : (el.value = v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (userEl && cred.username) setVal(userEl, cred.username);
  setVal(pw, cred.password);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(autofill, 150));
} else {
  setTimeout(autofill, 150);
}
