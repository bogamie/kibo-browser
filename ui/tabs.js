'use strict';

// ---------------------------------------------------------------------------
// Tab strip: render tabs from main's tabs:update broadcast and keep the toolbar
// (address, back/forward, lock, star) in sync with the active tab.
// ---------------------------------------------------------------------------
// Keyed reuse: only touch DOM that actually changed (the tab strip otherwise
// fully rebuilds on every loading-spinner / title tick, repainting constantly).
const tabEls = new Map(); // id -> { el, dot, title }

// Per-kind presentation for internal pages (mirrors main's INTERNAL map), so the
// renderer doesn't special-case each kind with ternaries.
const INTERNAL_UI = {
  settings:  { icon: 'gear', titleKey: 'panel_settings' },
  passwords: { icon: 'lock', titleKey: 'panel_passwords' },
};

// A failed favicon falls back to the security dot (helper in dom.js).
wireFaviconFallback(tabstrip, '.dot', DOT);

// Wheel over the tab strip cycles tabs (Firefox-style). Cooldown so one notch =
// one tab — wheels/trackpads fire a burst of events per scroll.
let lastTabWheel = 0;
tabstrip.addEventListener('wheel', (e) => {
  e.preventDefault();
  const now = performance.now();
  if (now - lastTabWheel < 80) return;
  lastTabWheel = now;
  window.api.cycleTab((e.deltaY || e.deltaX) > 0 ? 1 : -1);
}, { passive: false });

function makeTabEl(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.tabId = String(id);   // hit-testing target for bookmark-onto-tab drops
  el.onclick = () => window.api.selectTab(id);
  // Middle-click anywhere on a tab closes it (standard browser gesture).
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); window.api.closeTab(id); }
  });
  const dot = document.createElement('span');
  const title = document.createElement('span');
  title.className = 'title';
  const close = document.createElement('button');
  close.className = 'close';
  close.innerHTML = ICONS.close;
  close.onclick = (e) => { e.stopPropagation(); window.api.closeTab(id); };
  el.append(dot, title, close);
  const rec = { el, dot, title };
  tabEls.set(id, rec);
  return rec;
}

window.api.onTabs((tabs) => {
  const seen = new Set();
  let prev = null;
  for (const t of tabs) {
    seen.add(t.id);
    const rec = tabEls.get(t.id) || makeTabEl(t.id);
    const internal = t.internal;        // 'settings' for the internal Settings tab
    setClass(rec.el, 'tab' + (t.active ? ' active' : ''));
    const fav = pickFavicon(t.favicon);
    setClass(rec.dot, 'dot' + (t.secure ? '' : ' insecure') + (t.loading ? ' loading' : ''));
    // Favicon when we have one; spinner while loading; security dot as fallback.
    // Internal pages get their own glyph (a gear) instead of a site favicon.
    if (t.loading) setHTML(rec.dot, SPINNER);
    else if (internal) setHTML(rec.dot, ICONS[INTERNAL_UI[internal].icon]);
    else if (fav) setHTML(rec.dot, faviconImg(fav));
    else setHTML(rec.dot, DOT);
    setText(rec.title, t.title || (internal ? tr(INTERNAL_UI[internal].titleKey) : tr('tab_default')));
    // Keep DOM order in sync without rebuilding when it already matches.
    const after = prev ? prev.nextSibling : tabstrip.firstChild;
    if (rec.el !== after) tabstrip.insertBefore(rec.el, after);
    prev = rec.el;

    if (t.active) {
      activeTab = t;
      backBtn.disabled = !t.canGoBack;
      fwdBtn.disabled = !t.canGoForward;
      // Zoom badge: visible only off 100% (web pages and internal pages alike).
      const z = t.zoom || 100;
      zoomBtn.hidden = z === 100;
      if (z !== 100) setText(zoomBtn, z + '%');
      if (internal) {
        // Internal page: no site security state. Show its glyph in the lock slot,
        // a plain (non-bookmarkable) star, and the canonical mybrowser:// URL.
        const meta = INTERNAL_UI[internal];
        setHTML(star, ICONS.star); star.classList.remove('on');
        setHTML(lock, ICONS[meta.icon]); lock.classList.remove('insecure');
        lock.title = tr(meta.titleKey);
        if (!editingAddress) address.value = t.url;
      } else {
        setHTML(star, t.bookmarked ? ICONS.starFilled : ICONS.star);
        star.classList.toggle('on', t.bookmarked);
        const secure = t.secure;
        setHTML(lock, secure ? ICONS.lock : ICONS.warn);
        lock.classList.toggle('insecure', !secure);
        lock.title = secure ? tr('lock_secure') : tr('lock_insecure');
        if (!editingAddress) address.value = t.url === 'about:blank' ? '' : t.url;
      }
    }
  }
  // Drop closed tabs.
  for (const [id, rec] of tabEls) {
    if (!seen.has(id)) { rec.el.remove(); tabEls.delete(id); }
  }
});
