# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MyBrowser is a hardened Chromium-based web browser built on Electron 42. Its two headline features are a **Zen-style auto-hide chrome** (the whole toolbar/tab strip disappears, revealed by moving the pointer to the top edge) and a **per-site password manager** with OS-keyring-encrypted storage. The README is in Korean and is the most complete feature reference.

## Commands

```bash
npm install
npm start          # electron .
npm start -- --no-sandbox   # temporary workaround if the SUID sandbox errors (NOT recommended)
```

There is no build step, linter, or test suite — it runs directly from source.

**Linux sandbox gotcha:** after `npm install`, the Chromium SUID sandbox binary loses its setuid bit. If startup fails with `The SUID sandbox helper binary ... mode 4755`, run once:
```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```
This must be redone whenever `node_modules` is reinstalled.

## Architecture

Three security contexts, never mixed:

1. **Main process** (`main.js`) — owns windows, profiles/sessions, the tab manager, all OS access, and every IPC handler.
2. **Chrome UI renderer** (`ui/`) — our trusted toolbar/tabs/panels. Talks to main ONLY through `window.api` (the `preload.js` bridge). No Node access; strict CSP in `index.html`. Split into classic `<script>`s that share one global lexical scope (no bundler/modules), loaded in dependency order: `i18n.js` → `dom.js` (element refs, `ICONS`/`svgIcon`, shared `state`, `reportLayout`, toast, `escapeHtml`) → `tabs.js` → `bookmarks.js` → `panels.js` → `chrome.js` (toolbar/menu/find/interstitial wiring + the `onState` broadcast handler). A `const`/`function` declared at the top level of one file is visible in all the others (same mechanism as `i18n.js`'s `tr`); load order only matters for the few top-level statements that run at parse time, so `dom.js` must come first.
3. **Web content** (`tabPreload.js`) — runs inside every visited page, sandboxed and context-isolated. Exposes **nothing** to the page; communicates with main only via `ipcRenderer`.

### The two-view layering (key to understanding rendering)

Each window's `Browser` instance (see `main.js`) holds N tab views plus one chrome view, all as separate `WebContentsView`s on the window's `contentView`:

- Each tab is its own isolated `WebContentsView` (per-site process isolation), loaded with `tabPreload.js`.
- The **chrome UI is also a `WebContentsView`**, kept raised on top (`_raiseChrome()`) so it can float over content.
- In auto-hide mode the content view fills the entire window and the chrome view slides in/out on top. Otherwise the content sits below a fixed top bar (`barHeight`, default 88px, reported by the renderer via `chrome:layout`).
- When a full-window panel opens (history/downloads/passwords) or a security interstitial fires, the chrome view goes to `overlay` mode and covers the whole window.
- **Internal pages** (currently just Settings, at `mybrowser://settings`) are *real tabs*, not overlays: a `WebContentsView` loaded with the privileged `settingsPreload.js` (exposes only `getSettings`/`setSetting`/`onState`) showing `ui/settings.html` + `ui/settings.js`. `_createInternalTab()` builds it and `openSettings()` is a per-window singleton (focuses the open one or creates it). The view is marked `view._internal` (so `emitTabs` reports an `internal` flag and the renderer draws a gear + the `mybrowser://settings` URL with no padlock), kept out of history, and locked down — `setWindowOpenHandler` denies, and `will-navigate` blocks anything but `file://` — so it can never navigate to remote content (which would otherwise inherit the privileged preload). `navigate()`/`navigateTabTo()` refuse to load web URLs into an `_internal` view, opening a normal tab instead.

`relayout()` is the single source of truth for view bounds and is re-run on every resize. The auto-hide slide is choreographed across the process boundary: `reveal(false)` tells the renderer to animate the bar out, the renderer reports `chrome:slideDone`, and only then does main actually hide the view (`onSlideDone`) — so the view stays mounted during the animation and a hidden bar can't steal clicks.

### Profiles and sessions

A `ProfileCtx` (created in `getProfile`) bundles an Electron `session`, a `Store`, a `PasswordVault`, and per-session security state. Persistent profiles use partition `persist:profile-<name>`; **incognito profiles use an in-memory partition and pass `persistent: false` to Store/Vault so nothing touches disk** (no history, no saved passwords). `hardenSession` denies all powerful permissions by default (only `fullscreen` + sanitized clipboard write), installs the ad blocker, and routes downloads.

### IPC conventions

- `preload.js` is the complete, validated API surface — every renderer→main channel is mirrored there. When adding a feature, add the channel in `main.js` `wireIpc()` AND expose it in `preload.js`; nothing else can reach main.
- `ipcRenderer.send` (fire-and-forget) vs `ipcRenderer.invoke` (request/response) — follow the existing split.
- Main resolves which `Browser` sent a message via `browserFromEvent(e)` (matches `e.sender` to a chrome view). The global `passwords:get` handler is the exception: it matches `e.sender` against **tab** webContents because content preloads call it directly for autofill. `settings:get`/`settings:set` use `browserFromTrusted(e)` — the chrome view **or** an `_internal` page view (the Settings tab) — so a web-content tab renderer cannot read or write settings.
- Main pushes state to the renderer through broadcast helpers: `broadcastState` (settings/bookmarks/blocked count/vault status), `broadcastDownloads`, and `emitTabs` (the tab strip).

### Storage

- `store.js` — one JSON file per profile (`data.json`): settings, bookmarks, bookmark folders, history, downloads. Bookmarks and folders share a single sibling `order` space (`_siblings`/`moveItem`) for drag-reordering; `_migrateOrder` backfills `order` for older data. Folder deletion cascades to descendants.
- `passwords.js` — credentials in `passwords.enc`, encrypted with Electron `safeStorage` (OS keyring / libsecret), prefix `v1:`. If the keyring is unavailable it falls back to base64 obfuscation (prefix `b64:`) — never plaintext — and sets `usingOsEncryption = false` so the UI can warn. `list()` masks passwords unless `{ reveal: true }`.

### Security model

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true` on every view.
- HTTPS-only upgrades top-level `http://` navigations (`navigateView`); a failed upgrade or a cert error triggers a full-window interstitial and the user must explicitly `proceed` (host added to `certAllow`).
- Frameless window (`frame: false`) — window min/max/close controls live in our chrome and go through `window:*` IPC.

### Other pieces

- `blocker.js` — `session.webRequest.onBeforeRequest` suffix-matches a hand-picked built-in `BLOCKED_DOMAINS` list (never blocks `mainFrame`). Easy to extend; not a full EasyList.
- Keyboard shortcuts are bound via `before-input-event` on BOTH chrome and tab webContents (`_bindShortcuts`), so they work regardless of focus. The native application menu is disabled (`Menu.setApplicationMenu(null)`). See the README shortcut table.

## Conventions

- **All user-facing strings go through `ui/i18n.js`** — `tr('key')` in `chrome.js`, `data-i18n` / `data-i18n-title` / `data-i18n-ph` attributes in `index.html`. English is default, Korean (`ko`) toggles live via the `lang` setting. Never hardcode display text. (The function is named `tr`, not `t`, because `t` is the tab loop variable in `chrome.js`.)
- **Icons are inline SVGs** with `viewBox="0 0 16 16"` and `currentColor`, built via the `svgIcon()` helper in `dom.js` (the `ICONS` map) and a parallel set in `index.html`. Deliberately no `width`/`height` attributes — size is set purely in CSS per context (Chromium lets the SVG size attribute override CSS otherwise).
- **GPU/rendering switches** at the top of `main.js` are load-bearing and heavily commented — read those comments before touching them. Stay on the X11/XWayland path (`ozone-platform-hint=auto`); native Wayland left the frameless window invisible on the dev machine. Do not add `--disable-gpu`.
- **Scrollbars** are custom thin *overlay* indicators, not native ones. Native scrollbars are hidden (so no gutter is reserved and content never shifts); a ~3px thumb floats over the content, appears only while scrolling, and fades out ~1.1s after scrolling stops. It's `pointer-events: none`, so it can't eat clicks. `ui/overlayScrollbar.js` (`overlayScrollbar(target)`) drives the browser's own surfaces (settings page, history/downloads/passwords panels, folder dialog) per known scroll container. `tabPreload.js` carries a mirror that runs on every web page: it hides *all* native scrollbars via `webFrame.insertCSS` and, with one capture-phase scroll listener, draws an overlay over whatever is scrolling — the main page or any inner scroll container — so every site's scrollbars look identical (thumbs are created on scroll and removed after they fade). Chromium removed the `OverlayScrollbar` engine flag in 115, hence the hand-rolled version.
