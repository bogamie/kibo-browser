'use strict';

// ---------------------------------------------------------------------------
// Internal Settings page (mybrowser://settings), rendered as a real browser
// tab. Talks to main only through the privileged settings preload (window.api):
//   getSettings() / setSetting(key, value) / onState(cb)
// Reuses the chrome's i18n layer (i18n.js) and the shared row styles in
// style.css (.setting / .switch / .langseg / .section-title). This is a port of
// the old overlay-panel renderSettings(), now standing on its own.
// ---------------------------------------------------------------------------
const root = document.getElementById('settingsbody');
let state = { settings: {} };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function sectionTitle(text) { return el('div', 'section-title', text); }

// A name/description row with a sliding on/off switch, wired straight to a
// boolean setting. Optimistic toggle; main echoes the new state back via onState.
function toggleRow(key, nameKey, descKey, on) {
  const row = el('div', 'setting');
  const info = el('div', 'info');
  info.append(el('div', 'name', tr(nameKey)), el('div', 'desc', tr(descKey)));
  const sw = el('div', 'switch' + (on ? ' on' : ''));
  sw.onclick = () => {
    const next = !sw.classList.contains('on');
    sw.classList.toggle('on', next);
    window.api.setSetting(key, next);
  };
  row.append(info, sw);
  return row;
}

// Interface-language row: a two-option segmented control (English / 한국어).
// Switching persists `lang`; the state broadcast re-renders this page (and the
// rest of the UI) in the new language.
function languageRow(current) {
  const row = el('div', 'setting');
  const info = el('div', 'info');
  info.append(el('div', 'name', tr('set_language')), el('div', 'desc', tr('set_language_desc')));
  const seg = el('div', 'langseg');
  for (const [code, label] of [['en', 'English'], ['ko', '한국어']]) {
    const b = el('button', 'langopt' + (current === code ? ' on' : ''), label);
    b.onclick = () => { if (current !== code) window.api.setSetting('lang', code); };
    seg.append(b);
  }
  row.append(info, seg);
  return row;
}

function render() {
  const s = state.settings || {};
  root.replaceChildren();
  root.append(sectionTitle(tr('section_language')));
  root.append(languageRow(s.lang || getLang()));
  root.append(sectionTitle(tr('section_display')));
  root.append(toggleRow('autoHide', 'set_autoHide', 'set_autoHide_desc', s.autoHide));
  root.append(sectionTitle(tr('section_security')));
  root.append(toggleRow('blockAds', 'set_blockAds', 'set_blockAds_desc', s.blockAds));
  root.append(toggleRow('httpsOnly', 'set_httpsOnly', 'set_httpsOnly_desc', s.httpsOnly));
  root.append(toggleRow('savePasswords', 'set_savePasswords', 'set_savePasswords_desc', s.savePasswords));
}

// Re-fill the static i18n markup (the H1 and the document/tab title) when the
// language changes. No-op when it hasn't, so it's cheap to call on every
// broadcast — render() below handles the per-update row state.
function applyLang() {
  const lang = (state.settings && state.settings.lang) || 'en';
  if (lang === getLang()) return;
  setLang(lang);
  applyStaticI18n();
  document.title = tr('panel_settings');
  document.documentElement.lang = lang;
}

// Live updates: a switch toggled here or from the chrome (e.g. the shield
// button), a language change, or any other state broadcast.
window.api.onState((s) => {
  state = { ...state, ...s };
  applyLang();
  render();
});

(async () => {
  try {
    state.settings = await window.api.getSettings();
  } catch {
    state.settings = {};            // onState will fill these in if anything changes
  }
  applyLang();
  render();
})();

// Thin overlay scrollbar for the page. The <body> is the scroll container here
// (style.css hides its native scrollbar), so the overlay tracks the body.
overlayScrollbar(document.body);
