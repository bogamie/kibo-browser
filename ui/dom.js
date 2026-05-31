'use strict';

// Shared DOM refs, icons, app state, layout reporting, toast, and tiny render
// helpers. Loaded first (after i18n.js); every other chrome script builds on
// these globals. Classic scripts share one global lexical scope, so these are
// visible across all the chrome-*.js files (same pattern as i18n.js's tr()).

const $ = (s) => document.querySelector(s);

// ---- elements -------------------------------------------------------------
const bar = $('#bar');
const address = $('#address');
const tabstrip = $('#tabstrip');
const bookmarkbar = $('#bookmarkbar');
const backBtn = $('#back');
const fwdBtn = $('#forward');
const star = $('#star');
const lock = $('#lock');
const shield = $('#shield');
const shieldcount = $('#shieldcount');
const menupop = $('#menupop');
const bmedit = $('#bmedit');
const bmtree = $('#bmtree');
const bmfolderpop = $('#bmfolderpop');
const bmctx = $('#bmctx');
const panel = $('#panel');
const panelTitle = $('#paneltitle');
const panelBody = $('#panelbody');
const interstitial = $('#interstitial');
const findbar = $('#findbar');
const findinput = $('#findinput');
const findcount = $('#findcount');
const saveprompt = $('#saveprompt');
const savetext = $('#savetext');

