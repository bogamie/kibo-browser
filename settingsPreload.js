'use strict';

// ---------------------------------------------------------------------------
// Privileged preload for the internal Settings page (mybrowser://settings),
// which renders as a real browser tab. Unlike the web-content preload
// (tabPreload.js) this DOES expose a window.api — but only the settings
// read/write surface, nothing else. The page is one of our own local files and
// the main process locks the view down (deny window.open to remote content,
// block any navigation away from file://), so this API can never leak to a web
// origin.
// ---------------------------------------------------------------------------
const { contextBridge, ipcRenderer } = require('electron');

// One persistent state:update listener; onState() just swaps the callback. The
// preload context survives page reloads (Ctrl+R), so registering a fresh
// ipcRenderer.on per onState() call would otherwise stack listeners on reload.
let stateCb = null;
ipcRenderer.on('state:update', (_e, payload) => { if (stateCb) stateCb(payload); });

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.send('settings:set', { key, value }),
  onState: (cb) => { stateCb = cb; },
});

// ---- auto-hide reveal: pointer near the top edge --------------------------
// Mirror tabPreload.js so the Zen-mode chrome can still be revealed while the
// Settings page fills the window. Same hysteresis thresholds: reveal at the top
// SHOW_AT px, hide again once the pointer drops below HIDE_BELOW px.
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
