// Generates the PWA icon set as real PNGs with no new dependencies.
//
// The brand mark is the same two-diamond infinity logo as public/favicon.svg:
// a white diamond on brand green with the orange diamond behind it. A PNG is
// produced rather than reusing the SVG because Chrome's install prompt and the
// Android maskable-icon spec are both happiest with real raster icons.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y)
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const GREEN = [0x00, 0x99, 0x44]
const ORANGE = [0xff, 0x8c, 0x00]
const WHITE = [0xff, 0xff, 0xff]

/** Anti-aliased diamond (an L1 ball) centred on the canvas. */
function diamondCoverage(x, y, size, cx, cy, r) {
  const d = Math.abs(x - cx) + Math.abs(y - cy)
  return Math.max(0, Math.min(1, r - d + 0.5))
}

function makeIcon(size, pad) {
  const cx = size / 2
  const cy = size / 2
  const r = (size / 2) * (1 - pad)
  return png(size, (x, y) => {
    // Brand-green field, full bleed so a maskable crop never shows white.
    let col = GREEN
    const w = diamondCoverage(x, y, size, cx - r * 0.04, cy - r * 0.04, r)
    if (w > 0) col = mix(col, WHITE, w)
    const o = diamondCoverage(x, y, size, cx - r * 0.07, cy - r * 0.07, r * 0.82)
    if (o > 0) col = mix(col, ORANGE, o)
    return [col[0], col[1], col[2], 255]
  })
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

const out = path.join(__dirname, '..', 'public')
const targets = [
  ['pwa-192.png', 192, 0.18],
  ['pwa-512.png', 512, 0.18],
  // Maskable icons get cropped to a circle by the launcher, so the mark keeps a
  // generous safe zone.
  ['pwa-maskable-512.png', 512, 0.30],
  ['pwa-apple-touch-icon.png', 180, 0.10],
]
for (const [name, size, pad] of targets) {
  const buf = makeIcon(size, pad)
  fs.writeFileSync(path.join(out, name), buf)
  console.log('wrote', name, size + 'x' + size, buf.length + ' bytes')
}
