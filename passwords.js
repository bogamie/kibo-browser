'use strict';

// ---------------------------------------------------------------------------
// Per-site credential vault. Secrets are encrypted at rest with Electron's
// safeStorage (OS keychain / libsecret). If the OS keyring is unavailable we
// fall back to obfuscation only — never plaintext on disk — and flag it so the
// UI can warn the user.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');

class PasswordVault {
  /**
   * @param {string} dir         profile directory
   * @param {boolean} persistent false for incognito (never saves)
   */
  constructor(dir, persistent = true) {
    this.dir = dir;
    this.persistent = persistent;
    this.file = path.join(dir, 'passwords.enc');
    /** @type {Array<{id:number, origin:string, username:string, password:string, ts:number}>} */
    this.creds = [];
    this.seq = 1;
    this.encrypted = false;
    if (persistent) this._load();
  }

  get available() { return this.persistent; }
  get usingOsEncryption() { return this.encrypted; }

  _enc(text) {
    if (safeStorage.isEncryptionAvailable()) {
      this.encrypted = true;
      return 'v1:' + safeStorage.encryptString(text).toString('base64');
    }
    this.encrypted = false;
    return 'b64:' + Buffer.from(text, 'utf8').toString('base64'); // fallback
  }

  _dec(blob) {
    if (blob.startsWith('v1:')) {
      return safeStorage.decryptString(Buffer.from(blob.slice(3), 'base64'));
    }
    if (blob.startsWith('b64:')) {
      return Buffer.from(blob.slice(4), 'base64').toString('utf8');
    }
    return '';
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.creds = (raw.creds || []).map((c) => ({ ...c, password: this._dec(c.password) }));
      this.seq = (this.creds.reduce((m, c) => Math.max(m, c.id || 0), 0)) + 1;
    } catch {
      /* first run */
    }
  }

  _save() {
    if (!this.persistent) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const out = { creds: this.creds.map((c) => ({ ...c, password: this._enc(c.password) })) };
      fs.writeFileSync(this.file, JSON.stringify(out));
    } catch (e) {
      console.error('vault save failed:', e.message);
    }
  }

  // Look up saved credentials for an origin (https://example.com).
  for(origin) {
    return this.creds
      .filter((c) => c.origin === origin)
      .map((c) => ({ id: c.id, origin: c.origin, username: c.username, password: c.password }));
  }

  // Has a credential that would NOT be a no-op to save? (new origin/user, or changed pw)
  isNew(origin, username, password) {
    const m = this.creds.find((c) => c.origin === origin && c.username === username);
    return !m || m.password !== password;
  }

  save(origin, username, password) {
    if (!this.persistent) return null;
    const m = this.creds.find((c) => c.origin === origin && c.username === username);
    if (m) { m.password = password; m.ts = Date.now(); }
    else this.creds.unshift({ id: this.seq++, origin, username, password, ts: Date.now() });
    this._save();
    return this.list();
  }

  remove(id) {
    this.creds = this.creds.filter((c) => c.id !== id);
    this._save();
    return this.list();
  }

  // Metadata only by default (no plaintext passwords leave main unless asked).
  list({ reveal = false } = {}) {
    return this.creds.map((c) => ({
      id: c.id,
      origin: c.origin,
      username: c.username,
      password: reveal ? c.password : '••••••••',
      ts: c.ts,
    }));
  }
}

module.exports = { PasswordVault };
