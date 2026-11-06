/* DHE1 end-to-end encryption + pairing-code helpers for the web sender.
 * Classic script (exposes window.DHC) and CommonJS (for Node tests).
 *
 * Envelope: "DHE1" | nonce(12) | AES-256-GCM ciphertext | tag(16)
 * AAD     : UTF-8 bytes of the full MQTT topic string.
 * (WebCrypto returns ciphertext||tag, which is exactly this layout.)
 */
(function (root) {
  'use strict';
  var MAGIC = [0x44, 0x48, 0x45, 0x31];   // "DHE1"
  var NONCE = 12, TAG = 16, HEADER = 4 + NONCE;
  var PAIR_PREFIX = 'DH1:';

  function subtle() {
    var c = root.crypto || (typeof require !== 'undefined' ? require('crypto').webcrypto : null);
    if (!c || !c.subtle) throw new Error('This browser has no WebCrypto (needs https or localhost).');
    return c;
  }
  function utf8(s) { return new TextEncoder().encode(s); }
  function fromUtf8(u) { return new TextDecoder().decode(u); }

  // ── encodings ──
  function hexToBytes(h) {
    h = String(h || '').trim();
    if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error('Not valid hex.');
    var o = new Uint8Array(h.length / 2);
    for (var i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16);
    return o;
  }
  function bytesToHex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function bytesToB64(b) {
    var s = '';
    for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64ToBytes(t) {
    var s = atob(t), o = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) o[i] = s.charCodeAt(i);
    return o;
  }
  function bytesToB64url(b) { return bytesToB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64urlToBytes(t) {
    t = String(t).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return b64ToBytes(t);
  }

  function randomBytes(n) {
    var u = new Uint8Array(n); subtle().getRandomValues(u); return u;
  }
  function generateKey() { return randomBytes(32); }

  // ── DHE1 ──
  var keyCache = new Map();
  function importKey(keyBytes) {
    if (!keyBytes || keyBytes.length !== 32) return Promise.reject(new Error('Key must be 32 bytes.'));
    var id = bytesToHex(keyBytes), k = keyCache.get(id);
    if (!k) {
      k = subtle().subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      keyCache.set(id, k);
    }
    return k;
  }

  // nonce is optional (tests only); never pass one in production.
  function encrypt(keyBytes, topic, plaintext, nonce) {
    nonce = nonce || randomBytes(NONCE);
    if (typeof plaintext === 'string') plaintext = utf8(plaintext);
    return importKey(keyBytes).then(function (k) {
      return subtle().subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: utf8(topic), tagLength: 128 }, k, plaintext);
    }).then(function (ct) {
      ct = new Uint8Array(ct);
      var out = new Uint8Array(HEADER + ct.length);
      out.set(MAGIC, 0); out.set(nonce, 4); out.set(ct, HEADER);
      return out;
    });
  }

  function isEnvelope(p) {
    return !!p && p.length >= HEADER + TAG && p[0] === MAGIC[0] && p[1] === MAGIC[1] && p[2] === MAGIC[2] && p[3] === MAGIC[3];
  }

  // Resolves to plaintext Uint8Array; rejects if not an envelope or auth fails.
  function decrypt(keyBytes, topic, envelope) {
    if (!isEnvelope(envelope)) return Promise.reject(new Error('Not a DHE1 envelope.'));
    var nonce = envelope.slice(4, HEADER), ct = envelope.slice(HEADER);
    return importKey(keyBytes).then(function (k) {
      return subtle().subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: utf8(topic), tagLength: 128 }, k, ct);
    }).then(function (pt) { return new Uint8Array(pt); },
            function () { throw new Error('Decryption failed (wrong key, topic or tampered).'); });
  }

  // The broker's last-will message: exactly this plaintext, nothing else.
  function isOfflineLwt(p) {
    var s = '{"online":false}';
    if (!p || p.length !== s.length) return false;
    for (var i = 0; i < s.length; i++) if (p[i] !== s.charCodeAt(i)) return false;
    return true;
  }

  // ── Pairing code: "DH1:" + base64url(JSON) ──
  var ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
  function cleanName(n) { return typeof n === 'string' ? n.trim().slice(0, 24) : ''; }
  function encodePairing(p) {
    var o = {
      v: 1, host: p.host, user: p.user, pass: p.pass, root: p.root || 'displayhub',
      wsport: p.wsport || 8084, wspath: p.wspath || '/mqtt',
      key: bytesToB64(p.key), devices: [p.devices[0], p.devices[1]]
    };
    // Optional display names per device id, so both people see the same labels.
    if (p.names) {
      var nm = {};
      p.devices.forEach(function (id) { var n = cleanName(p.names[id]); if (n) nm[id] = n; });
      if (Object.keys(nm).length) o.names = nm;
    }
    return PAIR_PREFIX + bytesToB64url(utf8(JSON.stringify(o)));
  }
  // Returns {host,user,pass,root,key:Uint8Array,devices:[a,b]} or throws Error with a friendly message.
  function decodePairing(code) {
    code = String(code || '').replace(/\s+/g, '');
    if (code.slice(0, PAIR_PREFIX.length) !== PAIR_PREFIX) throw new Error('That doesn’t look like a pairing code (it should start with DH1:).');
    var o;
    try { o = JSON.parse(fromUtf8(b64urlToBytes(code.slice(PAIR_PREFIX.length)))); }
    catch (e) { throw new Error('That pairing code is damaged — try copying it again.'); }
    if (!o || o.v !== 1) throw new Error('This pairing code is from a newer version.');
    var key;
    try { key = b64ToBytes(o.key); } catch (e) { key = null; }
    if (!key || key.length !== 32) throw new Error('The key in that code isn’t valid.');
    if (!o.host || !o.user || typeof o.pass !== 'string' || !o.pass) throw new Error('The code is missing broker details.');
    if (!Array.isArray(o.devices) || o.devices.length !== 2 || !ID_RE.test(o.devices[0]) || !ID_RE.test(o.devices[1]) || o.devices[0] === o.devices[1])
      throw new Error('The code needs two different device ids.');
    var rt = String(o.root || 'displayhub');
    if (/[#+\s]/.test(rt)) throw new Error('The topic root in that code isn’t valid.');
    var wsport = o.wsport === undefined ? 8084 : +o.wsport, wspath = o.wspath === undefined ? '/mqtt' : String(o.wspath);
    if (!(wsport >= 1 && wsport <= 65535 && wsport === Math.floor(wsport))) throw new Error('The websocket port in that code isn’t valid.');
    if (wspath.charAt(0) !== '/' || /\s/.test(wspath)) throw new Error('The websocket path in that code isn’t valid.');
    var names = {};
    if (o.names && typeof o.names === 'object') o.devices.forEach(function (id) { var n = cleanName(o.names[id]); if (n) names[id] = n; });
    return { wsport: wsport, wspath: wspath, host: String(o.host), user: String(o.user), pass: o.pass, root: rt, key: key, devices: [o.devices[0], o.devices[1]], names: names };
  }

  var DHC = {
    MAGIC: MAGIC, NONCE: NONCE, TAG: TAG, HEADER: HEADER, ID_RE: ID_RE,
    hexToBytes: hexToBytes, bytesToHex: bytesToHex, bytesToB64: bytesToB64, b64ToBytes: b64ToBytes,
    bytesToB64url: bytesToB64url, b64urlToBytes: b64urlToBytes, randomBytes: randomBytes, generateKey: generateKey,
    encrypt: encrypt, decrypt: decrypt, isEnvelope: isEnvelope, isOfflineLwt: isOfflineLwt,
    encodePairing: encodePairing, decodePairing: decodePairing
  };
  root.DHC = DHC;
  if (typeof module !== 'undefined' && module.exports) module.exports = DHC;
})(typeof window !== 'undefined' ? window : globalThis);
