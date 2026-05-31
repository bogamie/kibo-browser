'use strict';

// ---------------------------------------------------------------------------
// Privileged preload for the internal password manager (mybrowser://passwords),
// which renders as a real browser tab. Like settingsPreload.js it exposes a
// window.api — but only the vault read/manage surface (list / reveal / remove /
// master-password lock), nothing else. The page is one of our own local files
// and the main process locks the view down (deny window.open to remote content,
// block any navigation away from file://), so this API can never leak to a web
// origin. Plaintext passwords only ever cross this boundary on an explicit
// reveal(), and only while the vault is unlocked.
// ---------------------------------------------------------------------------
const { contextBridge, ipcRenderer } = require('electron');

// One persistent state:update listener; onState() just swaps the callback (the
// preload context survives reloads, so re-registering would stack listeners).
let stateCb = null;
ipcRenderer.on('state:update', (_e, payload) => { if (stateCb) stateCb(payload); });

contextBridge.exposeInMainWorld('api', {
  status: () => ipcRenderer.invoke('vault:status'),
  list: () => ipcRenderer.invoke('passwords:list'),
  reveal: (id) => ipcRenderer.invoke('passwords:reveal', id),
  favicon: (origin) => ipcRenderer.invoke('passwords:favicon', origin),  // site's own favicon as a data: URI

  remove: (id) => ipcRenderer.send('passwords:remove', id),
  save: (cred) => ipcRenderer.invoke('passwords:save', cred),            // {origin,username,password}
  update: (id, cred) => ipcRenderer.invoke('passwords:update', { id, ...cred }),
  openSite: (origin) => ipcRenderer.send('passwords:openSite', origin),
  unlock: (pw) => ipcRenderer.invoke('vault:unlock', pw),
  lock: () => ipcRenderer.send('vault:lock'),
  setMaster: (pw) => ipcRenderer.invoke('vault:setMaster', pw),
  disableMaster: () => ipcRenderer.invoke('vault:disableMaster'),
  onState: (cb) => { stateCb = cb; },
});

// ---- auto-hide reveal: pointer near the top edge --------------------------
// Mirror tabPreload.js / settingsPreload.js so the Zen-mode chrome can still be
// revealed while this page fills the window. Same hysteresis thresholds.
const SHOW_AT = 6;
const HIDE_BELOW = 150;
let shownTop = false;
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
window.addEventListener('mouseenter', reportEdge, { passive: true, capture: true });
