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

// ---- middle-click autoscroll (pan) ----------------------------------------
// Capture on window so we engage before the page's own handlers. The shared
// core decides whether to start (skips links / editable fields / non-scrollable
// targets) and owns the anchor + scroll loop; only the wiring lives here.
window.addEventListener('mousedown', (e) => { if (e.button === 1) C.autoScroll(e); }, true);

// ---- Shift + wheel → horizontal scroll ------------------------------------
// Translate a vertical wheel into horizontal scroll while Shift is held. This
// must be a NON-passive listener (it calls preventDefault to suppress the
// browser's default vertical scroll), so it bails on the very first line for the
// overwhelmingly common no-Shift wheel — keeping normal scrolling on the
// compositor fast path. Only engages when an ancestor actually scrolls
// horizontally; otherwise it leaves the event alone.
function findHScroller(el) {
  for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && n.scrollWidth - n.clientWidth > 1) return n;
  }
  const de = document.scrollingElement || document.documentElement;
  return de && de.scrollWidth - de.clientWidth > 1 ? de : null;
}
window.addEventListener('wheel', (e) => {
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.deltaX !== 0) return;            // already a horizontal wheel (trackpad) — leave it
  const sc = findHScroller(e.target);
  if (!sc) return;
  e.preventDefault();
  sc.scrollLeft += e.deltaY;
}, { capture: true, passive: false });

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
// Is the element actually visible & interactable? Used to refuse autofill/capture
// on hidden or zero-size password fields — a page can stage those to harvest a
// silently-filled credential.
function isVisible(el) {
  if (!el || el.type === 'hidden') return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
}

