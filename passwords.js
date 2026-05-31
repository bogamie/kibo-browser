'use strict';

// ---------------------------------------------------------------------------
// Per-site credential vault.
//
// At rest, every secret is encrypted. Three blob formats can appear in the file:
//   m1:  master-password mode — AES-256-GCM under a key derived from the user's
//        master password (scrypt). The key lives ONLY in memory after unlock and
//        is wiped on lock/auto-lock, so neither a stolen file NOR another process
//        running as the user can read secrets without the master password.
//   v1:  OS mode — Electron safeStorage (OS keychain / libsecret).
//   b64: fallback obfuscation when no real OS encryption is available — never
//        plaintext on disk, and flagged so the UI can warn.
//
// Secrets are kept ENCRYPTED in memory and decrypted lazily, one at a time, only
// when actually needed (autofill / reveal) — so a memory scrape never exposes the
// whole vault at once.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeStorage } = require('electron');

// Fixed plaintext encrypted under the master key so we can verify an entered
// master password (GCM auth-tag failure ⇒ wrong password) without storing it.
const CHECK_TOKEN = 'mybrowser-vault-check-v1';

class PasswordVault {
  /**
   * @param {string} dir         profile directory
   * @param {boolean} persistent false for incognito (never saves)
   */
  constructor(dir, persistent = true) {
    this.dir = dir;
    this.persistent = persistent;
    this.file = path.join(dir, 'passwords.enc');
    /** @type {Array<{id:number, origin:string, username:string, enc:string, ts:number}>} */
    this.creds = [];        // `enc` holds the at-rest blob, NOT plaintext
    this.seq = 1;
    this.encrypted = false; // real OS encryption available (for the UI warning)
    this.kdf = null;        // {salt,N,r,p} when a master password is set, else null
    this.check = null;      // verification blob (m1:) when a master password is set
    this.masterKey = null;  // 32-byte key, in memory only while unlocked
    if (persistent) {
      this._load();
      this.encrypted = this._osEncryptionReal();
    }
  }

  get available() { return this.persistent; }
  get usingOsEncryption() { return this.encrypted; }
  get hasMaster() { return !!this.kdf; }
  get locked() { return this.hasMaster && !this.masterKey; }

  // Snapshot for the renderer (what controls/warnings to show).
  status() {
    return {
      available: this.persistent,
      osEncryption: this.encrypted,
      hasMaster: this.hasMaster,
      locked: this.locked,
    };
  }

