'use strict';

// Secure bridge between the chrome UI (renderer) and the main process.
// Only an explicit, validated API surface is exposed — no Node, no raw ipc.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('api', {
  // tabs / navigation
  newTab: (url) => ipcRenderer.send('tab:new', url),
  newTabAt: (url, index) => ipcRenderer.send('tab:newAt', { url, index }),
  navigateTab: (id, url) => ipcRenderer.send('tab:navigate', { id, url }),
  closeTab: (id) => ipcRenderer.send('tab:close', id),
  selectTab: (id) => ipcRenderer.send('tab:select', id),
  go: (url) => ipcRenderer.send('nav:go', url),
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  stop: () => ipcRenderer.send('nav:stop'),

  // chrome layout: tell main our bar height and whether a panel covers content
  setLayout: (layout) => ipcRenderer.send('chrome:layout', layout),
  slideDone: (shown) => ipcRenderer.send('chrome:slideDone', shown),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.send('settings:set', { key, value }),
  openSettings: () => ipcRenderer.send('settings:openTab'),

  // bookmarks
  addBookmark: () => ipcRenderer.invoke('bookmark:add'),
  updateBookmark: (id, patch) => ipcRenderer.invoke('bookmark:update', { id, patch }),
  removeBookmark: (id) => ipcRenderer.send('bookmark:remove', id),
  moveBookmark: (payload) => ipcRenderer.send('bookmark:move', payload),
  addBookmarkFolder: (title, parentId) => ipcRenderer.invoke('bookmark:addFolder', { title, parentId }),
  updateBookmarkFolder: (id, patch) => ipcRenderer.invoke('bookmark:updateFolder', { id, patch }),
  removeBookmarkFolder: (id) => ipcRenderer.send('bookmark:removeFolder', id),
  listBookmarks: () => ipcRenderer.invoke('bookmark:list'),
  copyText: (text) => ipcRenderer.send('clipboard:write', text),

  // history
  listHistory: () => ipcRenderer.invoke('history:list'),
  removeHistory: (id) => ipcRenderer.send('history:remove', id),
  clearHistory: () => ipcRenderer.send('history:clear'),

  // downloads
  listDownloads: () => ipcRenderer.invoke('downloads:list'),
  openDownload: (id) => ipcRenderer.send('downloads:open', id),
  revealDownload: (id) => ipcRenderer.send('downloads:reveal', id),
  cancelDownload: (id) => ipcRenderer.send('downloads:cancel', id),
  clearDownloads: () => ipcRenderer.send('downloads:clear'),

  // passwords
  listPasswords: () => ipcRenderer.invoke('passwords:list'),
  revealPassword: (id) => ipcRenderer.invoke('passwords:reveal', id),
  removePassword: (id) => ipcRenderer.send('passwords:remove', id),
  passwordDecision: (accept) => ipcRenderer.send('password:decision', accept),

  // find in page
  find: (text, forward) => ipcRenderer.send('find:run', { text, forward }),
  findStop: () => ipcRenderer.send('find:stop'),

  // security interstitial
  proceed: (url) => ipcRenderer.send('security:proceed', url),

  // window controls (frameless)
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  // windows / profiles
  newWindow: (url) => ipcRenderer.send('window:new', url),
  newIncognito: (url) => ipcRenderer.send('window:incognito', url),
  openProfile: (name) => ipcRenderer.send('profile:open', name),
  listProfiles: () => ipcRenderer.invoke('profile:list'),

  // events from main
  onTabs: on('tabs:update'),
  onState: on('state:update'),
  onDownloads: on('downloads:update'),
  onPasswordPrompt: on('password:prompt'),
  onInterstitial: on('security:interstitial'),
  onFindResult: on('find:result'),
  onFocusAddress: on('focus-address'),
  onFindOpen: on('find:open'),
  onPanelOpen: on('panel:open'),
  onPanelClose: on('panel:close'),
  onEscape: on('escape'),
  onMaximized: on('window:maximized'),
  onReveal: on('reveal'),
  onBookmarkEdit: on('bookmark:edit'),
});
