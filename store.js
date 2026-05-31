'use strict';

// ---------------------------------------------------------------------------
// Per-profile persistent JSON store: settings, bookmarks, history, downloads.
// One Store instance per profile. Incognito profiles use `persistent: false`
// so nothing is ever written to disk.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = {
  autoHide: false,       // Zen-style: hide chrome, reveal on hover at top edge
  blockAds: true,        // ad/tracker blocking
  httpsOnly: true,       // upgrade http -> https for top-level navigations
  savePasswords: true,   // offer to save site credentials
  homeUrl: 'https://www.google.com',
  lang: 'en',            // UI language: 'en' | 'ko'
};

class Store {
  /**
   * @param {string} dir   profile data directory
   * @param {boolean} persistent  false for incognito (memory only)
   */
  constructor(dir, persistent = true) {
    this.dir = dir;
    this.persistent = persistent;
    this.file = path.join(dir, 'data.json');
    this.data = {
      settings: { ...DEFAULT_SETTINGS },
      bookmarks: [],       // { id, title, url, ts, parentId, order }  parentId=folder id/null
      bookmarkFolders: [], // { id, title, ts, parentId, order }       order: position among siblings
      history: [],         // { id, title, url, ts }
      downloads: [],       // { id, filename, url, path, state, received, total, ts }
    };
    this.seq = 1;
    if (persistent) this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
        bookmarks: (raw.bookmarks || []).map((b) => ({ parentId: null, ...b })),
        bookmarkFolders: raw.bookmarkFolders || [],
        history: raw.history || [],
        downloads: raw.downloads || [],
      };
      const ids = [...this.data.bookmarks, ...this.data.bookmarkFolders,
        ...this.data.history, ...this.data.downloads]
        .map((x) => x.id || 0);
      this.seq = (ids.length ? Math.max(...ids) : 0) + 1;
      this._migrateOrder();
    } catch {
      /* first run or unreadable — keep defaults */
    }
  }

  _save() {
    if (!this.persistent) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('store save failed:', e.message);
    }
  }

  _id() { return this.seq++; }

  // --- settings ---
  getSettings() { return { ...this.data.settings }; }
  setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return this.getSettings();
    this.data.settings[key] = value;
    this._save();
    return this.getSettings();
  }

  // --- bookmarks ---
  bookmarks() { return this.data.bookmarks; }
  bookmarkFolders() { return this.data.bookmarkFolders; }
  isBookmarked(url) { return this.data.bookmarks.some((b) => b.url === url); }
  getBookmark(url) { return this.data.bookmarks.find((b) => b.url === url) || null; }

  // --- sibling ordering (folders + bookmarks share one order space) ---
  // Backfill `order` for data saved before ordering existed: folders first,
  // then bookmarks, in their stored sequence — preserving the old look.
  _migrateOrder() {
    const counters = new Map();
    const next = (p) => { const k = p ?? '_'; const v = counters.get(k) || 0; counters.set(k, v + 1); return v; };
    for (const f of this.data.bookmarkFolders) if (f.order == null) f.order = next(f.parentId ?? null);
    for (const b of this.data.bookmarks) if (b.order == null) b.order = next(b.parentId ?? null);
  }
  _siblings(parentId) {
    const p = parentId ?? null;
    const items = [
      ...this.data.bookmarkFolders.filter((f) => (f.parentId ?? null) === p).map((ref) => ({ id: ref.id, kind: 'folder', ref })),
      ...this.data.bookmarks.filter((b) => (b.parentId ?? null) === p).map((ref) => ({ id: ref.id, kind: 'bookmark', ref })),
    ];
    return items.sort((a, b) => (a.ref.order ?? 0) - (b.ref.order ?? 0));
  }
  _nextOrder(parentId) {
    const s = this._siblings(parentId);
    return s.length ? Math.max(...s.map((x) => x.ref.order ?? 0)) + 1 : 0;
  }
  _folderDescendants(id) {
    const set = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of this.data.bookmarkFolders) {
        if (!set.has(f.id) && f.parentId != null && set.has(f.parentId)) { set.add(f.id); grew = true; }
      }
    }
    return set;
  }

  // Move/reorder an item to `index` among the children of `parentId`.
  moveItem({ id, kind, parentId, index }) {
    const p = parentId ?? null;
    const list = kind === 'folder' ? this.data.bookmarkFolders : this.data.bookmarks;
    const item = list.find((x) => x.id === id);
    if (!item) return;
    if (kind === 'folder' && this._folderDescendants(id).has(p)) return; // no cycles
    item.parentId = p;
    const sibs = this._siblings(p).filter((s) => !(s.id === id && s.kind === kind));
    const i = (index == null || index < 0 || index > sibs.length) ? sibs.length : index;
    sibs.splice(i, 0, { id, kind, ref: item });
    sibs.forEach((s, idx) => { s.ref.order = idx; });
    this._save();
  }

  // Add a bookmark for url (no-op returning the existing one if already saved).
  addBookmark(url, title, favicon) {
    let b = this.data.bookmarks.find((x) => x.url === url);
    if (!b) {
      b = { id: this._id(), url, title: title || url, favicon: favicon || null, ts: Date.now(), parentId: null, order: this._nextOrder(null) };
      this.data.bookmarks.push(b);
      this._save();
    }
    return b;
  }
  updateBookmark(id, patch) {
    const b = this.data.bookmarks.find((x) => x.id === id);
    if (!b) return null;
    if (typeof patch.title === 'string') b.title = patch.title.trim() || b.url;
    if ('parentId' in patch) b.parentId = patch.parentId ?? null;
    this._save();
    return b;
  }
  removeBookmark(id) {
    this.data.bookmarks = this.data.bookmarks.filter((b) => b.id !== id);
    this._save();
  }

  addFolder(title, parentId = null) {
    const p = parentId ?? null;
    const f = { id: this._id(), title: (title || '').trim() || 'New folder', ts: Date.now(), parentId: p, order: this._nextOrder(p) };
    this.data.bookmarkFolders.push(f);
    this._save();
    return f;
  }
  // Rename and/or re-parent a folder (mirrors updateBookmark). Re-parenting is
  // ignored if it would create a cycle (move into itself or a descendant).
  updateFolder(id, patch) {
    const f = this.data.bookmarkFolders.find((x) => x.id === id);
    if (!f) return null;
    if (typeof patch.title === 'string') f.title = patch.title.trim() || f.title;
    if ('parentId' in patch) {
      const p = patch.parentId ?? null;
      if (!this._folderDescendants(id).has(p)) f.parentId = p;
    }
    this._save();
    return f;
  }
  // Delete a folder and everything nested inside it (subfolders + bookmarks).
  removeFolder(id) {
    const doomed = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of this.data.bookmarkFolders) {
        if (!doomed.has(f.id) && f.parentId != null && doomed.has(f.parentId)) {
          doomed.add(f.id); grew = true;
        }
      }
    }
    this.data.bookmarkFolders = this.data.bookmarkFolders.filter((f) => !doomed.has(f.id));
    this.data.bookmarks = this.data.bookmarks.filter((b) => !doomed.has(b.parentId));
    this._save();
  }

  // --- history ---
  history() { return this.data.history; }
  addHistory(url, title) {
    if (!this.persistent) return;                 // never record in incognito
    if (!/^https?:\/\//i.test(url)) return;
    const last = this.data.history[0];
    if (last && last.url === url) {               // collapse repeats
      last.title = title || last.title;
      last.ts = Date.now();
    } else {
      this.data.history.unshift({ id: this._id(), url, title: title || url, ts: Date.now() });
      if (this.data.history.length > 5000) this.data.history.length = 5000;
    }
    this._save();
  }
  removeHistory(id) {
    this.data.history = this.data.history.filter((h) => h.id !== id);
    this._save();
  }
  clearHistory() { this.data.history = []; this._save(); }

  // --- downloads ---
  downloads() { return this.data.downloads; }
  addDownload(d) {
    const rec = { id: this._id(), ts: Date.now(), ...d };
    this.data.downloads.unshift(rec);
    this._save();
    return rec;
  }
  updateDownload(id, patch) {
    const rec = this.data.downloads.find((x) => x.id === id);
    if (rec) { Object.assign(rec, patch); this._save(); }
    return rec;
  }
  clearDownloads() {
    this.data.downloads = this.data.downloads.filter((d) => d.state === 'progressing');
    this._save();
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
