'use strict';

// Chrome UI entry point. Talks to main only through window.api (preload bridge);
// no Node access here. This file wires the toolbar/window controls, the menu,
// find, the security interstitial, the password-save prompt, and the global
// state broadcast — building on the helpers loaded before it:
//   i18n.js → dom.js → tabs.js → bookmarks.js → panels.js → chrome.js
// (classic scripts share one global scope, so their functions/consts are all
//  visible here; load order is set in index.html).

// ---------------------------------------------------------------------------
// Auto-hide slide. Main shows/mounts the native chrome view, then sends
// 'reveal'; we animate the inner #bar with a GPU transform. On hide we animate
// out and only tell main it's safe to unmount the view on transitionend.
// ---------------------------------------------------------------------------
window.api.onReveal((on) => {
  if (on) {
    // Start from the hidden position so the slide-in is actually visible, then
    // double-rAF before clearing it (committing the start frame first).
    bar.classList.add('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.remove('hidden')));
  } else {
    bar.classList.add('hidden');
    let done = false;
    const finish = (e) => {
      if (done) return;
      if (e && (e.target !== bar || e.propertyName !== 'transform')) return; // ignore bubbled
      done = true;
      bar.removeEventListener('transitionend', finish);
      clearTimeout(timer);
      window.api.slideDone(false);
    };
    bar.addEventListener('transitionend', finish);
    const timer = setTimeout(finish, 250); // fallback if transitionend is dropped
  }
});

// ---------------------------------------------------------------------------
// Toolbar / address bar
// ---------------------------------------------------------------------------
// Window controls (frameless)
const winMax = $('#win-max');
$('#win-min').onclick = () => window.api.minimize();
winMax.onclick = () => window.api.toggleMaximize();
$('#win-close').onclick = () => window.api.closeWindow();
$('#tabsrow').addEventListener('dblclick', (e) => {
  if (e.target.closest('button, .tab')) return; // only the empty drag area
  window.api.toggleMaximize();
});
// SVG icons swapped on maximize state: single square (maximize) vs. overlapping
// squares (restore). Use currentColor so they follow the button's text color.
const ICON_MAXIMIZE = svgIcon('<rect x="3" y="3" width="10" height="10" rx="1.5"/>');
const ICON_RESTORE = svgIcon('<rect x="3" y="5" width="8" height="8" rx="1.5"/><path d="M6 5V3h7v7h-2"/>');
window.api.onMaximized((on) => {
  winMax.innerHTML = on ? ICON_RESTORE : ICON_MAXIMIZE;
  winMax.title = on ? tr('win_restore') : tr('win_max');
});

backBtn.onclick = () => window.api.back();
fwdBtn.onclick = () => window.api.forward();
$('#reload').onclick = () => window.api.reload();
$('#newtab').onclick = () => window.api.newTab();
star.onclick = () => addBookmarkAndEdit();
shield.onclick = () => window.api.setSetting('blockAds', !state.settings.blockAds);
$('#menu').onclick = (e) => { e.stopPropagation(); toggleMenu(); };

address.addEventListener('focus', () => { editingAddress = true; address.select(); });
address.addEventListener('blur', () => { editingAddress = false; });
address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { window.api.go(address.value); address.blur(); }
  if (e.key === 'Escape') { address.blur(); }
});

// ---------------------------------------------------------------------------
// Global state (settings, bookmarks, blocked count, profile)
// ---------------------------------------------------------------------------
window.api.onState((s) => {
  state = { ...state, ...s };
  document.body.classList.toggle('incognito', !!s.incognito);
  // Switch UI language live when the setting changes (re-fills static markup;
  // dynamic strings below and on next open already read the new language).
  if (s.settings.lang && s.settings.lang !== getLang()) {
    setLang(s.settings.lang);
    applyStaticI18n();
    if (!panel.hidden) openPanel(panel.dataset.kind);
  }
  // When auto-hide is off the bar is always shown — never leave it slid-up.
  if (!s.settings.autoHide) bar.classList.remove('hidden');
  shieldcount.textContent = String(s.blocked ?? 0);
  shield.classList.toggle('off', !s.settings.blockAds);
  shield.title = s.settings.blockAds
    ? tr('shield_on', s.blocked)
    : tr('shield_off');
  renderBookmarks();
  // Keep open bookmark popups in sync with fresh data (e.g. folder just added).
  if (!bmedit.hidden && bmEditId != null) syncBookmarkEditor();
  if (!bmfolderpop.hidden && bmFolderId != null) renderFolderPop(bmFolderId, null);
  if (!panel.hidden && panel.dataset.kind === 'passwords') openPanel('passwords');
});

// ---------------------------------------------------------------------------
// Menu popup
// ---------------------------------------------------------------------------
// [i18n key, shortcut, handler] — labels resolved per-open so the language can
// change live.
const MENU = [
  ['menu_newTab', 'Ctrl+T', () => window.api.newTab()],
  ['menu_newWindow', '', () => window.api.newWindow()],
  ['menu_newIncognito', 'Ctrl+Shift+N', () => window.api.newIncognito()],
  ['sep'],
  ['menu_addBookmark', 'Ctrl+D', () => addBookmarkAndEdit()],
  ['menu_history', 'Ctrl+H', () => openPanel('history')],
  ['menu_downloads', 'Ctrl+J', () => openPanel('downloads')],
  ['menu_passwords', '', () => openPanel('passwords')],
  ['menu_find', 'Ctrl+F', () => openFind()],
  ['sep'],
  ['menu_settings', '', () => window.api.openSettings()],
];