// ---- SVG icons ------------------------------------------------------------
// One consistent line-icon set (viewBox 0 0 16 16, currentColor) reused for all
// dynamically-rendered chrome so nothing depends on OS emoji/glyph metrics.
// No width/height attributes — size is controlled solely by CSS per context
// (Chromium lets the SVG width/height *attribute* win over CSS, so we omit it).
const svgIcon = (inner, { sw = 1.5, fill = 'none' } = {}) =>
  `<svg viewBox="0 0 16 16" fill="${fill}" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const STAR_PATH = '<path d="M8 1.7l1.9 3.96 4.35.63-3.15 3.07.74 4.32L8 11.65 4.31 13.75l.74-4.32L1.9 6.36l4.35-.63z"/>';
// All chrome button icons share one size (16) and stroke (1.5).
const ICONS = {
  close: svgIcon('<path d="M4 4l8 8M12 4l-8 8"/>'),
  star: svgIcon(STAR_PATH),
  starFilled: svgIcon(STAR_PATH, { fill: 'currentColor' }),
  lock: svgIcon('<rect x="3.5" y="7.2" width="9" height="6" rx="1.2"/><path d="M5.5 7.2V5.3a2.5 2.5 0 0 1 5 0v1.9"/>'),
  warn: svgIcon('<path d="M8 2.4L14.3 13.4H1.7z"/><path d="M8 6.6v3"/><path d="M8 11.4h.01"/>'),
  folder: svgIcon('<path d="M2 4.6a1.4 1.4 0 0 1 1.4-1.4h2.7a1 1 0 0 1 .78.37l.66 1.46a1 1 0 0 0 .78.37h4.26a1.4 1.4 0 0 1 1.4 1.4v4.6a1.4 1.4 0 0 1-1.4 1.4H3.4a1.4 1.4 0 0 1-1.4-1.4z"/>'),
  globe: svgIcon('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2.2 1.8 2.2 10.2 0 12M8 2c-2.2 1.8-2.2 10.2 0 12"/>'),
  eye: svgIcon('<path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  trash: svgIcon('<path d="M3.5 4.5h9"/><path d="M6.3 4.5V3.2h3.4v1.3"/><path d="M5 4.7l.5 8.1h5l.5-8.1"/>'),
  gear: svgIcon('<circle cx="8" cy="8" r="2.1"/><path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.53 3.47l-1.27 1.27M4.74 11.26l-1.27 1.27M12.53 12.53l-1.27-1.27M4.74 4.74L3.47 3.47"/>'),
};
const DOT = '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="4"/></svg>';
const SPINNER = svgIcon('<path d="M13 8a5 5 0 1 1-1.46-3.54"/>', { sw: 1.6 });

// ---- shared state ---------------------------------------------------------
let activeTab = null;
let editingAddress = false;
let state = { settings: {}, bookmarks: [], bookmarkFolders: [], blocked: 0, incognito: false, vaultAvailable: true, osEncryption: true };
let bmDragActive = false; // a bookmark-bar chip is being dragged (cover full window)

// Favicons that failed to load — fall back to the status dot / globe. We count
// failures per URL and retry a few times before giving up: the chrome view
// re-fetches favicons over the default session (no page cookies/referer, cold
// cache), so a single transient miss shouldn't blacklist a good icon for the
// rest of the session. A successful load clears the count. Inline onerror is
// blocked by CSP, so we catch <img> load/error in the capture phase (see the
// listeners in tabs.js / bookmarks.js).
const faviconFail = new Map(); // favicon URL -> consecutive failure count
const FAVICON_MAX_STRIKES = 3;
function faviconBlocked(url) { return (faviconFail.get(url) || 0) >= FAVICON_MAX_STRIKES; }
function faviconStrike(url) { if (url) faviconFail.set(url, (faviconFail.get(url) || 0) + 1); }
function faviconOk(url) { if (url) faviconFail.delete(url); }

// ---- tiny DOM-diff helpers ------------------------------------------------
function setText(node, v) { if (node.textContent !== v) node.textContent = v; }
function setHTML(node, v) { if (node._html !== v) { node._html = v; node.innerHTML = v; } }
function setClass(node, v) { if (node.className !== v) node.className = v; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// Toast: brief bottom-center notice. The toast lives below the top bar, so we
// flag it into overlayOpen() — that keeps the chrome view full-window (instead
// of bar-height) while it's shown, otherwise it'd be clipped off-screen.
// ---------------------------------------------------------------------------
let _toastEl = null;
let _toastTimer = null;
let _toastVisible = false;
function showToast(msg) {
  if (!_toastEl) {
    _toastEl = document.createElement('div');
    _toastEl.style.cssText =
      'position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(12px);' +
      'max-width:80vw;padding:10px 16px;border-radius:8px;white-space:nowrap;' +
      'background:rgba(20,20,30,.94);color:#e6e6f0;font-size:13px;' +
      'border:1px solid rgba(255,255,255,.08);box-shadow:0 6px 24px rgba(0,0,0,.45);' +
      'opacity:0;pointer-events:none;z-index:9999;' +
      'transition:opacity .18s ease, transform .18s ease;';
    document.body.appendChild(_toastEl);
  }
  _toastEl.textContent = msg;
  _toastVisible = true;
  reportLayout(); // keep chrome full-window so the toast is visible
  requestAnimationFrame(() => {
    _toastEl.style.opacity = '1';
    _toastEl.style.transform = 'translateX(-50%) translateY(0)';
  });
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(hideToast, 2200);
}
function hideToast() {
  if (!_toastEl) return;
  _toastEl.style.opacity = '0';
  _toastEl.style.transform = 'translateX(-50%) translateY(12px)';
  _toastVisible = false;
  reportLayout();
}
function notImplemented() { showToast(tr('notImplemented')); }

// ---------------------------------------------------------------------------
// Layout: report the bar height + whether an overlay covers the whole window
// so the main process can size the content view (and float the bar in
// auto-hide mode).
// ---------------------------------------------------------------------------
function overlayOpen() {
  return bmDragActive || !menupop.hidden || !panel.hidden || !interstitial.hidden
      || !bmedit.hidden || !bmtree.hidden || !bmfolderpop.hidden || !bmctx.hidden || _toastVisible;
}
// A transient popup that an outside-click should dismiss. While one is open we
// drop the window-move regions to no-drag (see .popup-open) so a click on the
// tab/tool rows dispatches a real click instead of the OS starting a window drag
// and swallowing it. Synced here since every popup open/close calls reportLayout.
function syncPopupDrag() {
  const open = !menupop.hidden || !bmfolderpop.hidden || !bmctx.hidden || !bmedit.hidden;
  document.body.classList.toggle('popup-open', open);
}
// Coalesce to one report per frame and skip the IPC when nothing changed —
// this breaks the ResizeObserver -> IPC -> setBounds -> resize feedback loop.
let _lastH = -1, _lastTop = -1, _lastOverlay = null, _rafScheduled = false;
function reportLayout() {
  syncPopupDrag();
  if (_rafScheduled) return;
  _rafScheduled = true;
  requestAnimationFrame(() => {
    _rafScheduled = false;
    // The find bar is position:absolute (out of the bar's flow), so the bar height
    // is identical whether find is open or closed — that's `contentTop`, where the
    // content view starts, and it never moves. The chrome view, however, must grow
    // by the find bar's height so the floating bar (drawn over the page's top edge)
    // isn't clipped.
    const contentTop = Math.ceil(bar.getBoundingClientRect().height);
    const findH = findbar.hidden ? 0 : Math.ceil(findbar.getBoundingClientRect().height);
    const height = contentTop + findH;
    const overlay = overlayOpen();
    if (height === _lastH && contentTop === _lastTop && overlay === _lastOverlay) return;
    _lastH = height; _lastTop = contentTop; _lastOverlay = overlay;
    window.api.setLayout({ height, contentTop, overlay });
  });
}
new ResizeObserver(reportLayout).observe(bar);
window.addEventListener('load', reportLayout);

// Thin overlay scrollbars for our scrollable surfaces (see overlayScrollbar.js).
// The native scrollbars are hidden in style.css, so these float over the content
// without reserving a gutter.
overlayScrollbar(panelBody);
overlayScrollbar($('#bmtree-list'));
