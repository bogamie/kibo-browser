// ---------------------------------------------------------------------------
// Tiny i18n layer. Every user-facing string lives here keyed by a stable id,
// with an English and a Korean form. The UI is built in English; the language
// can be switched live from Settings (persisted as the `lang` setting).
//
// Usage:
//   tr('menu_newTab')                -> plain string
//   tr('shield_on', 3)               -> interpolated (entry is a function)
//   applyStaticI18n()                -> fill data-i18n* attributes in the HTML
//
// Named `tr` (not `t`) because `t` is already used as the tab loop variable
// throughout chrome.js.
// ---------------------------------------------------------------------------
const I18N = {
  // window controls / nav (mostly static HTML title attrs)
  win_menu:        { en: 'Menu',                       ko: '메뉴' },
  win_newtab:      { en: 'New tab (Ctrl+T)',           ko: '새 탭 (Ctrl+T)' },
  win_min:         { en: 'Minimize',                   ko: '최소화' },
  win_max:         { en: 'Maximize',                   ko: '최대화' },
  win_restore:     { en: 'Restore',                    ko: '이전 크기로' },
  win_close:       { en: 'Close',                      ko: '닫기' },
  nav_back:        { en: 'Back (Alt+←)',               ko: '뒤로 (Alt+←)' },
  nav_forward:     { en: 'Forward (Alt+→)',            ko: '앞으로 (Alt+→)' },
  nav_reload:      { en: 'Reload (Ctrl+R)',            ko: '새로고침 (Ctrl+R)' },
  lock_title:      { en: 'Connection security',        ko: '연결 보안' },
  lock_secure:     { en: 'Secure connection (HTTPS)',  ko: '보안 연결 (HTTPS)' },
  lock_insecure:   { en: 'Not secure',                 ko: '안전하지 않은 연결' },
  star_title:      { en: 'Bookmark (Ctrl+D)',          ko: '북마크 (Ctrl+D)' },
  shield_title:    { en: 'Block ads/trackers',         ko: '광고/트래커 차단' },
  url_placeholder: { en: 'Search or enter address (Ctrl+L)', ko: '검색어 또는 주소를 입력하세요 (Ctrl+L)' },
  shield_on:       { en: (n) => `${n} ads/trackers blocked (click to disable)`, ko: (n) => `광고/트래커 ${n}개 차단됨 (클릭하여 끄기)` },
  shield_off:      { en: 'Blocking off (click to enable)', ko: '차단 꺼짐 (클릭하여 켜기)' },
  tab_default:     { en: 'New Tab',                    ko: '새 탭' },

  // find bar
  find_placeholder:{ en: 'Find in page',               ko: '페이지에서 찾기' },
  find_prev:       { en: 'Previous',                   ko: '이전' },
  find_next:       { en: 'Next',                       ko: '다음' },
  find_close:      { en: 'Close',                      ko: '닫기' },

  // save-password prompt
  save_default:    { en: 'Save the password for this site?', ko: '이 사이트의 비밀번호를 저장할까요?' },
  save_accept:     { en: 'Save',                       ko: '저장' },
  save_reject:     { en: 'No',                         ko: '아니요' },
  save_prompt:     { en: (origin, user) => `Save the ${user ? `'${user}' ` : ''}password for ${origin}?`,
                     ko: (origin, user) => `${origin}의 ${user ? `'${user}' ` : ''}비밀번호를 저장할까요?` },

  // bookmark add/edit bubble + dialog
  bmedit_head:     { en: 'Bookmark added',             ko: '북마크 추가됨' },
  name_placeholder:{ en: 'Name',                       ko: '이름' },
  bmedit_remove:   { en: 'Remove',                     ko: '삭제' },
  bmedit_done:     { en: 'Done',                       ko: '완료' },
  bmtree_newfolder:{ en: 'New folder',                 ko: '새 폴더' },
  bmtree_cancel:   { en: 'Cancel',                     ko: '취소' },
  bmtree_save:     { en: 'Save',                       ko: '저장' },
  dialog_editBookmark: { en: 'Edit bookmark',          ko: '북마크 수정' },
  dialog_editFolder:   { en: 'Edit folder',            ko: '폴더 수정' },
  dialog_newFolder:    { en: 'New folder',             ko: '새 폴더' },
  newFolder_name:  { en: 'New folder',                 ko: '새 폴더' },
  bookmarksBar:    { en: 'Bookmarks bar',              ko: '북마크바' },
  chooseFolder:    { en: 'Choose another folder…',     ko: '다른 폴더 선택…' },
  deleteFolder:    { en: 'Delete folder',              ko: '폴더 삭제' },
  folderEmpty:     { en: '(empty)',                    ko: '(비어 있음)' },
  confirmDeleteFolder: { en: (name) => `'${name}' and all bookmarks and subfolders inside it will be deleted. Continue?`,
                         ko: (name) => `'${name}' 폴더와 그 안의 북마크·하위 폴더가 모두 삭제됩니다. 계속할까요?` },

  // app menu
  menu_newTab:        { en: 'New tab',                 ko: '새 탭' },
  menu_newWindow:     { en: 'New window',              ko: '새 창' },
  menu_newIncognito:  { en: 'New Incognito window',    ko: '새 시크릿 창' },
  menu_addBookmark:   { en: 'Add bookmark',            ko: '북마크 추가' },
  menu_history:       { en: 'History',                 ko: '방문 기록' },
  menu_downloads:     { en: 'Downloads',               ko: '다운로드' },
  menu_passwords:     { en: 'Manage passwords',        ko: '비밀번호 관리' },
  menu_find:          { en: 'Find in page',            ko: '페이지에서 찾기' },
  menu_settings:      { en: 'Settings',                ko: '설정' },

  // context menus
  notImplemented:     { en: 'This feature is not implemented yet.', ko: '아직 구현되지 않은 기능입니다.' },
  ctx_openNewTab:     { en: 'Open in new tab',         ko: '새 탭에서 열기' },
  ctx_openNewWindow:  { en: 'Open in new window',      ko: '새 창에서 열기' },
  ctx_openSplit:      { en: 'Open in split screen',    ko: '분할 화면에서 열기' },
  ctx_openIncognito:  { en: 'Open in Incognito window',ko: '시크릿 창에서 열기' },
  ctx_edit:           { en: 'Edit…',                   ko: '수정…' },
  ctx_delete:         { en: 'Delete',                  ko: '삭제' },
  ctx_bmManager:      { en: 'Open Bookmarks Manager',  ko: '북마크 관리자 열기' },
  ctx_openAll:        { en: (n) => `Open all (${n})`,  ko: (n) => `모두 열기 (${n})` },
  ctx_openAllNewWindow:{ en: 'Open all in new window', ko: '모두 새 창에서 열기' },
  ctx_openAllIncognito:{ en: 'Open all in Incognito window', ko: '모두 시크릿 창에서 열기' },
  ctx_addPage:        { en: 'Add page…',               ko: '페이지 추가…' },
  ctx_addFolder:      { en: 'Add folder…',             ko: '폴더 추가…' },

  // panels: history / downloads / passwords (settings is now a tab — see ui/settings.js)
  panel_history:      { en: 'History',                 ko: '방문 기록' },
  panel_downloads:    { en: 'Downloads',               ko: '다운로드' },
  panel_passwords:    { en: 'Saved passwords',         ko: '저장된 비밀번호' },
  panel_settings:     { en: 'Settings',                ko: '설정' },
  panel_close:        { en: 'Close',                   ko: '닫기' },
  clearAll:           { en: 'Clear all',               ko: '전체 삭제' },
  clearList:          { en: 'Clear list',              ko: '목록 비우기' },
  noHistory:          { en: 'No history',              ko: '방문 기록이 없습니다' },
  noDownloads:        { en: 'No downloads',            ko: '다운로드 항목이 없습니다' },
  noPasswords:        { en: 'No saved passwords',      ko: '저장된 비밀번호가 없습니다' },
  dl_done:            { en: (size) => `Done · ${size}`, ko: (size) => `완료 · ${size}` },
  dl_cancelled:       { en: 'Cancelled',               ko: '취소됨' },
  dl_failed:          { en: 'Failed',                  ko: '실패' },
  dl_cancel:          { en: 'Cancel',                  ko: '취소' },
  dl_showInFolder:    { en: 'Show in folder',          ko: '폴더에서 보기' },
  pass_noteIncognito: { en: 'Passwords are not saved in Incognito mode.', ko: '시크릿 모드에서는 비밀번호가 저장되지 않습니다.' },
  pass_noteNoKeyring: { en: '⚠ The OS keyring is unavailable, so passwords are stored without OS encryption.', ko: '⚠ OS 키링을 사용할 수 없어 비밀번호가 OS 암호화 없이 저장됩니다.' },
  pass_noUsername:    { en: '(no username)',           ko: '(아이디 없음)' },
  pass_show:          { en: 'Show',                    ko: '표시' },
  delete:             { en: 'Delete',                  ko: '삭제' },

  // settings rows
  section_display:    { en: 'Display',                 ko: '표시' },
  section_security:   { en: 'Security & privacy',      ko: '보안 & 개인정보' },
  section_language:   { en: 'Language',                ko: '언어' },
  set_autoHide:       { en: 'Auto-hide address bar (Zen mode)', ko: '주소창 자동 숨김 (Zen 모드)' },
  set_autoHide_desc:  { en: 'Show only the content; move the mouse to the top edge to reveal the toolbar. (Ctrl+Shift+H)', ko: '콘텐츠만 보이게 하고, 마우스를 화면 맨 위로 올리면 도구 모음이 나타납니다. (Ctrl+Shift+H)' },
  set_blockAds:       { en: 'Block ads/trackers',      ko: '광고/트래커 차단' },
  set_blockAds_desc:  { en: 'Block requests to known ad and analytics domains.', ko: '알려진 광고·분석 도메인 요청을 차단합니다.' },
  set_httpsOnly:      { en: 'Force HTTPS',             ko: 'HTTPS 강제' },
  set_httpsOnly_desc: { en: 'Automatically upgrade http addresses to https and warn on failure.', ko: 'http 주소를 자동으로 https로 업그레이드하고, 실패 시 경고합니다.' },
  set_savePasswords:  { en: 'Save passwords',          ko: '비밀번호 저장' },
  set_savePasswords_desc: { en: 'Save and auto-fill per-site usernames and passwords.', ko: '사이트별 아이디·비밀번호 저장 및 자동 입력을 사용합니다.' },
  set_language:       { en: 'Interface language',      ko: '인터페이스 언어' },
  set_language_desc:  { en: 'Choose the language used throughout the browser UI.', ko: '브라우저 UI 전반에 사용되는 언어를 선택합니다.' },

  // HTTPS / cert interstitial
  inter_httpsTitle:   { en: 'HTTPS connection failed', ko: 'HTTPS 연결에 실패했습니다' },
  inter_certTitle:    { en: 'Your connection is not private', ko: '연결이 비공개로 설정되어 있지 않습니다' },
  inter_back:         { en: 'Back to safety',          ko: '안전한 곳으로 돌아가기' },
  inter_proceed:      { en: 'Proceed at your own risk',ko: '위험을 감수하고 계속' },
  inter_httpsText:    { en: (host, url) => `A secure connection (HTTPS) to ${host} was attempted but failed. Continuing over unencrypted http may expose your information.\n${url}`,
                        ko: (host, url) => `${host}에 안전한 연결(HTTPS)을 시도했지만 실패했습니다. 암호화되지 않은 http로 계속하면 정보가 노출될 수 있습니다.\n${url}` },
  inter_certText:     { en: (host, url) => `There is a problem with ${host}'s security certificate. An attacker may be trying to intercept your information.\n${url}`,
                        ko: (host, url) => `${host}의 보안 인증서에 문제가 있습니다. 공격자가 정보를 가로채려 할 수 있습니다.\n${url}` },
};

let _lang = 'en';
function getLang() { return _lang; }
function setLang(lang) { _lang = (lang === 'ko') ? 'ko' : 'en'; }

// Look up a key in the current language. Entries may be plain strings or
// functions (for interpolation); extra args are passed to the function.
function tr(key, ...args) {
  const entry = I18N[key];
  if (!entry) return key;
  const v = entry[_lang] != null ? entry[_lang] : entry.en;
  return typeof v === 'function' ? v(...args) : v;
}

// Fill static markup: data-i18n -> textContent, data-i18n-title -> title,
// data-i18n-ph -> placeholder. Run on startup and on every language change.
function applyStaticI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = tr(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = tr(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = tr(el.dataset.i18nPh);
}
