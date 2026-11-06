/* oled.js — RLEX encoder, DHG1 packer, 1-bit converter and text sanitiser for
 * the SmartClock remote link. Classic script (no modules) so it works from
 * file:// and can also be require()d from Node for tests.
 *
 * Wire formats are defined by tools/rle_codec.py and src/main.cpp section
 * "10b. REMOTE LINK"; keep this file byte-compatible with both.
 */
(function (root) {
  'use strict';

  var W = 128, H = 64;
  var FRAME_BYTES = (W * H) / 8;        // 1024
  var KEYFRAME_INTERVAL = 20;
  var MSG_MAX_CHARS = 200;
  var FROM_MAX_CHARS = 24;
  var GIF_MAX_BYTES = 900 * 1024;        // firmware REMOTE_GIF_MAX_BYTES

  var OLED = { W: W, H: H, FRAME_BYTES: FRAME_BYTES, KEYFRAME_INTERVAL: KEYFRAME_INTERVAL,
               MSG_MAX_CHARS: MSG_MAX_CHARS, FROM_MAX_CHARS: FROM_MAX_CHARS,
               GIF_MAX_BYTES: GIF_MAX_BYTES };

  // ── PackBits (port of tools/rle_codec.py packbits_encode) ────────────────
  function packbitsEncode(data) {
    var out = [];
    var i = 0, n = data.length;
    while (i < n) {
      var run = 1;
      while (i + run < n && data[i + run] === data[i] && run < 128) run++;
      if (run >= 3) {
        out.push((257 - run) & 0xFF);
        out.push(data[i]);
        i += run;
        continue;
      }
      var litStart = i;
      while (i < n) {
        run = 1;
        while (i + run < n && data[i + run] === data[i] && run < 3) run++;
        if (run >= 3) break;
        i++;
        if (i - litStart >= 128) break;
      }
      out.push(i - litStart - 1);
      for (var k = litStart; k < i; k++) out.push(data[k]);
    }
    return Uint8Array.from(out);
  }

  // ── RLEX clip (port of encode_clip) ──────────────────────────────────────
  function encodeClip(frames, keyframeInterval) {
    if (keyframeInterval === undefined) keyframeInterval = KEYFRAME_INTERVAL;
    if (!frames || !frames.length) throw new Error('encodeClip: frames list is empty');
    if (frames.length > 0xFFFF) throw new Error('encodeClip: too many frames (' + frames.length + ')');
    if (!(keyframeInterval >= 1 && keyframeInterval <= 255)) throw new Error('encodeClip: keyframe interval out of range');
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].length !== FRAME_BYTES) throw new Error('encodeClip: frame ' + i + ' has ' + frames[i].length + ' bytes, expected ' + FRAME_BYTES);
    }
    var payloads = [], offsets = [], dataOffset = 0;
    var prev = new Uint8Array(FRAME_BYTES);
    for (var f = 0; f < frames.length; f++) {
      var frame = frames[f], ftype, packed;
      if (f % keyframeInterval === 0) {
        ftype = 0;
        packed = packbitsEncode(frame);
      } else {
        ftype = 1;
        var x = new Uint8Array(FRAME_BYTES);
        for (var b = 0; b < FRAME_BYTES; b++) x[b] = frame[b] ^ prev[b];
        packed = packbitsEncode(x);
      }
      if (packed.length > 0xFFFF) throw new Error('encodeClip: frame ' + f + ' packed too large');
      var blob = new Uint8Array(3 + packed.length);
      blob[0] = ftype; blob[1] = packed.length & 0xFF; blob[2] = (packed.length >> 8) & 0xFF;
      blob.set(packed, 3);
      offsets.push(dataOffset);
      dataOffset += blob.length;
      payloads.push(blob);
      prev = frame;
    }
    var total = 8 + 4 * frames.length + dataOffset;
    var out = new Uint8Array(total);
    out[0] = 0x52; out[1] = 0x4C; out[2] = 0x45; out[3] = 0x58;   // "RLEX"
    out[4] = 1; out[5] = keyframeInterval;
    out[6] = frames.length & 0xFF; out[7] = (frames.length >> 8) & 0xFF;
    var p = 8;
    for (var o = 0; o < offsets.length; o++) {
      out[p++] = offsets[o] & 0xFF; out[p++] = (offsets[o] >>> 8) & 0xFF;
      out[p++] = (offsets[o] >>> 16) & 0xFF; out[p++] = (offsets[o] >>> 24) & 0xFF;
    }
    for (var q = 0; q < payloads.length; q++) { out.set(payloads[q], p); p += payloads[q].length; }
    return out;
  }

  // ── Text ────────────────────────────────────────────────────────────────
  var TYPO = { 0x2018: "'", 0x2019: "'", 0x201A: "'", 0x201B: "'",
               0x201C: '"', 0x201D: '"', 0x201E: '"', 0x201F: '"',
               0x2013: '-', 0x2014: '-', 0x2012: '-', 0x2212: '-',
               0x2026: '...' };

  // Mirrors sanitizeText() in main.cpp (typographic -> ASCII, Latin-1 kept)
  // but drops what the device would show as '?' (emoji, other scripts).
  // Newlines/tabs become spaces; other control chars are dropped.
  function sanitizeText(input, maxChars) {
    var s = String(input === undefined || input === null ? '' : input);
    var out = '';
    for (var i = 0; i < s.length; ) {
      var cp = s.codePointAt(i);
      i += cp > 0xFFFF ? 2 : 1;
      if (cp === 0x0A || cp === 0x0D || cp === 0x09 || cp === 0x2028 || cp === 0x2029 || cp === 0x85) out += ' ';
      else if (cp === 0xA0) out += ' ';
      else if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) continue;
      else if (cp < 0x100) out += String.fromCharCode(cp);
      else if (TYPO[cp] !== undefined) out += TYPO[cp];
      // else: emoji / non-Latin-1 -> dropped
    }
    out = out.replace(/ {2,}/g, ' ').replace(/^ +| +$/g, '');
    var max = maxChars === undefined ? MSG_MAX_CHARS : maxChars;
    if (out.length > max) out = out.substring(0, max).replace(/ +$/, '');
    return out;
  }

  function cleanFrom(name) { return sanitizeText(name, FROM_MAX_CHARS); }

  // ── Payload builders ────────────────────────────────────────────────────
  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var b = unescape(encodeURIComponent(str)), a = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a;
  }

  function msgPayload(ts, from, text) {
    return JSON.stringify({ ts: ts, from: cleanFrom(from), text: sanitizeText(text) });
  }
  function modePayload(ts, mode) { return JSON.stringify({ ts: ts, mode: mode }); }

  // DHG1: "DHG1" | ts u64 LE | fps u16 LE | from_len u8 | from | RLEX
  function packDHG1(ts, fps, from, rlex) {
    var f = utf8(cleanFrom(from));
    if (f.length > 255) f = f.subarray(0, 255);   // cannot happen with <=24 chars; belt and braces
    var out = new Uint8Array(15 + f.length + rlex.length);
    out[0] = 0x44; out[1] = 0x48; out[2] = 0x47; out[3] = 0x31;   // "DHG1"
    var lo = ts % 4294967296, hi = Math.floor(ts / 4294967296);
    for (var i = 0; i < 4; i++) { out[4 + i] = (lo >>> (8 * i)) & 0xFF; out[8 + i] = (hi >>> (8 * i)) & 0xFF; }
    fps = Math.max(1, Math.min(0xFFFF, Math.round(fps)));
    out[12] = fps & 0xFF; out[13] = (fps >> 8) & 0xFF;
    out[14] = f.length;
    out.set(f, 15);
    out.set(rlex, 15 + f.length);
    return out;
  }

  // ── Frame packing ───────────────────────────────────────────────────────
  // pixels: Uint8Array(W*H), non-zero = lit. Row-major, MSB-first.
  function packPixels(pixels) {
    var out = new Uint8Array(FRAME_BYTES);
    for (var i = 0; i < W * H; i++) if (pixels[i]) out[i >> 3] |= 0x80 >> (i & 7);
    return out;
  }
  function unpackFrame(bytes) {
    var px = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) px[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
    return px;
  }

  // ── Converter ───────────────────────────────────────────────────────────
  // Port of tools/gif_to_oled.py (the reference; its docstring documents every
  // constant). Same arithmetic order in Float64 so the output is bit-identical.
  //
  // A "preset" is function(frames, opts) -> Array<Uint8Array(W*H)|null> (1 = lit),
  // one per source frame, where frames = [{width, height, data: RGBA}].
  // Whole-clip signature so a preset can do clip-wide analysis (background
  // detection). opts.needed (a Set of source indices, optional) lists the
  // frames that survive resampling; a preset may return null for the rest.
  // Register more via OLED.presets.name = fn.
  var presets = {};

  var BG_TOL = 40, BG_FLAT_FRAC = 0.85, ALPHA_MIN = 128;
  var STROKE_L = 120.0, STROKE_MIN = 0.2, ISOLATED_MIN = 2, FILL_MIN = 0.5;
  var DEFAULT_THRESHOLD = 164, MIN_DELAY_MS = 20, AUTO_FPS_MAX = 20, FPS_MIN = 1, FPS_MAX = 30;

  // Python's round(): half to even.
  function pyRound(x) {
    var f = Math.floor(x), d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }

  // _fit_size
  function fitSize(w, h) {
    var s = Math.min(W / w, H / h);
    return { tw: Math.min(W, Math.max(1, pyRound(w * s))), th: Math.min(H, Math.max(1, pyRound(h * s))) };
  }

  // Letterbox geometry: fit (w,h) inside 128x64 preserving aspect.
  function fitBox(w, h) {
    var z = fitSize(w, h);
    return { dw: z.tw, dh: z.th, ox: Math.floor((W - z.tw) / 2), oy: Math.floor((H - z.th) / 2) };
  }

  // Fractional-overlap weights of each output cell over the source axis.
  function axisWeights(nIn, nOut) {
    var ratio = nIn / nOut, cells = [];
    for (var i = 0; i < nOut; i++) {
      var lo = i * ratio, hi = (i + 1) * ratio;
      var j0 = Math.floor(lo), j1 = Math.min(nIn, Math.ceil(hi)), ws = [];
      for (var j = j0; j < j1; j++) ws.push(Math.max(0.0, Math.min(hi, j + 1) - Math.max(lo, j)));
      cells.push({ j0: j0, w: ws });
    }
    return { ratio: ratio, cells: cells };
  }

  // fit(): exact area average of a Float64Array(w*h) plane down to fit 128x64,
  // centred on zeros. Rows first, then columns. Returns Float64Array(W*H).
  function fitPlane(plane, w, h) {
    var z = fitSize(w, h), tw = z.tw, th = z.th;
    var ay = axisWeights(h, th), ax = axisWeights(w, tw);
    var tmp = new Float64Array(th * w), i, j, x, y, acc;
    for (i = 0; i < th; i++) {
      var cy = ay.cells[i], row = i * w;
      for (j = 0; j < cy.w.length; j++) {
        var wt = cy.w[j], src = (cy.j0 + j) * w;
        for (x = 0; x < w; x++) tmp[row + x] += wt * plane[src + x];
      }
      for (x = 0; x < w; x++) tmp[row + x] /= ay.ratio;
    }
    var out = new Float64Array(W * H);
    var x0 = Math.floor((W - tw) / 2), y0 = Math.floor((H - th) / 2);
    for (y = 0; y < th; y++) {
      for (i = 0; i < tw; i++) {
        var cx = ax.cells[i];
        acc = 0;
        for (j = 0; j < cx.w.length; j++) acc += cx.w[j] * tmp[y * w + cx.j0 + j];
        out[(y0 + y) * W + x0 + i] = acc / ax.ratio;
      }
    }
    return out;
  }

  function lumaPlane(d, n) {
    var L = new Float64Array(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) L[i] = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
    return L;
  }

  // Median of a numeric array (numpy semantics: mean of the middle two).
  function median(a) {
    var s = Float64Array.from(a).sort(), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  // Flat background colour [r,g,b] from the border ring of every frame, or null.
  function detectBackground(frames) {
    var R = [], G = [], B = [], opaque = 0, ringPx = 0;
    function take(d, o) {
      if (d[o + 3] >= ALPHA_MIN) { R.push(d[o]); G.push(d[o + 1]); B.push(d[o + 2]); opaque++; }
    }
    for (var f = 0; f < frames.length; f++) {
      var w = frames[f].width, h = frames[f].height, d = frames[f].data, x, y;
      for (x = 0; x < w; x++) take(d, x * 4);
      for (x = 0; x < w; x++) take(d, ((h - 1) * w + x) * 4);
      for (y = 1; y < h - 1; y++) take(d, (y * w) * 4);
      for (y = 1; y < h - 1; y++) take(d, (y * w + w - 1) * 4);
      ringPx += 2 * (h + w) - 4;
    }
    if (opaque / Math.max(1, ringPx) < 0.5) return null;     // transparent: alpha handles it
    if (!R.length) return null;
    var bg = [median(R), median(G), median(B)], near = 0;
    for (var i = 0; i < R.length; i++) {
      var dr = R[i] - bg[0], dg = G[i] - bg[1], db = B[i] - bg[2];
      if (dr * dr + dg * dg + db * db <= BG_TOL * BG_TOL) near++;
    }
    return near / R.length < BG_FLAT_FRAC ? null : bg;
  }

  // Subject mask as a Float64Array of 0/1 (alpha >= 128 and, with a flat
  // background, farther than BG_TOL from it).
  function subjectPlane(d, n, bg) {
    var sf = new Float64Array(n), tol2 = BG_TOL * BG_TOL;
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      if (d[p + 3] < ALPHA_MIN) continue;
      if (bg) {
        var dr = d[p] - bg[0], dg = d[p + 1] - bg[1], db = d[p + 2] - bg[2];
        if (!(dr * dr + dg * dg + db * db > tol2)) continue;
      }
      sf[i] = 1;
    }
    return sf;
  }

  // _drop_isolated: clear lit pixels with < ISOLATED_MIN lit 8-neighbours.
  function dropIsolated(bits) {
    var out = new Uint8Array(W * H);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        if (!bits[y * W + x]) continue;
        var n = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx; if ((!dy && !dx) || xx < 0 || xx >= W) continue;
            n += bits[yy * W + xx];
          }
        }
        if (n >= ISOLATED_MIN) out[y * W + x] = 1;
      }
    }
    return out;
  }

  // BAYER8[y][x] = 4 * BAYER4[y%4][x%4] + Q[(y/4)%2][(x/4)%2]
  var BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  var BAYER_Q = [[0, 2], [3, 1]];
  function bayer8(y, x) { return 4 * BAYER4[y % 4][x % 4] + BAYER_Q[(y >> 2) % 2][(x >> 2) % 2]; }

  function wanted(opts, i) { return !opts.needed || opts.needed.has(i); }

  presets.lineart = function (frames, opts) {
    var bg = detectBackground(frames), out = [];
    for (var f = 0; f < frames.length; f++) {
      if (!wanted(opts, f)) { out.push(null); continue; }
      var fr = frames[f], w = fr.width, h = fr.height, n = w * h, d = fr.data;
      var luma = lumaPlane(d, n), sf = subjectPlane(d, n, bg), dark = new Float64Array(n), i;
      for (i = 0; i < n; i++) if (sf[i] && luma[i] < STROKE_L) dark[i] = 1;
      var cov = fitPlane(sf, w, h), fd = fitPlane(dark, w, h), bits = new Uint8Array(W * H);
      for (i = 0; i < W * H; i++) {
        var stroke = fd[i] / Math.max(cov[i], 0.001) >= STROKE_MIN;
        if (cov[i] >= FILL_MIN && !stroke) bits[i] = 1;
      }
      out.push(dropIsolated(bits));
    }
    return out;
  };

  presets.photo = function (frames, opts) {
    var bg = detectBackground(frames), out = [];
    for (var f = 0; f < frames.length; f++) {
      if (!wanted(opts, f)) { out.push(null); continue; }
      var fr = frames[f], w = fr.width, h = fr.height, n = w * h, d = fr.data;
      var luma = lumaPlane(d, n), sf = subjectPlane(d, n, bg), i;
      for (i = 0; i < n; i++) luma[i] = luma[i] * sf[i];
      var tone = fitPlane(luma, w, h), bits = new Uint8Array(W * H);
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          if (tone[y * W + x] / 255.0 > (bayer8(y, x) + 0.5) / 64) bits[y * W + x] = 1;
        }
      }
      out.push(bits);
    }
    return out;
  };

  function otsu(hist, total) {
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = -1, thr = 128;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (wB === 0) continue;
      var wF = total - wB;
      if (wF === 0) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i + 1; }   // lit when lum >= i+1
    }
    return thr;
  }

  // lit = fit(L) >= threshold, no background removal. threshold 'auto' is a
  // web-only extra (Otsu over the fitted picture area); numbers match Python.
  presets.threshold = function (frames, opts) {
    var auto = opts.threshold === 'auto';
    var thr = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
    var fits = [], f, i;
    for (f = 0; f < frames.length; f++) {
      if (!wanted(opts, f)) { fits.push(null); continue; }
      var fr = frames[f];
      fits.push(fitPlane(lumaPlane(fr.data, fr.width * fr.height), fr.width, fr.height));
    }
    if (auto) {
      var hist = new Float64Array(256), total = 0;
      for (f = 0; f < fits.length; f++) {
        if (!fits[f]) continue;
        var b = fitBox(frames[f].width, frames[f].height);
        for (var y = 0; y < b.dh; y++) for (var x = 0; x < b.dw; x++) {
          hist[Math.min(255, Math.round(fits[f][(b.oy + y) * W + b.ox + x]))]++; total++;
        }
      }
      thr = otsu(hist, total);
    }
    opts.usedThreshold = thr;
    return fits.map(function (g) {
      if (!g) return null;
      var px = new Uint8Array(W * H);
      for (i = 0; i < W * H; i++) if (g[i] >= thr) px[i] = 1;
      return px;
    });
  };
  OLED.presets = presets;
  OLED.DEFAULT_THRESHOLD = DEFAULT_THRESHOLD;

  // Delay normalisation (Python: int(), < 20 ms -> 100 ms).
  function normDelay(d) { d = Math.trunc(+d); return (!isFinite(d) || d < MIN_DELAY_MS) ? 100 : d; }

  // Auto fps: round(1000 / mean delay), clamped 1..20.
  function autoFps(delays) {
    var ds = delays.map(normDelay), sum = 0;
    for (var i = 0; i < ds.length; i++) sum += ds[i];
    return Math.max(FPS_MIN, Math.min(AUTO_FPS_MAX, pyRound(1000.0 / (sum / ds.length))));
  }

  // Source-frame index for each output frame at a fixed fps (resample_indices).
  function resampleIndices(delays, fps) {
    var total = 0, ends = [], i;
    for (i = 0; i < delays.length; i++) { total += delays[i]; ends.push(total); }
    var n = Math.max(1, pyRound(total * fps / 1000.0)), out = [];
    i = 0;
    for (var k = 0; k < n; k++) {
      var t = k * 1000.0 / fps;
      while (i < ends.length - 1 && t >= ends[i]) i++;
      out.push(i);
    }
    return out;
  }

  /**
   * rgbaFrames: [{width, height, data: Uint8ClampedArray|Uint8Array RGBA}]
   *   (already composited, full-size). delaysMs: per-frame delay (ms).
   * options: {preset:'lineart'|'photo'|'threshold', threshold:0..255|'auto'
   *           (threshold preset), invert:false, fps: 1..30 (default auto,
   *           capped at 20), maxFrames: 65535}
   * returns {frames: [Uint8Array(1024)], fps, threshold}
   */
  function convertFrames(rgbaFrames, delaysMs, options) {
    var opts = {};
    for (var key in (options || {})) opts[key] = options[key];
    if (!rgbaFrames || !rgbaFrames.length) throw new Error('convertFrames: no frames');
    var preset = opts.preset || 'lineart';
    var fn = typeof preset === 'function' ? preset : presets[preset];
    if (!fn) throw new Error('convertFrames: unknown preset ' + preset);
    var delays = [];
    for (var i = 0; i < rgbaFrames.length; i++) delays.push(normDelay(delaysMs && delaysMs[i] !== undefined ? delaysMs[i] : 100));

    var fps = opts.fps ? Math.max(FPS_MIN, Math.min(FPS_MAX, Math.round(opts.fps))) : autoFps(delays);
    var order = resampleIndices(delays, fps);
    var maxFrames = Math.min(opts.maxFrames || 0xFFFF, 0xFFFF);
    if (order.length > maxFrames) order.length = maxFrames;
    opts.needed = new Set(order);
    var pixelMaps = fn(rgbaFrames, opts), packed = {};
    order.forEach(function (idx) {
      if (packed[idx]) return;
      var px = pixelMaps[idx];
      if (opts.invert) { px = px.slice(); for (var q = 0; q < px.length; q++) px[q] ^= 1; }
      packed[idx] = packPixels(px);
    });
    var frames = order.map(function (idx) { return packed[idx]; });
    return { frames: frames, fps: fps, threshold: opts.usedThreshold };
  }

  OLED.packbitsEncode = packbitsEncode;
  OLED.encodeClip = encodeClip;
  OLED.sanitizeText = sanitizeText;
  OLED.cleanFrom = cleanFrom;
  OLED.msgPayload = msgPayload;
  OLED.modePayload = modePayload;
  OLED.packDHG1 = packDHG1;
  OLED.packPixels = packPixels;
  OLED.unpackFrame = unpackFrame;
  OLED.convertFrames = convertFrames;
  OLED.fitBox = fitBox;
  OLED.normDelay = normDelay;
  OLED.autoFps = autoFps;
  OLED.resampleIndices = resampleIndices;
  OLED.pyRound = pyRound;

  root.OLED = OLED;
  if (typeof module !== 'undefined' && module.exports) module.exports = OLED;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

if (typeof module !== 'undefined') module.exports = OLED;