function buildMenu() {
  menupop.replaceChildren();
  for (const item of MENU) {
    if (item[0] === 'sep') {
      const s = document.createElement('div'); s.className = 'menusep'; menupop.append(s); continue;
    }
    const [labelKey, key, fn] = item;
    const b = document.createElement('button');
    b.className = 'menuitem';
    b.innerHTML = `<span>${tr(labelKey)}</span>` + (key ? `<span class="k">${key}</span>` : '');
    b.onclick = () => { closeMenu(); fn(); };
    menupop.append(b);
  }
}
function toggleMenu() { menupop.hidden ? openMenu() : closeMenu(); }
function openMenu() {
  // Dismiss other transient popups — the menu button stops click propagation,
  // so their bubble-phase outside-click handlers wouldn't otherwise fire.
  closeCtx(); closeFolderPop();
  if (!bmedit.hidden) { commitName(); closeBookmarkEditor(); }
  buildMenu(); menupop.hidden = false; reportLayout();
}
function closeMenu() { menupop.hidden = true; reportLayout(); }
document.addEventListener('click', (e) => {
  if (!menupop.hidden && !menupop.contains(e.target) && e.target.id !== 'menu') closeMenu();
});

// ---------------------------------------------------------------------------
// Password save prompt
// ---------------------------------------------------------------------------
window.api.onPasswordPrompt(({ origin, username }) => {
  savetext.textContent = tr('save_prompt', origin, username);
  saveprompt.hidden = false;
  reportLayout();
});
$('#savaccept').onclick = () => { window.api.passwordDecision(true); saveprompt.hidden = true; reportLayout(); };
$('#savreject').onclick = () => { window.api.passwordDecision(false); saveprompt.hidden = true; reportLayout(); };

// ---------------------------------------------------------------------------
// Find in page
// ---------------------------------------------------------------------------
// preventScroll: the find bar starts outside the chrome view's current height, so
// a plain focus() would scroll the (overflow:hidden) bar up to reveal it and snap
// back once the view resizes — a visible twitch. Report the new layout first so the
// chrome view grows, then the bar fades/slides in over the page top (CSS findbar-in).
function openFind() {
  findbar.classList.remove('closing');                  // cancel an in-progress close
  findbar.removeEventListener('animationend', finishCloseFind);
  findbar.hidden = false;
  reportLayout();
  findinput.focus({ preventScroll: true });
  findinput.select();
}
// Runs after the fade-out: now (and only now) is it safe to mark it hidden and let
// reportLayout shrink the chrome view back down.
function finishCloseFind() {
  findbar.classList.remove('closing');
  findbar.hidden = true;
  findcount.textContent = '0/0';
  reportLayout();
}
function closeFind() {
  if (findbar.hidden || findbar.classList.contains('closing')) return;
  window.api.findStop();
  findbar.classList.add('closing');                     // still !hidden → chrome view stays tall while it fades
  findbar.addEventListener('animationend', finishCloseFind, { once: true });
}
findinput.addEventListener('input', () => { if (findinput.value) window.api.find(findinput.value, true); else window.api.findStop(); });
findinput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') window.api.find(findinput.value, !e.shiftKey);
  if (e.key === 'Escape') closeFind();
});
$('#findnext').onclick = () => window.api.find(findinput.value, true);
$('#findprev').onclick = () => window.api.find(findinput.value, false);
$('#findclose').onclick = () => closeFind();
window.api.onFindResult((r) => { findcount.textContent = `${r.activeMatchOrdinal || 0}/${r.matches || 0}`; });

// ---------------------------------------------------------------------------
// Security interstitial
// ---------------------------------------------------------------------------
let interUrl = null;
window.api.onInterstitial(({ type, url, host }) => {
  interUrl = url;
  if (type === 'https') {
    $('#intertitle').textContent = tr('inter_httpsTitle');
    $('#intertext').textContent = tr('inter_httpsText', host, url);
  } else {
    $('#intertitle').textContent = tr('inter_certTitle');
    $('#intertext').textContent = tr('inter_certText', host, url);
  }
  interstitial.hidden = false;
  reportLayout();
});
$('#interback').onclick = () => { interstitial.hidden = true; reportLayout(); window.api.back(); };
$('#interproceed').onclick = () => { interstitial.hidden = true; reportLayout(); if (interUrl) window.api.proceed(interUrl); };

// ---------------------------------------------------------------------------
// Commands routed from main (keyboard shortcuts handled in main process)
// ---------------------------------------------------------------------------
window.api.onFocusAddress(() => { address.focus(); address.select(); });
window.api.onFindOpen(() => openFind());
window.api.onPanelOpen((kind) => openPanel(kind));
window.api.onPanelClose(() => { closePanel(); closeMenu(); });
window.api.onEscape(() => {
  if (!interstitial.hidden) return;            // keep interstitial until user decides
  if (!menupop.hidden) return closeMenu();
  if (!findbar.hidden) return closeFind();
  if (!panel.hidden) return closePanel();
});
