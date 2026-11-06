(function () {
  'use strict';
  var CFG_KEY = 'littlescreens.config.v2';

  function $(id) { return document.getElementById(id); }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }

  // ── localStorage helpers (can throw in private mode / file:// quirks) ──
  function lsGet(key, fallback) {
    try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (e) {} }

  // cfg: {host,user,pass,root,keyB64 ('' = no encryption),mine,theirs,labels:{mine,theirs}}
  var cfg = lsGet(CFG_KEY, null);
  if (cfg && !(cfg.host && cfg.user && cfg.pass && cfg.mine && cfg.theirs)) cfg = null;
  var keyBytes = null;
  var devices = {};            // id -> {online, mode, gif_ts, msg_ts, cmd_ts, unreadable}
  var client = null;
  var pending = null;          // {device, kind, ts, mode, state, el}
  var lastTs = 0;

  function loadKey() {
    keyBytes = null;
    if (cfg && cfg.keyB64) { try { keyBytes = DHC.b64ToBytes(cfg.keyB64); } catch (e) { keyBytes = null; } if (keyBytes && keyBytes.length !== 32) keyBytes = null; }
  }
  loadKey();

  // Never behind what the clock already holds: a slow phone clock would
  // otherwise be silently ignored by the device's ts gating.
  function nextTs(id) {
    var d = devices[id] || {}, floor = lastTs;
    [d.gif_ts, d.msg_ts, d.cmd_ts].forEach(function (v) { if (typeof v === 'number' && v > floor) floor = v; });
    lastTs = Math.max(Date.now(), floor + 1);
    return lastTs;
  }
  function cleanHost(h) { return String(h || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/[\/:].*$/, ''); }
  function wsUrl(c) { return 'wss://' + c.host + ':' + (c.wsport || 8084) + (c.wspath || '/mqtt'); }
  function wsErr(port, path) {
    return !(/^\d+$/.test(port) && +port >= 1 && +port <= 65535) ? 'The websocket port should be a number (EMQX Cloud: 8084).' :
      (path.charAt(0) !== '/' || /\s/.test(path)) ? 'The websocket path should start with / (EMQX Cloud: /mqtt).' : '';
  }
  function rootOf(c) { return String((c && c.root) || 'displayhub').replace(/^\/+|\/+$/g, ''); }
  function topicOf(id, kind) { return rootOf(cfg) + '/' + id + '/' + kind; }
  function labelOf(which) {
    var l = (cfg && cfg.labels && cfg.labels[which]) || '';
    return l || (which === 'mine' ? 'My clock' : 'Their clock');
  }
  function labelFor(id) { return id === cfg.mine ? labelOf('mine') : labelOf('theirs'); }
  function saveCfg() { return lsSet(CFG_KEY, cfg); }

  // ── Pixel canvas helper ────────────────────────────────────────────────
  function drawPixels(canvas, px) {
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(OLED.W, OLED.H), d = img.data;
    for (var i = 0; i < px.length; i++) {
      var v = px[i] ? 255 : 0, o = i * 4;
      d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  // ── Copy helper ────────────────────────────────────────────────────────
  function copyText(text, el, btn) {
    function done(ok) { if (btn) { var t = btn.getAttribute('data-t') || btn.textContent; btn.setAttribute('data-t', t); btn.textContent = ok ? 'Copied ✓' : 'Press and hold to copy'; setTimeout(function () { btn.textContent = t; }, 1800); } }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
    } else fallback();
    function fallback() {
      try { el.focus(); el.select(); done(document.execCommand('copy')); } catch (e) { done(false); }
    }
  }

  // ── Settings / pairing UI ──────────────────────────────────────────────
  function showSettings(on) {
    show('settings', on);
    if (!on) return;
    var paired = !!cfg;
    $('settingsTitle').textContent = 'Settings';
    show('settingsTitle', paired);
    show('pairedPanel', paired); show('setupPanel', !paired);
    if (paired) {
      $('lblMine').value = (cfg.labels && cfg.labels.mine) || ''; $('lblTheirs').value = (cfg.labels && cfg.labels.theirs) || '';
      $('lblMine').placeholder = 'My clock'; show('codeShow', false);
      show('showCode', !!keyBytes);
    }
  }
  $('gear').addEventListener('click', function () { showSettings($('settings').classList.contains('hidden')); });

  $('lblSave').addEventListener('click', function () {
    cfg.labels = { mine: $('lblMine').value.trim().slice(0, 24), theirs: $('lblTheirs').value.trim().slice(0, 24) };
    saveCfg(); renderClocks(); showSettings(false);
  });
  $('showCode').addEventListener('click', function () {
    if (!keyBytes) return;
    var names = {}; names[cfg.mine] = (cfg.labels && cfg.labels.mine) || ''; names[cfg.theirs] = (cfg.labels && cfg.labels.theirs) || '';
    $('codeOut').value = DHC.encodePairing({ host: cfg.host, user: cfg.user, pass: cfg.pass, root: rootOf(cfg), wsport: cfg.wsport, wspath: cfg.wspath, key: keyBytes, devices: [cfg.mine, cfg.theirs], names: names });
    show('codeShow', true);
  });
  $('codeCopy').addEventListener('click', function () { copyText($('codeOut').value, $('codeOut'), this); });
  $('reSetup').addEventListener('click', function () { show('pairedPanel', false); show('setupPanel', true); });
  $('forget').addEventListener('click', function () {
    if (!confirm('Forget this pairing on this device? You will need the pairing code to set up again.')) return;
    lsDel(CFG_KEY); cfg = null; keyBytes = null; devices = {}; pending = null;
    if (client) { try { client.end(true); } catch (e) {} client = null; }
    ['jCode', 'nHost', 'nUser', 'nPass', 'nA', 'nB', 'aHost', 'aUser', 'aPass', 'aMine', 'aTheirs', 'aKey'].forEach(function (i) { $(i).value = ''; });
    show('jStep2', false); show('nOut', false);
    renderClocks(); setConn('not set up'); showSettings(true);
  });

  function setupTab(name) {
    ['join', 'new', 'adv'].forEach(function (t) {
      var cap = t.charAt(0).toUpperCase() + t.slice(1);
      show('sp' + cap, t === name); $('st' + cap).setAttribute('aria-selected', String(t === name));
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-st]'), function (b) {
    b.addEventListener('click', function () { setupTab(b.getAttribute('data-st')); });
  });

  function adopt(newCfg) {
    cfg = newCfg;
    if (!saveCfg()) alert('Couldn’t save in this browser (private mode?). It will work until you close the page.');
    loadKey(); devices = {}; pending = null;
    show('nOut', false);
    showSettings(false); renderClocks(); connect();
  }
  function err(id, msg) { $(id).textContent = msg || ''; show(id, !!msg); }

  // Join with code
  var joined = null;
  $('jCode').addEventListener('input', function () {
    joined = null; show('jStep2', false);
    var v = this.value.trim();
    if (!v) { err('jErr', ''); return; }
    try {
      joined = DHC.decodePairing(v); err('jErr', '');
      var sel = $('jMine'); sel.textContent = '';
      joined.devices.forEach(function (id) { var o = document.createElement('option'); o.value = id; o.textContent = joined.names[id] ? joined.names[id] + ' (' + id + ')' : id; sel.appendChild(o); });
      show('jStep2', true);
    } catch (e) { err('jErr', e.message); }
  });
  $('jGo').addEventListener('click', function () {
    if (!joined) return;
    var mine = $('jMine').value, theirs = joined.devices[0] === mine ? joined.devices[1] : joined.devices[0];
    adopt({ host: cleanHost(joined.host), user: joined.user, pass: joined.pass, root: joined.root, wsport: joined.wsport, wspath: joined.wspath, keyB64: DHC.bytesToB64(joined.key), mine: mine, theirs: theirs, labels: { mine: joined.names[mine] || '', theirs: joined.names[theirs] || '' } });
    $('jCode').value = ''; joined = null;
  });

  // New pair
  var fresh = null;
  function newFormError() {
    var host = cleanHost($('nHost').value), user = $('nUser').value.trim(), pass = $('nPass').value, root = $('nRoot').value.trim() || 'displayhub';
    var a = $('nA').value.trim(), b = $('nB').value.trim();
    if (!host) return 'Please add the broker host.';
    if (!user || !pass) return 'Please add the broker username and password.';
    if (/[#+\s]/.test(root)) return 'Topic root can’t contain spaces, # or +.';
    var we = wsErr($('nWsPort').value.trim(), $('nWsPath').value.trim()); if (we) return we;
    if (!DHC.ID_RE.test(a) || !DHC.ID_RE.test(b)) return 'Please give both clock ids (letters, digits, - _ .).';
    if (a === b) return 'The two clock ids must be different.';
    return '';
  }
  $('nMake').addEventListener('click', function () {
    var e = newFormError(); err('nErr', e); if (e) return;
    var key = DHC.generateKey(), a = $('nA').value.trim(), b = $('nB').value.trim();
    var c = { host: cleanHost($('nHost').value), user: $('nUser').value.trim(), pass: $('nPass').value, root: $('nRoot').value.trim() || 'displayhub', wsport: +$('nWsPort').value.trim(), wspath: $('nWsPath').value.trim(), key: key, devices: [a, b] };
    $('nCode').value = DHC.encodePairing(c); $('nHex').value = DHC.bytesToHex(key);
    var mineIdx = +$('nMine').value;
    fresh = { host: c.host, user: c.user, pass: c.pass, root: c.root, wsport: c.wsport, wspath: c.wspath, keyB64: DHC.bytesToB64(key), mine: c.devices[mineIdx], theirs: c.devices[1 - mineIdx], labels: {} };
    show('nOut', true);
  });
  $('nCopy').addEventListener('click', function () { copyText($('nCode').value, $('nCode'), this); });
  $('nCopyHex').addEventListener('click', function () { copyText($('nHex').value, $('nHex'), this); });
  $('nUse').addEventListener('click', function () { if (fresh) { adopt(fresh); fresh = null; } });
  ['nHost', 'nUser', 'nPass', 'nRoot', 'nWsPort', 'nWsPath', 'nA', 'nB', 'nMine'].forEach(function (id) {
    $(id).addEventListener('input', function () { show('nOut', false); fresh = null; });
  });

  // Look for clocks (topic names only; payloads are ignored)
  $('nScan').addEventListener('click', function () {
    var host = cleanHost($('nHost').value), user = $('nUser').value.trim(), pass = $('nPass').value, root = ($('nRoot').value.trim() || 'displayhub');
    var chips = $('nChips'); chips.textContent = '';
    if (!host || !user || !pass) { err('nErr', 'Fill in host, username and password first.'); return; }
    if (typeof mqtt === 'undefined') { err('nErr', 'MQTT library failed to load.'); return; }
    err('nErr', ''); chips.textContent = 'Looking…';
    var seen = {}, c = mqtt.connect(wsUrl({ host: host, wsport: $('nWsPort').value.trim(), wspath: $('nWsPath').value.trim() }), { username: user, password: pass, clientId: 'web-' + Math.random().toString(16).slice(2, 10), clean: true, reconnectPeriod: 0, connectTimeout: 10000, protocolVersion: 4 });
    var finish = function (msg) { try { c.end(true); } catch (e) {} if (!Object.keys(seen).length) chips.textContent = msg || 'No clocks seen yet — switch them on, or type the ids.'; };
    c.on('connect', function () { c.subscribe(root.replace(/^\/+|\/+$/g, '') + '/+/status', { qos: 1 }); setTimeout(finish, 4000); });
    c.on('error', function () { finish('Couldn’t connect — check the details.'); });
    c.on('message', function (topic) {
      var p = topic.split('/'); if (p.length < 3) return;
      var id = p[p.length - 2]; if (seen[id] || !DHC.ID_RE.test(id)) return;
      seen[id] = 1; if (chips.firstChild && chips.firstChild.nodeType === 3) chips.textContent = '';
      var b = document.createElement('button'); b.className = 'chip'; b.type = 'button'; b.textContent = id;
      b.addEventListener('click', function () {
        var tgt = !$('nA').value.trim() ? 'nA' : (!$('nB').value.trim() ? 'nB' : 'nA');
        $(tgt).value = id; show('nOut', false);
      });
      chips.appendChild(b);
    });
  });

  // Advanced
  $('aSave').addEventListener('click', function () {
    var c = { host: cleanHost($('aHost').value), user: $('aUser').value.trim(), pass: $('aPass').value, root: $('aRoot').value.trim() || 'displayhub', wsport: +$('aWsPort').value.trim(), wspath: $('aWsPath').value.trim(),
              mine: $('aMine').value.trim(), theirs: $('aTheirs').value.trim(), keyB64: '', labels: {} };
    var hex = $('aKey').value.trim(), e = '';
    if (hex) { try { var k = DHC.hexToBytes(hex); if (k.length !== 32) e = 'The key must be 64 hex characters.'; else c.keyB64 = DHC.bytesToB64(k); } catch (x) { e = 'The key must be 64 hex characters.'; } }
    if (!e) e = !c.host ? 'Please add the broker host.' : (!c.user || !c.pass) ? 'Please add the username and password.' :
      /[#+\s]/.test(c.root) ? 'Topic root can’t contain spaces, # or +.' :
      wsErr($('aWsPort').value.trim(), c.wspath) ? wsErr($('aWsPort').value.trim(), c.wspath) :
      (!DHC.ID_RE.test(c.mine) || !DHC.ID_RE.test(c.theirs)) ? 'Please give both clock ids.' : c.mine === c.theirs ? 'The two ids must be different.' : '';
    err('aErr', e); if (e) return;
    adopt(c);
  });

  // ── MQTT ───────────────────────────────────────────────────────────────
  function setConn(text, cls) { var c = $('conn'); c.textContent = text; c.className = 'pill ' + (cls || ''); }

  function connect() {
    if (client) { try { client.end(true); } catch (e) {} client = null; }
    if (!cfg) { setConn('not set up'); return; }
    if (typeof mqtt === 'undefined') { setConn('MQTT library failed to load', 'bad'); return; }
    if (!window.crypto || !crypto.subtle) { if (keyBytes) { setConn('encryption needs https', 'bad'); return; } }
    setConn('connecting…');
    client = mqtt.connect(wsUrl(cfg), {
      username: cfg.user, password: cfg.pass,
      clientId: 'web-' + Math.random().toString(16).slice(2, 10),
      clean: true, keepalive: 30, reconnectPeriod: 3000, connectTimeout: 15000, protocolVersion: 4
    });
    var me = client;
    me.on('connect', function () {
      setConn('connected', 'ok');
      me.subscribe([topicOf(cfg.mine, 'status'), topicOf(cfg.theirs, 'status')], { qos: 1 }, function (e) { if (e) setConn('subscribe failed', 'bad'); });
    });
    me.on('reconnect', function () { setConn('reconnecting…'); });
    me.on('offline', function () { setConn('offline', 'bad'); });
    me.on('close', function () { if (me === client) setConn('disconnected', 'bad'); });
    me.on('error', function (e) {
      var m = String(e && e.message || e);
      setConn(/not authorized|bad user|credentials/i.test(m) ? 'wrong username or password' : 'connection problem', 'bad');
    });
    me.on('message', function (topic, payload) { onStatusMessage(me, topic, payload); });
  }

  var statusSeq = {};
  function applyStatus(id, st, unreadable) {
    var prev = devices[id] || {};
    if (unreadable) { prev.unreadable = true; devices[id] = prev; renderClocks(); return; }
    devices[id] = {
      online: !!st.online,
      mode: st.mode || prev.mode || '',
      gif_ts: st.gif_ts !== undefined ? st.gif_ts : prev.gif_ts,
      msg_ts: st.msg_ts !== undefined ? st.msg_ts : prev.msg_ts,
      cmd_ts: st.cmd_ts !== undefined ? st.cmd_ts : prev.cmd_ts,
      unreadable: false
    };
    renderClocks();
    checkDelivered();
  }
  function onStatusMessage(me, topic, payload) {
    if (me !== client || !cfg) return;
    var id = topic === topicOf(cfg.mine, 'status') ? cfg.mine : topic === topicOf(cfg.theirs, 'status') ? cfg.theirs : null;
    if (!id) return;
    var seq = statusSeq[id] = (statusSeq[id] || 0) + 1;
    if (!payload || payload.length === 0) { delete devices[id]; renderClocks(); return; }
    payload = new Uint8Array(payload);
    if (!keyBytes) {   // dev mode: plaintext
      var st; try { st = JSON.parse(new TextDecoder().decode(payload)); } catch (e) { return; }
      applyStatus(id, st); return;
    }
    if (DHC.isOfflineLwt(payload)) { applyStatus(id, { online: false }); return; }
    DHC.decrypt(keyBytes, topic, payload).then(function (pt) {
      if (seq !== statusSeq[id]) return;           // a newer status already arrived
      var st; try { st = JSON.parse(new TextDecoder().decode(pt)); } catch (e) { applyStatus(id, null, true); return; }
      applyStatus(id, st);
    }, function () { if (seq === statusSeq[id]) applyStatus(id, null, true); });
  }

  // Encrypts (when a key is set) and publishes to <root>/<id>/<kind>.
  function publish(id, kind, payload) {
    return new Promise(function (resolve, reject) {
      if (!client || !client.connected) { reject(new Error('Not connected to the broker yet.')); return; }
      var topic = topicOf(id, kind);
      var wire = keyBytes ? DHC.encrypt(keyBytes, topic, payload) : Promise.resolve(payload);
      wire.then(function (bytes) {
        client.publish(topic, bytes, { qos: 1, retain: true }, function (e) { e ? reject(e) : resolve(); });
      }, reject);
    });
  }

  // ── Clock cards ────────────────────────────────────────────────────────
  var MODE_LABEL = { TIME: 'showing the time', GIF: 'showing a GIF', MESSAGE: 'showing a message', SPOTIFY: 'showing Spotify', CLAUDE: 'showing Claude' };

  function describe(d) {
    if (!d) return 'waiting for it…';
    if (d.unreadable && !d.online) return 'can’t read it';
    return d.online ? (MODE_LABEL[d.mode] || d.mode || 'online') : 'offline — will get it when it wakes';
  }
  function renderClocks() {
    var ok = !!cfg;
    show('mineCard', ok); show('theirCard', ok); show('compose', ok);
    if (!ok) return;
    var m = devices[cfg.mine], t = devices[cfg.theirs];
    $('mineName').textContent = labelOf('mine'); $('theirName').textContent = labelOf('theirs'); $('toName').textContent = labelOf('theirs');
    $('mineSub').textContent = describe(m); $('theirSub').textContent = describe(t);
    $('mineDot').className = 'dot' + (m && m.online ? ' on' : ''); $('theirDot').className = 'dot' + (t && t.online ? ' on' : '');
    show('mineKey', !!(keyBytes && m && m.unreadable)); show('theirKey', !!(keyBytes && t && t.unreadable));
    var onMsg = !!(m && m.online && m.mode === 'MESSAGE');
    $('mineCard').classList.toggle('msg', onMsg);
    $('mineClock').textContent = onMsg ? 'Dismiss → Clock' : 'Show clock';
    $('mineGif').textContent = onMsg ? 'Dismiss → Last GIF' : 'Show last GIF';
  }

  // ── Tabs ───────────────────────────────────────────────────────────────
  function showTab(name) {
    ['msg', 'gif', 'time'].forEach(function (t) {
      var cap = t.charAt(0).toUpperCase() + t.slice(1);
      $('pane' + cap).classList.toggle('hidden', t !== name);
      $('tab' + cap).setAttribute('aria-selected', String(t === name));
    });
    hideSendStat();
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
    b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
  });

  // ── Send status ────────────────────────────────────────────────────────
  function hideSendStat() { $('sendstat').classList.add('hidden'); }
  function setSendStat(el, text, cls, busy) {
    el.className = 'sendstat ' + (cls || ''); el.textContent = '';
    var t = document.createElement('div'); t.textContent = text; el.appendChild(t);
    if (busy) { var b = document.createElement('div'); b.className = 'bar'; b.appendChild(document.createElement('i')); el.appendChild(b); }
  }

  function isDelivered(p) {
    var d = devices[p.device];
    if (!d || !d.online) return false;
    if (p.kind === 'msg') return d.msg_ts === p.ts;
    if (p.kind === 'gif') return d.gif_ts === p.ts;
    if (p.kind === 'mode') return typeof d.cmd_ts === 'number' ? d.cmd_ts >= p.ts : d.mode === p.mode;
    return false;
  }
  function checkDelivered() {
    if (!pending || pending.state !== 'sent') return;
    if (isDelivered(pending)) {
      pending.state = 'delivered';
      setSendStat(pending.el, 'Delivered ✓  —  ' + labelFor(pending.device) + ' has it.', 'ok');
    }
  }
  function offlineNote(id) {
    var d = devices[id];
    return (!d || !d.online) ? ' ' + labelFor(id) + ' looks offline — it will arrive when it reconnects.' : '';
  }

  // Common send wrapper.
  function doSend(id, kind, payload, ts, extra, label, el) {
    pending = { device: id, kind: kind, ts: ts, mode: extra && extra.mode, state: 'sending', el: el };
    var p = pending, kb = payload.length;
    setSendStat(el, 'Sending ' + label + (kb > 2048 ? ' (' + Math.round(kb / 1024) + ' KB)' : '') + '…', '', true);
    return publish(id, kind, payload).then(function () {
      if (pending !== p) return;
      p.state = 'sent';
      if (isDelivered(p)) { p.state = 'delivered'; setSendStat(el, 'Delivered ✓  —  ' + labelFor(id) + ' has it.', 'ok'); }
      else setSendStat(el, 'Sent ✓.' + (offlineNote(id) || ' Waiting for ' + labelFor(id) + ' to confirm…'), 'ok', !offlineNote(id));
    }).catch(function (e) {
      if (pending === p) { p.state = 'failed'; setSendStat(el, 'Couldn’t send: ' + (e && e.message || e), 'bad'); }
    });
  }

  // ── My clock buttons ───────────────────────────────────────────────────
  function mineMode(mode, label) {
    if (!cfg) return;
    var ts = nextTs(cfg.mine);
    show('mineStat', true);
    doSend(cfg.mine, 'mode', OLED.modePayload(ts, mode), ts, { mode: mode }, label, $('mineStat'));
  }
  $('mineClock').addEventListener('click', function () { mineMode('TIME', 'the clock'); });
  $('mineGif').addEventListener('click', function () { mineMode('GIF', 'the last GIF'); });

  // ── Message tab ────────────────────────────────────────────────────────
  var NON_LATIN = /[^\u0000-\u00ff\u2018-\u201f\u2012-\u2014\u2026\u2212\u2028\u2029]/u;

  function wrapText(text, maxW, maxLines, measure) {
    var lines = [], start = 0, n = text.length;
    while (start < n && lines.length < maxLines) {
      var end = start, lastSpace = -1;
      while (end < n) {
        if (measure(text.substring(start, end + 1)) > maxW) break;
        if (text[end] === ' ') lastSpace = end;
        end++;
      }
      if (end >= n) { lines.push(text.substring(start, n)); start = n; }
      else if (lastSpace >= start) { lines.push(text.substring(start, lastSpace)); start = lastSpace + 1; }
      else { lines.push(text.substring(start, end)); start = end; }
    }
    if (start < n && lines.length) {
      var last = lines[lines.length - 1];
      while (last.length && measure(last + '...') > maxW) last = last.slice(0, -1);
      lines[lines.length - 1] = last + '...';
      return { lines: lines, fit: false };
    }
    return { lines: lines, fit: true };
  }

  var msgOff = document.createElement('canvas'); msgOff.width = OLED.W; msgOff.height = OLED.H;
  function renderMessagePreview(text) {
    var ctx = msgOff.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, OLED.W, OLED.H); ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    var smallW = function (s) { return s.length * 6; };
    function drawSmall(s, x, y) { ctx.font = '8px "Courier New", monospace'; for (var i = 0; i < s.length; i++) ctx.fillText(s[i], x + i * 6, y + 7); }
    var BIG = 'bold 12px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.font = BIG; var bigW = function (s) { ctx.font = BIG; return ctx.measureText(s).width; };
    var top = 7, maxW = OLED.W - 4;
    var avail = OLED.H - top;
    var big = text ? wrapText(text, maxW, Math.floor(avail / 16), bigW) : { lines: [], fit: true };
    if (big.fit) {
      ctx.font = BIG; ctx.textAlign = 'left';
      var y0 = top + Math.floor((avail - big.lines.length * 16) / 2);
      big.lines.forEach(function (l, i) { ctx.fillText(l, Math.round((OLED.W - bigW(l)) / 2), y0 + 13 + i * 16); });
    } else {
      var small = wrapText(text, maxW, Math.min(7, Math.floor(avail / 9)), smallW);
      var y1 = top + Math.floor((avail - small.lines.length * 9) / 2);
      small.lines.forEach(function (l, i) { drawSmall(l, Math.round((OLED.W - smallW(l)) / 2), y1 + i * 9); });
    }
    var data = ctx.getImageData(0, 0, OLED.W, OLED.H).data, px = new Uint8Array(OLED.W * OLED.H);
    for (var i = 0; i < px.length; i++) px[i] = data[i * 4] > 110 ? 1 : 0;
    drawPixels($('msgCanvas'), px);
  }

  function updateMessage() {
    var raw = $('msgText').value, clean = OLED.sanitizeText(raw);
    var counted = OLED.sanitizeText(raw, 100000).length;
    var c = $('msgCount'); c.textContent = counted + ' / ' + OLED.MSG_MAX_CHARS; c.classList.toggle('over', counted > OLED.MSG_MAX_CHARS);
    var h = $('msgHint');
    if (counted > OLED.MSG_MAX_CHARS) { h.textContent = 'Too long — the end will be cut off.'; h.className = 'hint bad'; }
    else if (NON_LATIN.test(raw)) { h.textContent = 'Emoji and some symbols can’t be shown — they’ll be left out.'; h.className = 'hint warn'; }
    else { h.innerHTML = '&nbsp;'; h.className = 'hint'; }
    renderMessagePreview(clean);
    $('msgSend').disabled = clean.length === 0;
  }
  $('msgText').addEventListener('input', updateMessage);
  $('msgSend').addEventListener('click', function () {
    if (!cfg) return;
    var ts = nextTs(cfg.theirs), text = $('msgText').value;
    $('msgSend').disabled = true;
    doSend(cfg.theirs, 'msg', OLED.msgPayload(ts, '', text), ts, null, 'your message', $('sendstat')).then(function () { updateMessage(); });
  });

  // ── Time tab ───────────────────────────────────────────────────────────
  $('timeSend').addEventListener('click', function () {
    if (!cfg) return;
    var ts = nextTs(cfg.theirs);
    doSend(cfg.theirs, 'mode', OLED.modePayload(ts, 'TIME'), ts, { mode: 'TIME' }, 'the time', $('sendstat'));
  });

  // ── GIF tab ────────────────────────────────────────────────────────────
  // Decode into full-size composited RGBA frames honouring disposal.
  function decodeGif(buf) {
    return new Promise(function (resolve) {
      var g = window.gifuct;
      if (!g) throw new Error('Couldn’t load the GIF decoder.');
      var gif = g.parseGIF(buf), frames = g.decompressFrames(gif, true);
      var w = gif.lsd.width, h = gif.lsd.height;
      if (!frames.length) throw new Error('That GIF has no frames.');
      if (w * h * frames.length * 4 > 600e6) throw new Error('That GIF is too big to process on this device. Try a smaller one.');
      var canvas = new Uint8ClampedArray(w * h * 4), snapshot = null;
      var prevDisp = 0, prevDims = null, out = [], delays = [];
      frames.forEach(function (f) {
        if (prevDisp === 3 && snapshot) canvas.set(snapshot);
        else if (prevDisp === 2 && prevDims) {
          for (var yy = 0; yy < prevDims.height; yy++) {
            var rs = ((prevDims.top + yy) * w + prevDims.left) * 4;
            if (rs >= 0) canvas.fill(0, rs, Math.min(canvas.length, rs + prevDims.width * 4));
          }
        }
        snapshot = f.disposalType === 3 ? canvas.slice() : null;
        var dm = f.dims, p = f.patch;
        for (var y = 0; y < dm.height; y++) {
          var gy = dm.top + y; if (gy >= h) break;
          for (var x = 0; x < dm.width; x++) {
            var gx = dm.left + x; if (gx >= w) break;
            var s = (y * dm.width + x) * 4;
            if (p[s + 3] === 0) continue;
            var o = (gy * w + gx) * 4;
            canvas[o] = p[s]; canvas[o + 1] = p[s + 1]; canvas[o + 2] = p[s + 2]; canvas[o + 3] = 255;
          }
        }
        out.push({ width: w, height: h, data: canvas.slice() });
        delays.push(f.delay);
        prevDisp = f.disposalType; prevDims = dm;
      });
      resolve({ frames: out, delays: delays });
    });
  }

  function decodeStill(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, max = 1024, s = Math.min(1, max / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
        var c = document.createElement('canvas'); c.width = cw; c.height = ch;
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, cw, ch);
        var d = ctx.getImageData(0, 0, cw, ch);
        URL.revokeObjectURL(url);
        resolve({ frames: [{ width: cw, height: ch, data: d.data }], delays: [1000] });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Couldn’t read that image.')); };
      img.src = url;
    });
  }

  var gifSrc = null;     // {frames, delays}
  var gifOut = null;     // {frames, fps, rlex}
  var animTimer = null;

  function stopAnim() { if (animTimer) { clearInterval(animTimer); animTimer = null; } }

  function fillPresets() {
    var sel = $('gifPreset'), labels = { lineart: 'Line art', photo: 'Photo (dithered)', threshold: 'Simple black & white' };
    var keys = Object.keys(OLED.presets).sort(function (a, b) {
      var order = ['lineart', 'photo', 'threshold'], ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib);
    });
    sel.textContent = '';
    keys.forEach(function (k) {
      var o = document.createElement('option'); o.value = k; o.textContent = labels[k] || k; sel.appendChild(o);
    });
    sel.value = 'lineart';
    $('thrBox').classList.toggle('hidden', sel.value !== 'threshold');
  }

  var convTimer = null;
  function scheduleConvert() { clearTimeout(convTimer); convTimer = setTimeout(reconvert, 120); }

  function reconvert() {
    if (!gifSrc) return;
    var preset = $('gifPreset').value;
    var auto = $('gifAuto').checked;
    $('gifThr').disabled = auto;
    var opts = { preset: preset, invert: $('gifInvert').checked };
    if (preset === 'threshold') opts.threshold = auto ? 'auto' : +$('gifThr').value;
    if ($('gifFps').value) opts.fps = +$('gifFps').value;
    var r;
    try { r = OLED.convertFrames(gifSrc.frames, gifSrc.delays, opts); }
    catch (e) { $('gifInfo').textContent = 'Conversion failed: ' + e.message; $('gifSend').disabled = true; return; }
    if (auto && r.threshold !== undefined) $('gifThrVal').textContent = r.threshold + ' (auto)'; else $('gifThrVal').textContent = $('gifThr').value;
    var rlex = OLED.encodeClip(r.frames);
    gifOut = { frames: r.frames, fps: r.fps, rlex: rlex };
    var pktBytes = 15 + rlex.length + (keyBytes ? DHC.HEADER + DHC.TAG : 0);   // DHG1 header (no sender) + envelope
    gifOut.pktBytes = pktBytes;
    $('gifInfo').textContent = r.frames.length + ' frames · ' + r.fps + ' fps';
    $('gifSize').textContent = (pktBytes / 1024).toFixed(1) + ' KB';
    var warn = $('gifWarn'), tooBig = pktBytes > OLED.GIF_MAX_BYTES;
    warn.className = 'hint' + (tooBig ? ' bad' : pktBytes > 300 * 1024 ? ' warn' : '');
    warn.textContent = tooBig ? 'Too big for the display (max 900 KB). Try a shorter GIF or a lower speed.' :
      pktBytes > 300 * 1024 ? 'That’s a big one — it may take a moment to arrive.' : '';
    $('gifSend').disabled = tooBig;
    stopAnim();
    var idx = 0, cv = $('gifCanvas'), fr = r.frames;
    var unpacked = fr.map(function (f, i) { return i > 0 && f === fr[i - 1] ? null : OLED.unpackFrame(f); });
    function tick() {
      var u = unpacked[idx]; if (u) drawPixels(cv, u);
      idx = (idx + 1) % fr.length;
    }
    tick();
    if (fr.length > 1) animTimer = setInterval(tick, 1000 / r.fps);
  }

  $('gifFile').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';   // allow picking the same file again
    if (!f) return;
    $('gifWork').classList.remove('hidden');
    $('gifInfo').textContent = 'Reading…'; $('gifSend').disabled = true; gifSrc = null; stopAnim();
    var isGif = f.type === 'image/gif' || /\.gif$/i.test(f.name);
    var work = isGif ? f.arrayBuffer().then(decodeGif) : decodeStill(f);
    work.then(function (src) { gifSrc = src; reconvert(); })
        .catch(function (e) { $('gifInfo').textContent = e.message || String(e); });
  });
  ['gifPreset', 'gifInvert', 'gifAuto', 'gifFps'].forEach(function (id) { $(id).addEventListener('change', scheduleConvert); });
  $('gifThr').addEventListener('input', function () { $('gifThrVal').textContent = this.value; scheduleConvert(); });
  $('gifPreset').addEventListener('change', function () { $('thrBox').classList.toggle('hidden', this.value !== 'threshold'); });

  $('gifSend').addEventListener('click', function () {
    if (!gifOut || !cfg) return;
    var ts = nextTs(cfg.theirs), pkt = OLED.packDHG1(ts, gifOut.fps, '', gifOut.rlex);
    if (pkt.length + (keyBytes ? DHC.HEADER + DHC.TAG : 0) > OLED.GIF_MAX_BYTES) { setSendStat($('sendstat'), 'Too big for the display (max 900 KB).', 'bad'); return; }
    doSend(cfg.theirs, 'gif', pkt, ts, null, 'your GIF', $('sendstat'));
  });

  // ── Boot ───────────────────────────────────────────────────────────────
  fillPresets();
  updateMessage();
  renderClocks();
  if (!cfg) showSettings(true);
  connect();
  window.addEventListener('pagehide', function () { try { client && client.end(true); } catch (e) {} });
})();
