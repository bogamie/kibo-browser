'use strict';

const {
  app, BrowserWindow, WebContentsView, ipcMain, session, Menu, shell, clipboard, dialog,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./store');
const { PasswordVault } = require('./passwords');
const blocker = require('./blocker');
const { autoUpdater } = require('electron-updater');

// The content preload is the esbuild bundle (dist/), not the source: a sandboxed
// preload can't require() local files at runtime, so shared modules are inlined
// at build time. `npm start` builds it first; see build.js / CLAUDE.md.
const TAB_PRELOAD = path.join(__dirname, 'dist', 'tabPreload.js');

// ---------------------------------------------------------------------------
// Rendering smoothness. These switches MUST be appended before app is ready.
//   - ozone-platform-hint=auto: run as a NATIVE Wayland client on Wayland
//     sessions (falls back to X11 on Xorg). Default Electron goes through
//     XWayland, the main cause of choppy scroll/resize and GPU init failures.
//   - enable-smooth-scrolling: interpolate wheel steps (no GPU dependency).
//   - ignore-gpu-blocklist + enable-gpu-rasterization: recover hardware
//     compositing when the driver is blocklisted (error_code=1002 = software
//     fallback). Harmless no-ops if the GPU still can't start.
// (Do NOT add --disable-gpu / disableHardwareAcceleration — that forces
//  software rendering and makes the jank worse.)
// ---------------------------------------------------------------------------
// Wayland-native (ozone-platform=wayland) was tried but left the frameless
// window invisible on this session, so we use the X11/XWayland path via
// hint=auto, which renders correctly and scrolls smoothly.
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-smooth-scrolling');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
// Video: enable VA-API hardware decode. On Electron 33 (Chromium 130) turning
// this on produced torn/striped frames on this Intel Arc / Meteor Lake iGPU — a
// Chromium dmabuf-import bug (issue 424751070) whose browser-side fix landed in
// Chromium 138. We now run Electron >=42 (Chromium 148+), where HW decode is
// clean, so we enable it explicitly: 4K VP9 decodes on the GPU (VaapiVideoDecoder)
// instead of dropping frames in software. Stays on X11/XWayland via the
// ozone-platform-hint above — do NOT switch to native Wayland (it does not map
// the frameless window on this session). Confirm with chrome://media-internals:
// kVideoDecoderName=VaapiVideoDecoder, kIsPlatformVideoDecoder=true.
app.commandLine.appendSwitch('enable-features', 'AcceleratedVideoDecodeLinuxGL');

// ---------------------------------------------------------------------------
// User-Agent. Electron's default UA carries an `Electron/<ver>` token (and the
// app name), which sites like Google's account/OAuth flow detect as an
// "embedded/unsupported browser" and respond to with a stripped-down (or
// outright blocked) login page. Strip the Electron token so we present as the
// plain Chrome we actually are (Chromium 148+) — `app.userAgentFallback` also
// keeps the Client-Hints brand list consistent with the UA string. We derive it
// by removing the token rather than hardcoding a version, so a future Electron
// upgrade keeps the matching Chrome version automatically.
// ---------------------------------------------------------------------------
const UA = app.userAgentFallback
  .replace(/ Electron\/[^ ]+/, '')
  .replace(new RegExp(' ' + app.getName() + '\\/[^ ]+', 'i'), '');
app.userAgentFallback = UA;

// ---------------------------------------------------------------------------
// Profiles. Each profile owns an isolated Electron session, a persistent store
// (settings/bookmarks/history/downloads) and an encrypted password vault.
// Incognito profiles are in-memory only: nothing is written to disk.
// ---------------------------------------------------------------------------
/** @type {Map<string, ProfileCtx>} */
const profiles = new Map();
let incognitoSeq = 0;

function profileDir(name) {
  return path.join(app.getPath('userData'), 'profiles', name);
}

function getProfile(name, { incognito = false } = {}) {
  if (profiles.has(name)) return profiles.get(name);

  const partition = incognito ? `incognito-${name}` : `persist:profile-${name}`;
  const sess = session.fromPartition(partition);
  const dir = profileDir(name);
  const ctx = {
    name,
    incognito,
    session: sess,
    store: new Store(dir, !incognito),
    vault: new PasswordVault(dir, !incognito),
    blocked: 0,
    certAllow: new Set(), // hosts the user chose to proceed to despite cert errors
  };
  profiles.set(name, ctx);
  hardenSession(ctx);
  return ctx;
}

// Per-session security: deny powerful permissions by default, install the
// ad/tracker blocker, route downloads, and gate certificate errors.
function hardenSession(ctx) {
  const s = ctx.session;

  // Belt-and-suspenders: also pin the cleaned UA per session (see UA note up top)
  // so every profile/popup presents as plain Chrome regardless of fallback path.
  s.setUserAgent(UA);

  s.setPermissionRequestHandler((_wc, permission, cb) => {
    const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
    cb(allowed.has(permission));
  });

  blocker.attach(
    s,
    () => ctx.store.getSettings().blockAds,
    (n) => { ctx.blocked += n; broadcastState(ctx); },
  );

  s.on('will-download', (_e, item) => handleDownload(ctx, item));
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------
const downloadItems = new Map(); // id -> { item, path }

function handleDownload(ctx, item) {
  const rec = ctx.store.addDownload({
    filename: item.getFilename(),
    url: item.getURL(),
    path: item.getSavePath(),
    state: 'progressing',
    received: 0,
    total: item.getTotalBytes(),
  });
  downloadItems.set(rec.id, { item, path: null });

  item.on('updated', (_e, state) => {
    ctx.store.updateDownload(rec.id, {
      state, received: item.getReceivedBytes(), total: item.getTotalBytes(),
      path: item.getSavePath(),
    });
    broadcastDownloads(ctx);
  });
  item.once('done', (_e, state) => {
    ctx.store.updateDownload(rec.id, { state, path: item.getSavePath(), received: item.getReceivedBytes() });
    const entry = downloadItems.get(rec.id);
    if (entry) entry.path = item.getSavePath();
    broadcastDownloads(ctx);
  });
  broadcastDownloads(ctx);
}

// ---------------------------------------------------------------------------
// Tab manager (one Browser per window). Both the chrome UI and each tab are
// isolated WebContentsViews; the chrome view is kept on top so it can float
// over content in auto-hide mode (Zen-style) and host full-window panels.
// ---------------------------------------------------------------------------
const browsers = new Set();

// Internal pages render as real tabs but load one of our own local files with a
// privileged preload (settingsPreload.js) instead of web content. Currently the
// only one is the Settings page, addressed by this canonical URL.
const SETTINGS_URL = 'mybrowser://settings';
const PASSWORDS_URL = 'mybrowser://passwords';
// Canonical URL + privileged preload for each internal-page kind. Each gets its
// own minimal preload so, e.g., the Settings page can't reach the vault API.
const INTERNAL = {
  settings:  { url: SETTINGS_URL,  preload: 'settingsPreload.js' },
  passwords: { url: PASSWORDS_URL, preload: 'passwordsPreload.js' },
};
// Map an input URL to an internal-page kind (settings/passwords), or null.
function internalKindFor(input) {
  const s = (input || '').trim().replace(/\/+$/, '').toLowerCase();
  for (const kind in INTERNAL) if (s === INTERNAL[kind].url) return kind;
  return null;
}

// Chrome's zoom presets — keyboard zoom steps through these (and Chromium's
// own Ctrl+wheel uses the same set), so 100% is always a stop along the way.
const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

class Browser {
  /** @param {BrowserWindow} win @param {ProfileCtx} ctx @param {{url?: string}} [opts] */
  constructor(win, ctx, opts = {}) {
    this.win = win;
    this.ctx = ctx;
    this._initialUrl = opts.url || null; // first tab opens here (e.g. "open bookmark in new window")
    /** @type {Map<number, WebContentsView>} */
    this.tabs = new Map();
    this.order = [];           // tab ids in strip order
    this.activeId = null;
    this.seq = 0;
    this.barHeight = 88;       // height chrome reports for its top bar
    this.contentTop = 88;      // where content starts; < barHeight when the find
                               // bar floats over the page instead of pushing it
    this.overlay = false;      // chrome covering full window (panel open)?
    this.revealed = false;     // auto-hide: chrome currently shown?

    // Chrome UI view (trusted, our own files).
    this.chromeView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        sandbox: true, contextIsolation: true, nodeIntegration: false,
      },
    });
    this.chromeView.setBackgroundColor('#00000000');
    win.contentView.addChildView(this.chromeView);
    this.chromeView.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));
    this._bindShortcuts(this.chromeView.webContents);

    this.chromeView.webContents.on('did-finish-load', () => {
      if (this.tabs.size === 0) this.createTab(this._initialUrl || ctx.store.getSettings().homeUrl);
      this.relayout(); this.emitTabs(); broadcastState(ctx);
      this.peek(4000); // show the bar on launch so it's discoverable
    });
  }

  get autoHide() { return this.ctx.store.getSettings().autoHide; }

  // ---- layout --------------------------------------------------------------
  // Content area: full window in auto-hide, otherwise below the bar. `contentTop`
  // (not the full bar height) is the offset, so the find bar can float over the
  // top of the page instead of jolting the whole layout down when it opens.
  // Shared so a background tab can pre-size to the same bounds before it's shown.
  _contentBounds() {
    const { width, height } = this.win.getContentBounds();
    const ah = this.autoHide;
    return { x: 0, y: ah ? 0 : this.contentTop, width, height: ah ? height : height - this.contentTop };
  }

  relayout() {
    const { width, height } = this.win.getContentBounds();
    const ah = this.autoHide;
    const bar = this.barHeight;

    const view = this.tabs.get(this.activeId);
    if (view) view.setBounds(this._contentBounds());

    // Chrome: full-window when a panel is open; a floating/top bar otherwise.
    if (this.overlay) {
      this.chromeView.setBounds({ x: 0, y: 0, width, height });
      this.chromeView.setVisible(true);
    } else {
      this.chromeView.setBounds({ x: 0, y: 0, width, height: bar });
      // In auto-hide, visibility is driven by reveal()/peek() so the CSS slide
      // can animate; the view must stay mounted while a slide-out is in flight.
      this.chromeView.setVisible(ah ? (this.revealed || this._animatingOut === true) : true);
    }
  }

  _raiseChrome() {
    this.win.contentView.removeChildView(this.chromeView);
    this.win.contentView.addChildView(this.chromeView);
  }

  // Smooth slide: on reveal we mount+show the view, THEN tell the renderer to
  // animate the bar in. On hide we tell the renderer to animate out and keep
  // the view mounted until it reports 'chrome:slideDone' (see wireIpc), so the
  // slide-out is actually visible and the hidden bar doesn't steal clicks.
  reveal(on) {
    if (!this.autoHide) return;
    if (on) this._clearPeek();
    if (this.revealed === on) return;
    this.revealed = on;
    const { width } = this.win.getContentBounds();
    if (on) {
      this._animatingOut = false;
      this.chromeView.setBounds({ x: 0, y: 0, width, height: this.barHeight });
      this.chromeView.setVisible(true);
      this.send('reveal', true);
    } else {
      this._animatingOut = true;        // keep view visible until slideDone
      this.send('reveal', false);
    }
  }

  // Briefly show the chrome (on launch / new tab) so it's discoverable, then
  // let it auto-hide again. Hovering the top edge cancels the timer.
  peek(ms = 2800) {
    if (!this.autoHide) return;
    this.reveal(true);
    this._peekTimer = setTimeout(() => {
      this._peekTimer = null;
      this.reveal(false);
    }, ms);
  }
  _clearPeek() { if (this._peekTimer) { clearTimeout(this._peekTimer); this._peekTimer = null; } }

  // Called from the renderer once the bar's slide-out transition finishes.
  onSlideDone(shown) {
    if (!shown) {
      this._animatingOut = false;
      if (this.autoHide && !this.revealed && !this.overlay) this.chromeView.setVisible(false);
    }
  }

  setChromeLayout({ height, contentTop, overlay }) {
    if (typeof height === 'number') this.barHeight = Math.max(40, Math.round(height));
    if (typeof contentTop === 'number') this.contentTop = Math.max(40, Math.round(contentTop));
    else if (typeof height === 'number') this.contentTop = this.barHeight;
    if (typeof overlay === 'boolean') this.overlay = overlay;
    this.relayout();
  }

  // ---- tabs ----------------------------------------------------------------
  emitTabs() {
    const list = this.order.map((id) => {
      const v = this.tabs.get(id);
      // Internal pages have no site security/history state — report a fixed
      // shape; the renderer localizes the title and shows a gear glyph.
      if (v._internal) {
        return {
          id, internal: v._internal, title: '', url: INTERNAL[v._internal].url,
          active: id === this.activeId,
          canGoBack: false, canGoForward: false, loading: false,
          secure: true, favicon: null, bookmarked: false,
          zoom: Math.round(v.webContents.getZoomFactor() * 100),
        };
      }
      const wc = v.webContents;
      const url = wc.getURL();
      return {
        id,
        title: wc.getTitle() || 'New Tab',
        url,
        active: id === this.activeId,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        loading: wc.isLoading(),
        secure: /^https:\/\//i.test(url),
        favicon: v._favicon || null,
        bookmarked: this.ctx.store.isBookmarked(url),
        zoom: Math.round(wc.getZoomFactor() * 100),
      };
    });
    this.send('tabs:update', list);
  }

  send(channel, payload) {
    if (!this.chromeView.webContents.isDestroyed()) this.chromeView.webContents.send(channel, payload);
  }

  createTab(url, index, opts = {}) {
    const internalKind = internalKindFor(url);
    if (internalKind) return this.openInternal(internalKind);
    const target = url || this.ctx.store.getSettings().homeUrl;
    const id = ++this.seq;
    const view = new WebContentsView({
      webPreferences: {
        session: this.ctx.session,
        preload: TAB_PRELOAD,
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
        spellcheck: true,
      },
    });
    // Dark base behind every page so the gap before first paint reads as the
    // chrome's color, not a white flash. Pages with their own bg paint over it.
    view.setBackgroundColor('#131313');
    const wc = view.webContents;

    // Middle-click / Ctrl-click on a link arrives as `background-tab` (→ tab);
    // a windowed `window.open` (OAuth popup) arrives as `new-window` (→ popup).
    // See _windowOpenHandler for the full disposition map.
    this._attachWindowOpenHandling(wc);

    this._bindZoom(wc);

    const refresh = () => this.emitTabs();
    wc.on('page-title-updated', refresh);
    wc.on('page-favicon-updated', (_e, favicons) => {
      view._favicon = (favicons && favicons[0]) || null;
      refresh();
    });
    wc.on('did-navigate', (_e, navUrl) => {
      // Only drop the icon when the host actually changes. A reload or a
      // same-site navigation (e.g. a Google search) usually won't re-fire
      // page-favicon-updated — Electron suppresses the event when the favicon
      // URL set is unchanged — so blanking on every commit would strand the tab
      // on the status dot with no event left to restore the real icon.
      let host = null;
      try { host = new URL(navUrl).host; } catch { /* about:blank, data:, etc. */ }
      if (host !== view._faviconHost) { view._favicon = null; view._faviconHost = host; }
      this.ctx.store.addHistory(navUrl, wc.getTitle());
      refresh();
    });
    wc.on('did-navigate-in-page', refresh);
    wc.on('did-start-loading', refresh);
    wc.on('did-stop-loading', refresh);
    wc.on('found-in-page', (_e, result) => this.send('find:result', result));
    wc.on('certificate-error', (event, errUrl, _err, _cert, callback) => this._onCertError(event, errUrl, callback, id));
    wc.on('did-fail-load', (_e, code, _desc, failedUrl, isMainFrame) => this._onFailLoad(code, failedUrl, isMainFrame, id));

    // Mouse-edge events from the content preload drive the auto-hide reveal.
    wc.ipc.on('edge:enter', () => this.reveal(true));
    wc.ipc.on('edge:leave', () => this.reveal(false));
    wc.ipc.on('password:captured', (_e, data) => this._onCaptured(data));

    this._bindShortcuts(wc);

    view._upgraded = null; // tracks an http->https auto-upgrade for fallback UI
    this.tabs.set(id, view);
    // Insert at the requested strip position (drop-between-tabs); else append.
    if (index == null || index < 0 || index >= this.order.length) this.order.push(id);
    else this.order.splice(index, 0, id);
    this.win.contentView.addChildView(view);
    this._raiseChrome();
    this.navigateView(view, target);
    // Background tab (middle/Ctrl-click): keep the current tab focused, but size
    // the new view like the active one so it lays out correctly before it's
    // shown. Falls through to activate() when there's no active tab to keep.
    if (opts.background && this.tabs.has(this.activeId)) {
      view.setBounds(this._contentBounds());
      view.setVisible(false);
      this.emitTabs();
    } else {
      this.activate(id);
    }
    this.peek();
    return id;
  }

  // Open an internal page (Settings / password manager) as a singleton tab:
  // focus the existing tab for this kind, else create it.
  openInternal(kind) {
    for (const id of this.order) {
      if (this.tabs.get(id)?._internal === kind) { this.activate(id); this.peek(); return id; }
    }
    return this._createInternalTab(kind);
  }
  openSettings() { return this.openInternal('settings'); }
  openPasswords() { return this.openInternal('passwords'); }

  // Create a privileged internal-page tab: our own local <kind>.html loaded with
  // settingsPreload.js. It never touches the network, isn't recorded in history,
  // and is locked so it can't navigate to remote content (which would otherwise
  // inherit the preload's window.api).
  _createInternalTab(kind) {
    const id = ++this.seq;
    const view = new WebContentsView({
      webPreferences: {
        session: this.ctx.session,
        preload: path.join(__dirname, INTERNAL[kind].preload),
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      },
    });
    view.setBackgroundColor('#1c1c1e'); // matches the page bg → no first-paint flash
    view._internal = kind;
    const wc = view.webContents;

    // Links / window.open from the page open as normal web tabs; the privileged
    // view itself only ever shows our local file (any navigation away is blocked).
    // Deliberately NOT _attachWindowOpenHandling: a trusted internal page must
    // never spawn a real popup window — everything routes to an ordinary tab.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:\/\//i.test(url)) this.createTab(url, undefined, { background: disposition === 'background-tab' });
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, navUrl) => { if (!/^file:\/\//i.test(navUrl)) e.preventDefault(); });
    wc.on('did-finish-load', () => this.emitTabs());
    // Same top-edge reveal gesture as web pages (settingsPreload reports it).
    wc.ipc.on('edge:enter', () => this.reveal(true));
    wc.ipc.on('edge:leave', () => this.reveal(false));
    this._bindShortcuts(wc);
    this._bindZoom(wc); // Ctrl + wheel zoom, same as web tabs (covers every internal page)

    this.tabs.set(id, view);
    this.order.push(id);
    this.win.contentView.addChildView(view);
    this._raiseChrome();
    wc.loadFile(path.join(__dirname, 'ui', `${kind}.html`));
    this.activate(id);
    this.peek();
    return id;
  }

  navigateView(view, input) {
    let url = normalizeUrl(input);
    const s = this.ctx.store.getSettings();
    if (s.httpsOnly && /^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(url)) {
      view._upgraded = url;                 // remember original for fallback
      url = url.replace(/^http:\/\//i, 'https://');
    } else {
      view._upgraded = null;
    }
    view.webContents.loadURL(url);
  }

  activate(id) {
    if (!this.tabs.has(id)) return;
    this.activeId = id;
    for (const [tid, v] of this.tabs) v.setVisible(tid === id);
    this.overlay = false;            // close any panel when switching tabs
    this.send('panel:close');
    this.relayout();
    this.emitTabs();
  }

  closeTab(id) {
    const view = this.tabs.get(id);
    if (!view) return;
    this.win.contentView.removeChildView(view);
    view.webContents.close();
    this.tabs.delete(id);
    this.order = this.order.filter((t) => t !== id);
    if (this.activeId === id) {
      const next = this.order[this.order.length - 1] ?? null;
      if (next) this.activate(next);
      else { this.activeId = null; this.createTab(); }
    } else {
      this.emitTabs();
    }
  }

  _active() { return this.tabs.get(this.activeId); }

  navigate(input) {
    const internalKind = internalKindFor(input);
    if (internalKind) { this.openInternal(internalKind); return; }
    const v = this._active();
    if (!v) return;
    // Never load arbitrary web content into a privileged internal view — open it
    // in a normal tab instead.
    if (v._internal) { this.createTab(input); return; }
    this.navigateView(v, input);
  }
  // Drop a bookmark onto a tab → load it there and focus that tab.
  navigateTabTo(id, input) {
    const internalKind = internalKindFor(input);
    if (internalKind) { this.openInternal(internalKind); return; }
    const view = this.tabs.get(id);
    if (!view) return;
    if (view._internal) { this.createTab(input); return; }
    this.navigateView(view, input);
    this.activate(id);
  }
  back()    { this._active()?.webContents.navigationHistory.goBack(); }
  forward() { this._active()?.webContents.navigationHistory.goForward(); }
  reload()  { this._active()?.webContents.reload(); }
  stop()    { this._active()?.webContents.stop(); }

  // Middle-click on back/forward → open that history entry in a background tab
  // rather than navigating the current one.
  backNewTab()    { this._navEntryNewTab(-1); }
  forwardNewTab() { this._navEntryNewTab(1); }
  _navEntryNewTab(delta) {
    const v = this._active();
    if (!v || v._internal) return;
    const nh = v.webContents.navigationHistory;
    const i = nh.getActiveIndex() + delta;
    if (i < 0 || i >= nh.length()) return;
    const entry = nh.getEntryAtIndex(i);
    if (entry && /^https?:\/\//i.test(entry.url)) this.createTab(entry.url, undefined, { background: true });
  }

  // Page zoom: Ctrl +/-/0 (keyboard) and Ctrl + wheel (via the zoom-changed
  // handler in createTab). Clamped to Chromium's usual 25%–500% range.
  _zoom(dir) { const wc = this._active()?.webContents; if (wc) this._zoomStep(wc, dir); }
  _zoomReset() { this._active()?.webContents.setZoomFactor(1); this.emitTabs(); }

  nextTab(dir = 1) {
    if (this.order.length < 2) return;
    const i = this.order.indexOf(this.activeId);
    const n = (i + dir + this.order.length) % this.order.length;
    this.activate(this.order[n]);
  }
  selectIndex(i) { if (this.order[i] != null) this.activate(this.order[i]); }

  // ---- security: cert errors + https fallback ------------------------------
  _onCertError(event, errUrl, callback, tabId) {
    const host = hostOf(errUrl);
    if (this.ctx.certAllow.has(host)) { event.preventDefault(); callback(true); return; }
    event.preventDefault();
    callback(false);
    if (tabId === this.activeId) {
      this.send('security:interstitial', { type: 'cert', url: errUrl, host });
      this.setChromeLayout({ overlay: true });
    }
  }

  _onFailLoad(code, failedUrl, isMainFrame, tabId) {
    if (!isMainFrame) return;
    if (code === -3) return; // aborted (e.g. user navigated away)
    const view = this.tabs.get(tabId);
    if (view && view._upgraded && /^https:\/\//i.test(failedUrl)) {
      // The https upgrade failed — offer to fall back to the original http URL.
      const original = view._upgraded;
      view._upgraded = null;
      if (tabId === this.activeId) {
        this.send('security:interstitial', { type: 'https', url: original, host: hostOf(original) });
        this.setChromeLayout({ overlay: true });
      }
    }
  }

  proceed(url) {
    const view = this._active();
    if (!view) return;
    const host = hostOf(url);
    if (host) this.ctx.certAllow.add(host);
    this.overlay = false;
    view._upgraded = null;                 // don't re-upgrade if it was an http fallback
    view.webContents.loadURL(url);
    this.send('panel:close');
    this.relayout();
  }

  // ---- password manager ----------------------------------------------------
  _onCaptured({ origin, username, password }) {
    if (!password) return;
    const s = this.ctx.store.getSettings();
    if (!s.savePasswords || !this.ctx.vault.available) return;
    if (this.ctx.vault.locked) return; // can't dedupe or save while locked
    if (!this.ctx.vault.isNew(origin, username, password)) return; // already saved
    // Distinguish a brand-new credential from a changed password for the same
    // (origin, username) so the prompt can say "update" instead of "save".
    const update = this.ctx.vault.has(origin, username);
    this._pendingCred = { origin, username, password };
    this.send('password:prompt', { origin, username, update });
    if (this.autoHide) this.reveal(true);
  }

  savePending(accept) {
    if (accept && this._pendingCred) {
      const { origin, username, password } = this._pendingCred;
      this.ctx.vault.save(origin, username, password);
      broadcastState(this.ctx);
    }
    this._pendingCred = null;
  }

  // Ctrl + mouse-wheel zoom. Electron surfaces the request via zoom-changed but
  // doesn't apply it, so we step the zoom factor ourselves. Bound on every tab —
  // web AND internal (settings/passwords/future pages) — so the gesture is
  // uniform; Ctrl +/-/0 are the keyboard equivalents in _bindShortcuts.
  // Snap a webContents to the adjacent zoom preset (dir>0 in, dir<0 out) and
  // refresh the badge. Snapping to the preset list (rather than multiplying the
  // current factor) guarantees 100% is always a stop — even when a page starts
  // at an odd persisted zoom, which is what produced values like 107%.
  _zoomStep(wc, dir) {
    const cur = wc.getZoomFactor();
    const next = dir > 0
      ? (ZOOM_LEVELS.find((z) => z > cur + 1e-3) ?? ZOOM_LEVELS.at(-1))
      : (ZOOM_LEVELS.filter((z) => z < cur - 1e-3).at(-1) ?? ZOOM_LEVELS[0]);
    wc.setZoomFactor(next);
    this.emitTabs();
  }

  // ---- window.open / target=_blank ----------------------------------------
  // Single source of truth for how new windows are handled, shared by every
  // web-content view (the two inline handlers this replaced used to drift).
  //
  //  - non-http(s) (javascript:, data:, …)  → deny, open nothing.
  //  - disposition 'new-window'             → a real popup window. The site asked
  //      for window features (width/height/"popup"), e.g. Google's OAuth popup.
  //      We `allow` so window.open() returns a usable reference (deny would make
  //      it null and break the opener / postMessage handshake). The popup inherits
  //      the opener's session (we set NO partition), so login cookies are shared.
  //  - anything else (foreground/background-tab) → open as a normal tab; deny the
  //      native window so it stays inside our chrome.
  _windowOpenHandler({ url, disposition }) {
    if (!/^https?:\/\//i.test(url)) return { action: 'deny' };
    if (disposition === 'new-window') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: '#131313',
          webPreferences: {
            // No `session`/`partition` → inherits the opener's session, so the
            // popup shares claude.ai / google.com login cookies. No tab preload:
            // OAuth needs no autofill/scrollbar and a minimal popup is safer.
            sandbox: true, contextIsolation: true, nodeIntegration: false,
            webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
          },
        },
      };
    }
    this.createTab(url, undefined, { background: disposition === 'background-tab' });
    return { action: 'deny' };
  }

  // Wire the shared open handler onto a tab webContents, and make any popup it
  // spawns reuse the same logic (OAuth flows sometimes chain popups). The heavy
  // hardening (permissions, ad blocker, downloads) is session-level via
  // hardenSession and the popup shares the session, so it's already covered.
  _attachWindowOpenHandling(wc) {
    wc.setWindowOpenHandler((details) => this._windowOpenHandler(details));
    wc.on('did-create-window', (childWin) => {
      if (childWin.isDestroyed()) return;
      childWin.webContents.setWindowOpenHandler((details) => this._windowOpenHandler(details));
    });
  }

  // Ctrl + mouse-wheel zoom. Electron only NOTIFIES via zoom-changed — it does
  // NOT apply the zoom itself — so we apply it: one preset step per wheel notch.
  _bindZoom(wc) {
    wc.on('zoom-changed', (_e, dir) => this._zoomStep(wc, dir === 'in' ? 1 : -1));
  }

  // ---- keyboard shortcuts (work whether page or chrome has focus) ----------
  _bindShortcuts(wc) {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const ctrl = input.control || input.meta;
      const shift = input.shift;
      const key = (input.key || '').toLowerCase();
      const consume = () => event.preventDefault();

      if (ctrl && !shift && key === 't') { consume(); this.createTab(); return; }
      if (ctrl && !shift && key === 'w') { consume(); this.closeTab(this.activeId); return; }
      if (ctrl && !shift && key === 'l') { consume(); this.setChromeLayout({ overlay: false }); this.reveal(true); this.send('focus-address'); return; }
      if (ctrl && key === 'tab') { consume(); this.nextTab(shift ? -1 : 1); return; }
      if (ctrl && !shift && (key === 'r')) { consume(); this.reload(); return; }
      if (key === 'f5') { consume(); this.reload(); return; }
      if (ctrl && !shift && key === 'f') { consume(); this.reveal(true); this.send('find:open'); return; }
      if (ctrl && !shift && key === 'd') { consume(); this._bookmarkActiveAndEdit(); return; }
      if (ctrl && !shift && key === 'h') { consume(); this.send('panel:open', 'history'); return; }
      if (ctrl && !shift && key === 'j') { consume(); this.send('panel:open', 'downloads'); return; }
      if (ctrl && shift && key === 'h') { consume(); this._toggleAutoHide(); return; }
      if (ctrl && shift && key === 'n') { consume(); openIncognitoWindow(); return; }
      if (input.alt && key === 'arrowleft') { consume(); this.back(); return; }
      if (input.alt && key === 'arrowright') { consume(); this.forward(); return; }
      // '+' on most layouts needs Shift, so accept zoom in/out with or without it.
      if (ctrl && (key === '=' || key === '+')) { consume(); this._zoom(1); return; }
      if (ctrl && (key === '-' || key === '_')) { consume(); this._zoom(-1); return; }
      if (ctrl && !shift && key === '0') { consume(); this._zoomReset(); return; }
      if (key === 'escape') { this.send('escape'); if (this.revealed) this.reveal(false); return; }
      if (ctrl && /^[1-9]$/.test(key)) {
        consume();
        if (key === '9') this.selectIndex(this.order.length - 1);
        else this.selectIndex(parseInt(key, 10) - 1);
      }
    });
  }

  // Add the active tab to bookmarks (idempotent) and return the record so the
  // caller can open the edit popup. Returns null if there's nothing to bookmark.
  _addBookmarkActive() {
    const v = this._active();
    if (!v || v._internal) return null;       // internal pages aren't bookmarkable
    const url = v.webContents.getURL();
    if (!url || url === 'about:blank') return null;
    const rec = this.ctx.store.addBookmark(url, v.webContents.getTitle(), v._favicon || null);
    this.emitTabs();
    broadcastState(this.ctx);
    return rec;
  }

  // Keyboard / menu entry point: bookmark, then ask the chrome UI to open the
  // name/folder editor for it (Chrome-style).
  _bookmarkActiveAndEdit() {
    const rec = this._addBookmarkActive();
    if (rec) this.send('bookmark:edit', rec.id);
  }

  _toggleAutoHide() {
    const next = !this.autoHide;
    this.ctx.store.setSetting('autoHide', next);
    for (const b of browsers) {
      if (b.ctx !== this.ctx) continue;
      b._clearPeek();
      b.revealed = false;
      b._animatingOut = false;
      b.relayout();
      broadcastState(b.ctx);
      if (next) b.peek(2800); // enabling auto-hide: briefly show so it's discoverable
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }

function normalizeUrl(input) {
  const s = (input || '').trim();
  if (!s) return 'about:blank';
  if (/^[a-z]+:\/\//i.test(s) || s.startsWith('about:')) return s;
  if (/^[^\s]+\.[^\s]+$/.test(s)) return 'https://' + s;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

function broadcastState(ctx) {
  const s = ctx.store.getSettings();
  const payload = {
    settings: s,
    profile: ctx.name,
    incognito: ctx.incognito,
    blocked: ctx.blocked,
    vaultAvailable: ctx.vault.available,
    osEncryption: ctx.vault.usingOsEncryption,
    vaultHasMaster: ctx.vault.hasMaster,
    vaultLocked: ctx.vault.locked,
    bookmarks: ctx.store.bookmarks(),
    bookmarkFolders: ctx.store.bookmarkFolders(),
  };
  for (const b of browsers) {
    if (b.ctx !== ctx) continue;
    b.send('state:update', payload);
    // Internal page views (Settings) also subscribe to state:update so they can
    // live-refresh their controls when a setting or the language changes.
    // Defense-in-depth: only push this privileged state to a view still showing
    // our local file (the view is locked to file://, but don't lean on that one
    // guard when the payload carries settings/bookmarks/vault state).
    for (const v of b.tabs.values()) {
      if (v._internal && !v.webContents.isDestroyed()
          && v.webContents.getURL().startsWith('file://')) {
        v.webContents.send('state:update', payload);
      }
    }
  }
}

function broadcastDownloads(ctx) {
  for (const b of browsers) if (b.ctx === ctx) b.send('downloads:update', ctx.store.downloads());
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createWindow(profileName = 'default', opts = {}) {
  const ctx = getProfile(profileName, opts);
  const win = new BrowserWindow({
    width: 1280, height: 840,
    backgroundColor: ctx.incognito ? '#11111b' : '#1e1e2e',
    title: ctx.incognito ? 'Kibo (Incognito)' : 'Kibo',
    frame: false,            // no OS title bar — window controls live in our chrome (Vivaldi-style)
    minWidth: 480, minHeight: 360,
  });
  const browser = new Browser(win, ctx, { url: opts.url });
  browsers.add(browser);

  // Re-layout the views on ANY size change. On some Linux WMs the content
  // bounds aren't updated yet when the event fires, so we also relayout on the
  // next tick.
  let relayoutPending = false;
  const relayoutSoon = () => {
    browser.relayout();
    if (!relayoutPending) {                 // coalesce the trailing pass to once/tick
      relayoutPending = true;
      setImmediate(() => { relayoutPending = false; browser.relayout(); });
    }
  };
  win.on('resize', relayoutSoon);
  win.on('resized', relayoutSoon);
  win.on('maximize', () => { relayoutSoon(); browser.send('window:maximized', true); });
  win.on('unmaximize', () => { relayoutSoon(); browser.send('window:maximized', false); });
  win.on('enter-full-screen', () => { relayoutSoon(); browser.send('window:maximized', true); });
  win.on('leave-full-screen', () => { relayoutSoon(); browser.send('window:maximized', false); });
  win.on('closed', () => browsers.delete(browser));
  return browser;
}

function openIncognitoWindow(url) {
  createWindow(`incognito-${++incognitoSeq}`, { incognito: true, url });
}

function browserFromEvent(e) {
  const wc = e.sender;
  for (const b of browsers) if (b.chromeView.webContents === wc) return b;
  return null;
}

// Resolve the Browser for a sender that must be trusted chrome: the chrome view
// or one of our own internal page views (Settings). Web-content tab views are
// rejected, so a compromised page renderer can't read or write settings.
function browserFromTrusted(e) {
  const wc = e.sender;
  for (const b of browsers) {
    if (b.chromeView.webContents === wc) return b;
    for (const v of b.tabs.values()) if (v._internal && v.webContents === wc) return b;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Favicons for the password manager. Privacy-preserving: we fetch the SITE'S
// OWN favicon over the profile session (no third-party favicon service) and
// hand it back as a data: URI so the strict-CSP passwords page (img-src data:)
// can render it. Order: the conventional /favicon.ico, then the page's own
// declared <link rel=icon> (for sites that 404 on /favicon.ico and ship the icon
// at a non-root path — common for university/enterprise portals), then
// apple-touch-icon.png. The declared href may live on the site's own CDN, but
// it's still the site's icon — never a favicon-aggregation service. Cached in
// memory only for this app session (key = host; value = data-URI string OR null
// for a cached miss) — never written to disk/vault, so incognito stays clean.
// Uses the session-scoped Session.fetch (electron.d.ts line 12919:
// `fetch(input, init?): Promise<GlobalResponse>`).
// ---------------------------------------------------------------------------
const faviconCache = new Map();
const FAVICON_MAX_BYTES = 200 * 1024;  // skip oversized responses (banners, etc.)
const FAVICON_HTML_MAX = 256 * 1024;   // only the <head> matters; cap scanned HTML
const FAVICON_TIMEOUT_MS = 5000;

// A session fetch that aborts after FAVICON_TIMEOUT_MS (so one slow host can't
// stall the manager). Throws on abort/network error; callers handle it.
function fetchWithTimeout(sess, url, init = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FAVICON_TIMEOUT_MS);
  return sess.fetch(url, { redirect: 'follow', ...init, signal: ctl.signal })
    .finally(() => clearTimeout(timer));
}

// Fetch one candidate URL and return it as a data: URI if it's a usable image,
// else null. Favicon servers often mislabel the content-type, so we default to
// x-icon; but a text/html body is a soft-404 / login page, never an icon.
async function fetchIconData(sess, urlStr) {
  if (/^data:image\//i.test(urlStr)) return urlStr; // icon inlined in the <link>
  try {
    const res = await fetchWithTimeout(sess, urlStr);
    if (!res.ok) return null;
    let mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (mime === 'text/html') return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > FAVICON_MAX_BYTES) return null;
    if (!mime.startsWith('image/')) mime = 'image/x-icon';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

// Parse <link rel="...icon..." href="..."> tags from page HTML, resolving each
// href against the page's URL.
function parseIconHrefs(html, baseUrl) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(tag)) continue;
    const h = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!h) continue;
    try { out.push(new URL(h[1], baseUrl).href); } catch { /* skip bad href */ }
  }
  return out;
}

// Fetch the origin's root HTML and return any declared icon URLs (resolved).
async function discoverIconHrefs(sess, originUrl) {
  try {
    const res = await fetchWithTimeout(sess, originUrl + '/');
    if (!res.ok || !/text\/html/i.test(res.headers.get('content-type') || '')) return [];
    const html = (await res.text()).slice(0, FAVICON_HTML_MAX);
    return parseIconHrefs(html, res.url || originUrl);
  } catch { return []; }
}

async function fetchFavicon(sess, origin) {
  let url;
  try { url = new URL(origin); } catch { return null; }
  const host = url.host;
  if (faviconCache.has(host)) return faviconCache.get(host);

  // 1. Conventional root favicon — one cheap request covers most sites.
  let data = await fetchIconData(sess, `${url.origin}/favicon.ico`);
  // 2. Otherwise read the page's declared <link rel=icon> (handles non-root paths).
  if (!data) {
    for (const href of await discoverIconHrefs(sess, url.origin)) {
      data = await fetchIconData(sess, href);
      if (data) break;
    }
  }
  // 3. Last resort.
  if (!data) data = await fetchIconData(sess, `${url.origin}/apple-touch-icon.png`);

  faviconCache.set(host, data || null); // cache result (incl. miss) for this session
  return data || null;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function wireIpc() {
  // Tabs / navigation
  ipcMain.on('tab:new', (e, url) => browserFromEvent(e)?.createTab(url));
  ipcMain.on('tab:newBackground', (e, url) => browserFromEvent(e)?.createTab(url, undefined, { background: true }));
  ipcMain.on('tab:newAt', (e, { url, index }) => browserFromEvent(e)?.createTab(url, index));
  ipcMain.on('tab:navigate', (e, { id, url }) => browserFromEvent(e)?.navigateTabTo(id, url));
  ipcMain.on('tab:close', (e, id) => browserFromEvent(e)?.closeTab(id));
  ipcMain.on('tab:select', (e, id) => browserFromEvent(e)?.activate(id));
  ipcMain.on('tab:cycle', (e, dir) => browserFromEvent(e)?.nextTab(dir === -1 ? -1 : 1));
  ipcMain.on('nav:go', (e, url) => browserFromEvent(e)?.navigate(url));
  ipcMain.on('nav:back', (e) => browserFromEvent(e)?.back());
  ipcMain.on('nav:backNewTab', (e) => browserFromEvent(e)?.backNewTab());
  ipcMain.on('nav:forward', (e) => browserFromEvent(e)?.forward());
  ipcMain.on('nav:forwardNewTab', (e) => browserFromEvent(e)?.forwardNewTab());
  ipcMain.on('zoom:reset', (e) => browserFromEvent(e)?._zoomReset());
  ipcMain.on('nav:reload', (e) => browserFromEvent(e)?.reload());
  ipcMain.on('nav:stop', (e) => browserFromEvent(e)?.stop());

  // Chrome layout (bar height + full-window overlay for panels)
  ipcMain.on('chrome:layout', (e, layout) => browserFromEvent(e)?.setChromeLayout(layout || {}));
  ipcMain.on('chrome:slideDone', (e, shown) => browserFromEvent(e)?.onSlideDone(shown));

  // Settings (chrome view + the internal Settings page are the only trusted callers)
  ipcMain.handle('settings:get', (e) => browserFromTrusted(e)?.ctx.store.getSettings());
  ipcMain.on('settings:set', (e, { key, value }) => {
    const b = browserFromTrusted(e); if (!b) return;
    b.ctx.store.setSetting(key, value);
    for (const o of browsers) if (o.ctx === b.ctx) o.relayout();
    broadcastState(b.ctx);
  });
  ipcMain.on('settings:openTab', (e) => browserFromEvent(e)?.openSettings());
  ipcMain.on('passwords:openTab', (e) => browserFromEvent(e)?.openPasswords());

  // Bookmarks
  // Add active tab + return the record so the renderer can open the editor.
  ipcMain.handle('bookmark:add', (e) => browserFromEvent(e)?._addBookmarkActive() ?? null);
  ipcMain.handle('bookmark:update', (e, { id, patch }) => {
    const b = browserFromEvent(e); if (!b) return null;
    const r = b.ctx.store.updateBookmark(id, patch);
    b.emitTabs(); broadcastState(b.ctx); return r;
  });
  ipcMain.on('bookmark:remove', (e, id) => {
    const b = browserFromEvent(e); if (!b) return;
    b.ctx.store.removeBookmark(id); b.emitTabs(); broadcastState(b.ctx);
  });
  ipcMain.on('bookmark:move', (e, payload) => {
    const b = browserFromEvent(e); if (!b || !payload) return;
    b.ctx.store.moveItem(payload); broadcastState(b.ctx);
  });
  ipcMain.handle('bookmark:addFolder', (e, { title, parentId }) => {
    const b = browserFromEvent(e); if (!b) return null;
    const f = b.ctx.store.addFolder(title, parentId); broadcastState(b.ctx); return f;
  });
  ipcMain.handle('bookmark:updateFolder', (e, { id, patch }) => {
    const b = browserFromEvent(e); if (!b) return null;
    const r = b.ctx.store.updateFolder(id, patch); broadcastState(b.ctx); return r;
  });
  ipcMain.on('bookmark:removeFolder', (e, id) => {
    const b = browserFromEvent(e); if (!b) return;
    b.ctx.store.removeFolder(id); b.emitTabs(); broadcastState(b.ctx);
  });
  ipcMain.handle('bookmark:list', (e) => browserFromEvent(e)?.ctx.store.bookmarks());
  ipcMain.on('clipboard:write', (_e, text) => { if (typeof text === 'string') clipboard.writeText(text); });

  // History
  ipcMain.handle('history:list', (e) => browserFromEvent(e)?.ctx.store.history());
  ipcMain.on('history:remove', (e, id) => browserFromEvent(e)?.ctx.store.removeHistory(id));
  ipcMain.on('history:clear', (e) => browserFromEvent(e)?.ctx.store.clearHistory());

  // Downloads
  ipcMain.handle('downloads:list', (e) => browserFromEvent(e)?.ctx.store.downloads());
  ipcMain.on('downloads:clear', (e) => {
    const b = browserFromEvent(e); if (!b) return;
    b.ctx.store.clearDownloads(); broadcastDownloads(b.ctx);
  });
  ipcMain.on('downloads:open', (_e, id) => {
    const entry = downloadItems.get(id);
    if (entry?.path) shell.openPath(entry.path);
  });
  ipcMain.on('downloads:reveal', (_e, id) => {
    const entry = downloadItems.get(id);
    if (entry?.path) shell.showItemInFolder(entry.path);
  });
  ipcMain.on('downloads:cancel', (_e, id) => downloadItems.get(id)?.item.cancel());

  // Passwords
  const VAULT_LOCK_MS = 10 * 60 * 1000; // auto-lock an unlocked vault after idle
  const armAutoLock = (ctx) => {
    clearTimeout(ctx._lockTimer);
    if (!ctx.vault.hasMaster) return;
    ctx._lockTimer = setTimeout(() => { ctx.vault.lock(); broadcastState(ctx); }, VAULT_LOCK_MS);
  };

  ipcMain.handle('passwords:get', (e, origin) => {
    // Called by content preloads (tab views) for autofill.
    for (const b of browsers) {
      for (const v of b.tabs.values()) {
        if (v.webContents === e.sender) {
          const s = b.ctx.store.getSettings();
          if (!s.savePasswords) return [];
          const creds = b.ctx.vault.for(origin);
          if (creds.length) armAutoLock(b.ctx); // used → push the lock back
          return creds;
        }
      }
    }
    return [];
  });
  // Manager channels: trusted callers are the chrome view + the internal
  // password-manager page (mybrowser://passwords), never a web-content tab.
  ipcMain.handle('passwords:list', (e) => browserFromTrusted(e)?.ctx.vault.list());
  ipcMain.handle('passwords:reveal', (e, id) => {
    const b = browserFromTrusted(e); if (!b) return null;
    const c = b.ctx.vault.list({ reveal: true }).find((c) => c.id === id) || null;
    if (c) armAutoLock(b.ctx);
    return c;
  });
  // The site's own favicon (same-origin) as a data: URI, for the manager list.
  ipcMain.handle('passwords:favicon', async (e, origin) => {
    const b = browserFromTrusted(e); if (!b) return null;
    try { return await fetchFavicon(b.ctx.session, origin); } catch { return null; }
  });
  ipcMain.on('passwords:remove', (e, id) => {
    const b = browserFromTrusted(e); if (!b) return;
    b.ctx.vault.remove(id); broadcastState(b.ctx);
  });
  // Manual add/edit from the manager page. Normalize free-text the user typed
  // ("example.com", "https://x.com/login") into the canonical origin we store and
  // match autofill against (URL.origin: scheme://host[:port], no path/slash).
  const toOrigin = (input) => {
    let s = (input || '').trim(); if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      return u.origin;
    } catch { return null; }
  };
  ipcMain.handle('passwords:save', (e, { origin, username, password } = {}) => {
    const b = browserFromTrusted(e); if (!b) return null;
    const norm = toOrigin(origin); if (!norm) return null;
    if (typeof password !== 'string' || !password) return null;
    const list = b.ctx.vault.save(norm, (username || '').trim(), password);
    if (list) { armAutoLock(b.ctx); broadcastState(b.ctx); }
    return list;
  });
  ipcMain.handle('passwords:update', (e, { id, origin, username, password } = {}) => {
    const b = browserFromTrusted(e); if (!b) return null;
    const norm = toOrigin(origin); if (!norm) return null;
    if (typeof password !== 'string' || !password) return null;
    const list = b.ctx.vault.update(id, norm, (username || '').trim(), password);
    if (list) { armAutoLock(b.ctx); broadcastState(b.ctx); }
    return list;
  });
  // The manager view can't navigate to remote content itself (will-navigate
  // blocks anything but file://), so open a saved site as a normal web tab.
  ipcMain.on('passwords:openSite', (e, origin) => {
    const b = browserFromTrusted(e); if (!b) return;
    const norm = toOrigin(origin); if (!norm) return;
    b.createTab(norm); // null internalKind ⇒ a sandboxed web-content tab, activated
  });
  ipcMain.on('password:decision', (e, accept) => browserFromEvent(e)?.savePending(accept));

  // Account-picker support, called by the content preload (tab webContents).
  const browserFromTab = (sender) => {
    for (const b of browsers) for (const v of b.tabs.values()) {
      if (v.webContents === sender) return b;
    }
    return null;
  };
  ipcMain.handle('passwords:labels', (e) => {
    const ko = browserFromTab(e.sender)?.ctx.store.getSettings().lang === 'ko';
    // The content preload can't reach ui/i18n.js (different world/bundle), so the
    // two picker labels are localized here.
    return ko
      ? { fromThisSite: '이 사이트에서', manage: '비밀번호 관리' }
      : { fromThisSite: 'From this website', manage: 'Manage Passwords' };
  });
  // "Manage passwords" from the autofill dropdown → open the manager tab.
  ipcMain.on('ui:openPasswords', (e) => browserFromTab(e.sender)?.openPasswords());

  // Master password (vault lock). Trusted callers: chrome view + the internal
  // password-manager page.
  ipcMain.handle('vault:status', (e) => {
    const b = browserFromTrusted(e); if (!b) return null;
    // Include lang so the page localizes on first load (before any broadcast).
    return { ...b.ctx.vault.status(), lang: b.ctx.store.getSettings().lang };
  });
  ipcMain.handle('vault:unlock', async (e, pw) => {
    const b = browserFromTrusted(e); if (!b) return false;
    const ok = await b.ctx.vault.unlock(pw);
    if (ok) { armAutoLock(b.ctx); broadcastState(b.ctx); }
    return ok;
  });
  ipcMain.on('vault:lock', (e) => {
    const b = browserFromTrusted(e); if (!b) return;
    clearTimeout(b.ctx._lockTimer);
    b.ctx.vault.lock(); broadcastState(b.ctx);
  });
  ipcMain.handle('vault:setMaster', async (e, pw) => {
    const b = browserFromTrusted(e); if (!b) return false;
    const ok = await b.ctx.vault.enableMaster(pw);
    if (ok) { armAutoLock(b.ctx); broadcastState(b.ctx); }
    return ok;
  });
  ipcMain.handle('vault:disableMaster', async (e) => {
    const b = browserFromTrusted(e); if (!b) return false;
    const ok = await b.ctx.vault.disableMaster();
    if (ok) { clearTimeout(b.ctx._lockTimer); broadcastState(b.ctx); }
    return ok;
  });

  // Find in page
  ipcMain.on('find:run', (e, { text, forward }) => {
    const b = browserFromEvent(e); const v = b?._active();
    if (v && text) v.webContents.findInPage(text, { forward: forward !== false, findNext: false });
  });
  ipcMain.on('find:stop', (e) => {
    const b = browserFromEvent(e); b?._active()?.webContents.stopFindInPage('clearSelection');
  });

  // Security interstitial actions
  ipcMain.on('security:proceed', (e, url) => browserFromEvent(e)?.proceed(url));

  // Window controls (frameless)
  ipcMain.on('window:minimize', (e) => browserFromEvent(e)?.win.minimize());
  ipcMain.on('window:maximize', (e) => {
    const w = browserFromEvent(e)?.win; if (!w) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  ipcMain.on('window:close', (e) => browserFromEvent(e)?.win.close());

  // Profiles / windows
  ipcMain.on('window:new', (e, url) =>
    createWindow(browserFromEvent(e)?.ctx.name || 'default', { url: typeof url === 'string' ? url : undefined }));
  ipcMain.on('window:incognito', (e, url) => openIncognitoWindow(typeof url === 'string' ? url : undefined));
  ipcMain.on('profile:open', (_e, name) => createWindow(name || 'default'));
  ipcMain.handle('profile:list', () => listProfileNames());
}

function listProfileNames() {
  const fs = require('node:fs');
  const base = path.join(app.getPath('userData'), 'profiles');
  let names = ['default'];
  try {
    names = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('incognito-'))
      .map((d) => d.name);
    if (!names.includes('default')) names.unshift('default');
  } catch {}
  return names;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
Menu.setApplicationMenu(null); // shortcuts are handled via before-input-event

app.whenReady().then(() => {
  // Fail fast (not silently): without the bundled preload, web pages would lose
  // their scrollbars, the auto-hide reveal, and password capture/autofill.
  if (!fs.existsSync(TAB_PRELOAD)) {
    const msg = `Missing ${path.relative(__dirname, TAB_PRELOAD)} — run \`npm run build\` `
      + '(or `npm start`, which builds for you).';
    console.error('[kibo] ' + msg);             // visible in the launching terminal
    dialog.showErrorBox('Build required', msg); // and a dialog for no-terminal launches
    app.exit(1);
    return;
  }
  wireIpc();
  createWindow('default');
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow('default'); });

  // Auto-update (AppImage). Check once on launch; electron-updater downloads the
  // new GitHub release in the background and installs it on the next quit. No-ops
  // in dev (`electron .`) — auto-update only runs from a packaged build.
  if (app.isPackaged) {
    autoUpdater.on('error', (err) => console.error('[kibo] update error:', err && err.message));
    autoUpdater.on('update-downloaded', (info) =>
      console.log('[kibo] update', info.version, 'downloaded — installs on quit'));
    autoUpdater.checkForUpdatesAndNotify();
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