  // True ONLY when safeStorage will actually protect the secret. The catch:
  // on Linux, isEncryptionAvailable() can return true while the selected backend
  // is `basic_text` — a HARDCODED, publicly-known key ("peanuts") — which is no
  // protection at all. Treat that exactly like a missing keyring.
  _osEncryptionReal() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      const backend = safeStorage.getSelectedStorageBackend?.(); // Linux only
      if (backend === 'basic_text') return false;
      return true;
    } catch {
      return true; // non-Linux: isEncryptionAvailable() already vouched for it
    }
  }

  // ---- at-rest crypto -------------------------------------------------------
  _encMaster(plain, key = this.masterKey) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return 'm1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  _decMaster(blob, key = this.masterKey) {
    const buf = Buffer.from(blob.slice(3), 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }

  // Encrypt one secret with the CURRENT strategy (master key if unlocked, else
  // OS keyring, else b64 fallback).
  _encOne(plain) {
    if (this.masterKey) return this._encMaster(plain);
    this.encrypted = this._osEncryptionReal();
    return this.encrypted
      ? 'v1:' + safeStorage.encryptString(plain).toString('base64')
      : 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
  }

  // Decrypt one blob by its prefix. Throws if a master-mode blob is read while
  // locked, or if safeStorage/GCM rejects it.
  _decOne(blob) {
    if (!blob) return '';
    if (blob.startsWith('m1:')) {
      if (!this.masterKey) throw new Error('vault locked');
      return this._decMaster(blob);
    }
    if (blob.startsWith('v1:')) return safeStorage.decryptString(Buffer.from(blob.slice(3), 'base64'));
    if (blob.startsWith('b64:')) return Buffer.from(blob.slice(4), 'base64').toString('utf8');
    return '';
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.kdf = raw.kdf || null;
      this.check = raw.check || null;
      // Keep blobs encrypted in memory; decrypt lazily on demand. `ts` is the
      // last-modified time.
      this.creds = (raw.creds || []).map((c) => ({
        id: c.id, origin: c.origin, username: c.username, enc: c.password, ts: c.ts,
      }));
      this.seq = this.creds.reduce((m, c) => Math.max(m, c.id || 0), 0) + 1;
    } catch {
      /* first run */
    }
  }

  _save() {
    if (!this.persistent) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const out = {
        kdf: this.kdf || undefined,
        check: this.check || undefined,
        creds: this.creds.map((c) => ({
          id: c.id, origin: c.origin, username: c.username, password: c.enc, ts: c.ts,
        })),
      };
      fs.writeFileSync(this.file, JSON.stringify(out));
    } catch (e) {
      console.error('vault save failed:', e.message);
    }
  }

  // ---- master password (lock/unlock) ---------------------------------------
  _newKdf() { return { salt: crypto.randomBytes(16).toString('base64'), N: 1 << 16, r: 8, p: 1 }; }

  _deriveKey(password, kdf) {
    return new Promise((resolve, reject) => {
      crypto.scrypt(password, Buffer.from(kdf.salt, 'base64'), 32,
        { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 },
        (err, key) => (err ? reject(err) : resolve(key)));
    });
  }

  // Turn ON a master password: derive a key, re-encrypt every stored secret under
  // it, write a verification token. Requires the vault readable now (so we can
  // migrate the current plaintexts).
  async enableMaster(password) {
    if (!this.persistent || this.hasMaster || this.locked || !password) return false;
    const kdf = this._newKdf();
    const key = await this._deriveKey(password, kdf);
    const plains = this.creds.map((c) => { try { return this._decOne(c.enc); } catch { return null; } });
    this.kdf = kdf;
    this.masterKey = key;
    this.check = this._encMaster(CHECK_TOKEN);
    this.creds.forEach((c, i) => { if (plains[i] != null) c.enc = this._encMaster(plains[i]); });
    this._save();
    return true;
  }

  // Verify an entered master password and unlock for this session.
  async unlock(password) {
    if (!this.hasMaster) return true;
    if (this.masterKey) return true;
    let key;
    try { key = await this._deriveKey(password, this.kdf); } catch { return false; }
    try { if (this._decMaster(this.check, key) !== CHECK_TOKEN) return false; } catch { return false; }
    this.masterKey = key;
    return true;
  }

  // Wipe the in-memory key — secrets become unreadable until the next unlock.
  lock() { this.masterKey = null; }

  // Turn OFF the master password (requires being unlocked): re-encrypt secrets
  // back to OS/b64 and drop the kdf/check.
  async disableMaster() {
    if (!this.hasMaster) return true;
    if (this.locked) return false;
    const plains = this.creds.map((c) => { try { return this._decOne(c.enc); } catch { return null; } });
    this.kdf = null; this.check = null; this.masterKey = null;
    this.creds.forEach((c, i) => { if (plains[i] != null) c.enc = this._encOne(plains[i]); });
    this._save();
    return true;
  }

  // ---- credential access (lazy decrypt) ------------------------------------
  // Look up saved credentials for an origin (https://example.com).
  for(origin) {
    if (this.locked) return [];
    const out = [];
    for (const c of this.creds) {
      if (c.origin !== origin) continue;
      try { out.push({ id: c.id, origin: c.origin, username: c.username, password: this._decOne(c.enc) }); }
      catch { /* skip undecryptable */ }
    }
    return out;
  }

  // Has a credential that would NOT be a no-op to save? (new origin/user, or changed pw)
  isNew(origin, username, password) {
    const m = this.creds.find((c) => c.origin === origin && c.username === username);
    if (!m) return true;
    try { return this._decOne(m.enc) !== password; }
    catch { return true; }
  }

  // Do we already store this (origin, username) pair? Lets the save prompt phrase
  // itself as "update" vs "save". No decryption needed.
  has(origin, username) {
    return this.creds.some((c) => c.origin === origin && c.username === username);
  }

  save(origin, username, password) {
    if (!this.persistent || this.locked) return null;
    const enc = this._encOne(password);
    const now = Date.now();
    const m = this.creds.find((c) => c.origin === origin && c.username === username);
    if (m) { m.enc = enc; m.ts = now; }
    else this.creds.unshift({ id: this.seq++, origin, username, enc, ts: now });
    this._save();
    return this.list();
  }

  // Edit an existing entry by id. Unlike save() (which keys by origin+username and
  // would orphan the old row when those change), this updates in place so the id
  // — and the entry's identity — is preserved. Re-encrypts under the current
  // strategy (m1: while unlocked / v1: / b64:).
  update(id, origin, username, password) {
    if (!this.persistent || this.locked) return null;
    const m = this.creds.find((c) => c.id === id);
    if (!m) return null;
    m.origin = origin;
    m.username = username;
    m.enc = this._encOne(password);
    m.ts = Date.now();
    this._save();
    return this.list();
  }

  remove(id) {
    this.creds = this.creds.filter((c) => c.id !== id);
    this._save();
    return this.list();
  }

  // Metadata only by default; while locked, expose NOTHING (not even which sites
  // have saved logins). Plaintext leaves only with { reveal: true } and unlocked.
  list({ reveal = false } = {}) {
    if (this.locked) return [];
    return this.creds.map((c) => {
      let password = '••••••••';
      if (reveal) { try { password = this._decOne(c.enc); } catch { /* keep masked */ } }
      return { id: c.id, origin: c.origin, username: c.username, password, ts: c.ts };
    });
  }
}

module.exports = { PasswordVault };
