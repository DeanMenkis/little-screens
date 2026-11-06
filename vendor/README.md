# Vendored JavaScript

The page loads nothing from the network except the MQTT broker (see the CSP in `../index.html`).
These files are copied here, unmodified unless noted, and pinned.

## mqtt.min.js
- Package: MQTT.js 5.10.1, licence MIT
- Source: https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js (browser bundle)
- SRI sha384 (matches the hash the page used to carry): `sha384-u4uqeACkFcoKl57rBQJHVGDd1pqhW4w8X3WjTu1ZksPdxoLqdt34jpoNkJisE25W`
- sha256: `b088a7f9045df4e478dbc378f41125066e43d9c602755ee4c5cda0f3e9380ba0`

## gifuct.js
- Packages: gifuct-js 2.1.2 and js-binary-schema-parser 2.0.3, licence MIT (c) 2015 Matt Way
- gifuct-js ships no browser/UMD build, and ES-module imports do not work from `file://`
  in Chrome. So this is the two packages' published CommonJS `lib/` files, concatenated
  verbatim into one classic script behind a tiny `require()` shim; it exposes
  `window.gifuct = {parseGIF, decompressFrames, decompressFrame}`.
- Sources (jsDelivr, sha256 of each original file):
  - https://cdn.jsdelivr.net/npm/gifuct-js@2.1.2/lib/index.js  `e4a0a9bf20efbd4db6fc4f9a0fac6e8343158b472f471ceec3323015692ca0e1`
  - https://cdn.jsdelivr.net/npm/gifuct-js@2.1.2/lib/lzw.js  `df5a3ad30d9ba0438fe22fd3c80eedae6775d5b15a249ced330356ba607831fb`
  - https://cdn.jsdelivr.net/npm/gifuct-js@2.1.2/lib/deinterlace.js  `3b9a9d81dd52c8fa260ee330f44f888fbcee3520c90464b2a61e6a542432f5fa`
  - https://cdn.jsdelivr.net/npm/js-binary-schema-parser@2.0.3/lib/index.js  `5cc8f4b86b3a924429ae3d7f5e3c4683d6cb053a7df017663da5b6c11fa074fd`
  - https://cdn.jsdelivr.net/npm/js-binary-schema-parser@2.0.3/lib/parsers/uint8.js  `014a9c69ec38ea99dedaf06682eda0cbc48c3859596e01e3f43e5a56e2f9c31b`
  - https://cdn.jsdelivr.net/npm/js-binary-schema-parser@2.0.3/lib/schemas/gif.js  `4994eb33b75fea96427ce492627c2314b82f9a57e0ebabd2ed1e331aa8d52c30`
- sha256 of the bundled `gifuct.js`: `30be6c794064abf221624bcebd64a38783a376d7c5c1a619317845b2928f732e`
