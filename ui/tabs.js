'use strict';

// ---------------------------------------------------------------------------
// Tab strip: render tabs from main's tabs:update broadcast and keep the toolbar
// (address, back/forward, lock, star) in sync with the active tab.
// ---------------------------------------------------------------------------
// Keyed reuse: only touch DOM that actually changed (the tab strip otherwise
// fully rebuilds on every loading-spinner / title tick, repainting constantly).
const tabEls = new Map(); // id -> { el, dot, title }

// Inline onerror is blocked by CSP, so we catch <img> load/error in the capture
// phase and update the shared faviconFail map (defined in dom.js): a failure is
// a strike, a successful load clears the URL so a recovered icon shows again.
tabstrip.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG') return;
  faviconStrike(img.dataset.fav);
  const dot = img.closest('.dot');
  if (dot) { dot._html = DOT; dot.innerHTML = DOT; } // swap to dot immediately
}, true);
tabstrip.addEventListener('load', (e) => {
  const img = e.target;
  if (img && img.tagName === 'IMG') faviconOk(img.dataset.fav);
}, true);

function makeTabEl(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.tabId = String(id);   // hit-testing target for bookmark-onto-tab drops
  el.onclick = () => window.api.selectTab(id);
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
    const fav = t.favicon && !faviconBlocked(t.favicon) ? t.favicon : null;
    setClass(rec.dot, 'dot' + (t.secure ? '' : ' insecure') + (t.loading ? ' loading' : ''));
    // Favicon when we have one; spinner while loading; security dot as fallback.
    // Internal pages get their own glyph (a gear) instead of a site favicon.
    if (t.loading) setHTML(rec.dot, SPINNER);
    else if (internal === 'settings') setHTML(rec.dot, ICONS.gear);
    else if (fav) setHTML(rec.dot, `<img class="favicon" src="${encodeURI(fav)}" data-fav="${fav.replace(/"/g, '%22')}" />`);
    else setHTML(rec.dot, DOT);
    setText(rec.title, t.title || (internal === 'settings' ? tr('panel_settings') : tr('tab_default')));
    // Keep DOM order in sync without rebuilding when it already matches.
    const after = prev ? prev.nextSibling : tabstrip.firstChild;
    if (rec.el !== after) tabstrip.insertBefore(rec.el, after);
    prev = rec.el;

    if (t.active) {
      activeTab = t;
      backBtn.disabled = !t.canGoBack;
      fwdBtn.disabled = !t.canGoForward;
      if (internal === 'settings') {
        // Internal page: no site security state. Show the gear in the lock slot,
        // a plain (non-bookmarkable) star, and the canonical mybrowser:// URL.
        setHTML(star, ICONS.star); star.classList.remove('on');
        setHTML(lock, ICONS.gear); lock.classList.remove('insecure');
        lock.title = tr('panel_settings');
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
