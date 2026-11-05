/**
 * Renders assets/icon-180.png without any image dependency.
 *
 * The market listing only accepts raster icons, and this machine has no sharp,
 * resvg, ImageMagick or Inkscape. So the SVG is re-drawn here on a 4x supersampled
 * grid and written as a plain RGBA PNG (zlib + hand rolled chunks).
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'assets', 'icon-180.png')

const SIZE = 180
const SS = 4
const W = SIZE * SS
const VIEW = 64 // the SVG viewBox
const K = W / VIEW

const BG = [0x2f, 0x6f, 0xeb, 0xff]
const FG = [0xff, 0xff, 0xff, 0xff]

function insideRoundedRect(x, y, rx, ry, rw, rh, r) {
  if (x < rx || y < ry || x > rx + rw || y > ry + rh) return false
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r)
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

/** Distance from a point to a segment, used to stroke a line with round caps. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  const t = len === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len))
  const x = ax + t * dx
  const y = ay + t * dy
  return Math.hypot(px - x, py - y)
}

// Every white stroke of icon.svg, as a segment plus half of its stroke width.
const STROKES = [
  [20, 22, 44, 22, 3.2 / 2],
  [26, 18, 38, 18, 3.2 / 2],
  [24, 22, 25.6, 46.8, 3.2 / 2],
  [40, 22, 38.4, 46.8, 3.2 / 2],
  [25.6, 46.8, 38.4, 46.8, 3.2 / 2],
  [29, 28, 29, 40, 2.6 / 2],
  [35, 28, 35, 40, 2.6 / 2],
]

const hires = new Uint8Array(W * W * 4)

for (let py = 0; py < W; py += 1) {
  for (let px = 0; px < W; px += 1) {
    const x = (px + 0.5) / K
    const y = (py + 0.5) / K
    const i = (py * W + px) * 4
    if (!insideRoundedRect(x, y, 4, 4, 56, 56, 14)) continue
    let white = false
    for (const [ax, ay, bx, by, half] of STROKES) {
      if (segmentDistance(x, y, ax, ay, bx, by) <= half) {
        white = true
        break
      }
    }
    const color = white ? FG : BG
    hires[i] = color[0]
    hires[i + 1] = color[1]
    hires[i + 2] = color[2]
    hires[i + 3] = color[3]
  }
}

// Box filter down to the final size, averaging in premultiplied space.
const out = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const i = ((y * SS + sy) * W + (x * SS + sx)) * 4
        const alpha = hires[i + 3] / 255
        r += hires[i] * alpha
        g += hires[i + 1] * alpha
        b += hires[i + 2] * alpha
        a += alpha
      }
    }
    const n = SS * SS
    const o = (y * SIZE + x) * 4
    if (a === 0) continue
    out[o] = Math.round(r / a)
    out[o + 1] = Math.round(g / a)
    out[o + 2] = Math.round(b / a)
    out[o + 3] = Math.round((a / n) * 255)
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // colour type: RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, png)
console.log(`wrote ${OUT} (${png.length} bytes, ${SIZE}x${SIZE})`)