function passwordFields() {
  return [...document.querySelectorAll('input[type="password"]')].filter(isVisible);
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

// ---- 3. Autofill on load (+ SPA late-render retry) ------------------------
let CREDS = null;          // saved credentials for this origin (fetched once)
let lastFilledPw = null;   // the password field we already auto-filled
let lastFilledUser = null; // the standalone username field we already filled

async function getCreds() {
  if (CREDS) return CREDS;
  try { CREDS = await ipcRenderer.invoke('passwords:get', location.origin); }
  catch { CREDS = []; }
  return (CREDS = CREDS || []);
}

// Localized picker labels — the content world has no access to ui/i18n.js, so
// main returns them (see the passwords:labels handler).
let LABELS = null;
async function getLabels() {
  if (LABELS) return LABELS;
  try { LABELS = await ipcRenderer.invoke('passwords:labels'); }
  catch { LABELS = null; }
  return LABELS;
}

// Write a value the way a real keystroke would: go through the native setter so
// React/Vue's value tracker notices, then fire input+change.
function setVal(el, v) {
  if (!el || v == null) return;
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter ? setter.call(el, v) : (el.value = v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillFields(userEl, pwEl, cred) {
  if (userEl && cred.username) setVal(userEl, cred.username);
  if (pwEl) setVal(pwEl, cred.password);
}

// A username/email field NOT paired with a password field on this page — i.e. an
// identifier-first login step (Google asks for the email first, then the password
// on the next page). Strong login signals only, so we don't grab a random
// email/search box.
function standaloneUsernameField() {
  const sel = 'input[autocomplete="username"],input[autocomplete="email"],input[type="email"],' +
    'input[name*="user" i],input[name*="email" i],input[id*="identifier" i],input[name*="login" i]';
  return [...document.querySelectorAll(sel)].filter(isVisible)[0] || null;
}

// The identifier (email/username) already entered on the page, read from any
// username/email input — INCLUDING hidden ones, since identifier-first flows
// (Google) carry the chosen email in a hidden field on the password step. Empty
// string when nothing has been entered yet.
function currentIdentifier() {
  const sel = 'input[autocomplete="username"],input[type="email"],' +
    'input[name*="identifier" i],input[name*="user" i],input[name*="email" i]';
  for (const el of document.querySelectorAll(sel)) {
    const v = (el.value || '').trim();
    if (v) return v;
  }
  return '';
}

function credFor(identifier) {
  const id = identifier.trim().toLowerCase();
  return (CREDS || []).find((c) => (c.username || '').trim().toLowerCase() === id) || null;
}

// An email shown as plain text on the page. Identifier-first password steps often
// render the chosen account as a chip/header rather than an input; reading it lets
// us refuse to fill a saved password when an UNSAVED account is selected. Used
// only as a fallback on password-only pages (see autofill).
function shownEmail() {
  const m = (document.body?.innerText || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : '';
}

// Set up autofill for the first visible login form. Handles both single-page
// forms and identifier-first flows (username now, password on the next page).
// Returns true only once the PASSWORD field has been handled, so the SPA observer
// keeps watching after a username-only step. The dangerous case — filling a
// hidden or iframed form staged to harvest the secret — is blocked by isVisible()
// and the top-frame guard in startAutofill().
function autofill() {
  const creds = CREDS || [];
  if (!creds.length) return false;
  const pw = passwordFields()[0];
  const userEl = pw ? usernameFor(pw) : standaloneUsernameField();
  if (pw) { if (pw === lastFilledPw) return false; lastFilledPw = pw; }
  else if (userEl) { if (userEl === lastFilledUser) return false; lastFilledUser = userEl; }
  else return false;

  // Figure out which account is in play. Prefer a real input value; on a
  // password-only step (identifier-first, no editable username field) fall back to
  // an email shown on the page. If an identifier is known, fill ONLY for the
  // matching saved account — never a saved password under a different, unsaved
  // email.
  // Always offer the account chooser on click/focus — for a single account too.
  attachPicker(userEl, pw, creds);

  let typed = currentIdentifier();
  if (!typed && pw && !userEl) typed = shownEmail();
  if (typed) {
    const match = credFor(typed);
    if (match) fillFields(userEl, pw, match);
    return !!pw; // matched → filled; otherwise intentionally nothing
  }

  // Nothing entered yet: a single saved account fills on load; multiple accounts
  // wait for an explicit pick from the chooser.
  if (creds.length === 1) fillFields(userEl, pw, creds[0]);
  return !!pw;
}

// ---- 1. Account picker ----------------------------------------------------
// Focusing/clicking a login field surfaces a Chrome-style chooser (saved
// account(s) + "Manage passwords"), even with a single saved account. It lives
// in a closed shadow root attached to <html>, so the page's CSS/JS can neither
// style nor read it — consistent with this preload exposing nothing to the page.
let pickerHost = null;
let pickerAnchors = [];   // login fields that toggle the picker (don't self-dismiss)
let pickerOpenFor = null; // the field the picker is currently open under
function removePicker() {
  const host = pickerHost;
  pickerHost = null;
  pickerOpenFor = null; // treat as closed at once, so a re-open during the fade is clean
  if (!host) return;
  if (!host.animate || matchMedia('(prefers-reduced-motion:reduce)').matches) { host.remove(); return; }
  // Fade + slide up, then remove (the reverse of the open animation).
  const anim = host.animate(
    [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-4px)' }],
    { duration: 100, easing: 'ease-in' },
  );
  anim.onfinish = anim.oncancel = () => host.remove();
}

function attachPicker(userEl, pwEl, creds) {
  if (!creds || !creds.length) return;
  pickerAnchors = [pwEl, userEl].filter(Boolean);
  for (const a of pickerAnchors) {
    // Click toggles the chooser: open under this field; click the same field
    // again to close. (No focus-open, so it only appears on an explicit click.)
    a.addEventListener('mousedown', () => {
      if (pickerHost && pickerOpenFor === a) removePicker();
      else { showPicker(a, userEl, pwEl, creds); pickerOpenFor = a; }
    });
  }
}

// No width/height attrs — sized by `.ico svg` in the picker CSS (per project
// convention; the SVG size attribute would otherwise override CSS).
const KEY_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="10" r="3"/><path d="M8 8l5-5M11 5l1.5 1.5"/></svg>';

// The site's favicon (declared <link>, else the conventional /favicon.ico),
// shown in each row like Chrome. Falls back to a key glyph if it fails to load.
function faviconUrl() {
  const link = document.querySelector('link[rel~="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]');
  if (link && link.href) return link.href;
  try { return location.origin + '/favicon.ico'; } catch { return ''; }
}
function makeFavicon() {
  const box = document.createElement('span'); box.className = 'ico';
  const url = faviconUrl();
  if (url) {
    const img = document.createElement('img');
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => { box.innerHTML = KEY_SVG; };
    img.src = url;
    box.append(img);
  } else { box.innerHTML = KEY_SVG; }
  return box;
}

function showPicker(anchor, userEl, pwEl, creds) {
  removePicker();
  const labels = LABELS || { fromThisSite: 'From this website', manage: 'Manage Passwords' };
  const rect = anchor.getBoundingClientRect();
  pickerHost = document.createElement('div');
  Object.assign(pickerHost.style, {
    position: 'fixed', left: rect.left + 'px', top: (rect.bottom + 2) + 'px',
    width: Math.max(rect.width, 260) + 'px', zIndex: '2147483647',
  });
  const root = pickerHost.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent =
    '*{box-sizing:border-box}' +
    '@keyframes mbpop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}' +
    '.menu{font:13px/1.45 system-ui,-apple-system,sans-serif;background:#292a2d;color:#e3e3e3;' +
    'border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden;padding:4px 0;' +
    'transform-origin:top;animation:mbpop .12s ease-out}' +
    '@media(prefers-reduced-motion:reduce){.menu{animation:none}}' +
    '.row{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer}' +
    '.row:hover{background:#3c3d40}' +
    '.ico{width:16px;height:16px;flex:0 0 16px;display:flex;align-items:center;justify-content:center;color:#9aa0a6}' +
    '.ico img{width:16px;height:16px;border-radius:3px;object-fit:contain}' +
    '.ico svg{width:14px;height:14px}' +
    '.txt{min-width:0}' +
    '.u{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.sub{font-size:12px;color:#9aa0a6}' +
    '.sep{height:1px;background:#3c3d40;margin:4px 0}' +
    '.manage{padding:10px 14px;cursor:pointer}.manage:hover{background:#3c3d40}';
  const menu = document.createElement('div'); menu.className = 'menu';

  for (const c of creds) {
    const row = document.createElement('div'); row.className = 'row';
    const txt = document.createElement('div'); txt.className = 'txt';
    const u = document.createElement('div'); u.className = 'u'; u.textContent = c.username || '(no username)';
    const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = labels.fromThisSite;
    txt.append(u, sub);
    row.append(makeFavicon(), txt);
    // mousedown + preventDefault: fill before the field blurs / page handlers run.
    row.addEventListener('mousedown', (e) => { e.preventDefault(); fillFields(userEl, pwEl, c); removePicker(); });
    menu.append(row);
  }

  const sep = document.createElement('div'); sep.className = 'sep';
  const manage = document.createElement('div'); manage.className = 'manage'; manage.textContent = labels.manage;
  manage.addEventListener('mousedown', (e) => { e.preventDefault(); ipcRenderer.send('ui:openPasswords'); removePicker(); });
  menu.append(sep, manage);

  root.append(style, menu);
  document.documentElement.append(pickerHost);
}

// Dismiss on an outside mousedown — but NOT on a toggle anchor (its own handler
// closes it) and NOT inside the menu.
document.addEventListener('mousedown', (e) => {
  if (!pickerHost) return;
  if (pickerHost.contains(e.target) || pickerAnchors.includes(e.target)) return;
  removePicker();
}, true);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') removePicker(); }, true);
window.addEventListener('scroll', removePicker, { capture: true, passive: true });
window.addEventListener('resize', removePicker, { passive: true });

// Many login pages (SPAs) mount the form after first paint. Fill once now, and
// if there's nothing to fill yet, watch the DOM until the form shows up — with a
// hard time cap so we don't observe forever.
function watchForForms() {
  if (!('MutationObserver' in window)) return;
  const obs = new MutationObserver(() => { if (autofill()) obs.disconnect(); });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 15000);
}

async function startAutofill() {
  if (window.top !== window.self) return; // never autofill inside iframes
  const creds = await getCreds();
  if (!creds.length) return;       // nothing saved → don't fill or observe
  getLabels();                     // warm the localized picker labels
  if (autofill()) return;          // form already present
  watchForForms();                 // SPA: wait for it
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(startAutofill, 150));
} else {
  setTimeout(startAutofill, 150);
}
