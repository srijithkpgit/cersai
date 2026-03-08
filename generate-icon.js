const fs = require('fs');
const zlib = require('zlib');

const SIZE = 128;
const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const srcA = a / 255;
  const dstA = pixels[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA > 0) {
    pixels[i]     = Math.round((r * srcA + pixels[i]     * dstA * (1 - srcA)) / outA);
    pixels[i + 1] = Math.round((g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
    pixels[i + 2] = Math.round((b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
    pixels[i + 3] = Math.round(outA * 255);
  }
}

function fillCircle(cx, cy, radius, r, g, b, a = 255) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y++) {
    for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) {
        // Anti-alias the edge
        const edge = Math.sqrt(d2) - radius + 1;
        const aa = edge > 0 ? Math.max(0, 1 - edge) : 1;
        setPixel(x, y, r, g, b, Math.round(a * aa));
      }
    }
  }
}

function fillRoundedRect(x1, y1, x2, y2, radius, r, g, b, a = 255) {
  for (let y = Math.floor(y1); y < Math.ceil(y2); y++) {
    for (let x = Math.floor(x1); x < Math.ceil(x2); x++) {
      let inside = true;
      // Check corners
      const corners = [
        [x1 + radius, y1 + radius],
        [x2 - radius, y1 + radius],
        [x1 + radius, y2 - radius],
        [x2 - radius, y2 - radius],
      ];
      if (x < x1 + radius && y < y1 + radius) {
        const dx = x - corners[0][0], dy = y - corners[0][1];
        inside = dx * dx + dy * dy <= radius * radius;
      } else if (x >= x2 - radius && y < y1 + radius) {
        const dx = x - corners[1][0], dy = y - corners[1][1];
        inside = dx * dx + dy * dy <= radius * radius;
      } else if (x < x1 + radius && y >= y2 - radius) {
        const dx = x - corners[2][0], dy = y - corners[2][1];
        inside = dx * dx + dy * dy <= radius * radius;
      } else if (x >= x2 - radius && y >= y2 - radius) {
        const dx = x - corners[3][0], dy = y - corners[3][1];
        inside = dx * dx + dy * dy <= radius * radius;
      }
      if (inside) setPixel(x, y, r, g, b, a);
    }
  }
}

function drawThickLine(x1, y1, x2, y2, thickness, r, g, b, a = 255) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.ceil(len * 3);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = x1 + dx * t;
    const cy = y1 + dy * t;
    fillCircle(cx, cy, thickness / 2, r, g, b, a);
  }
}

// Shield as scanline fill
function isInsideShield(x, y, cx, cy, w, h) {
  const relX = (x - cx) / (w / 2);
  const relY = (y - cy) / h;
  const topY = -0.45;
  const bottomY = 0.55;
  if (relY < topY || relY > bottomY) return false;
  let maxX;
  if (relY < 0.05) {
    maxX = 1.0;
  } else {
    const t = Math.max(0, (relY - 0.05)) / (bottomY - 0.05);
    maxX = 1.0 * (1 - t * t * 0.95);
  }
  return Math.abs(relX) <= maxX;
}

function fillShield(cx, cy, w, h, r, g, b, a) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (isInsideShield(x, y, cx, cy, w, h)) {
        setPixel(x, y, r, g, b, a);
      }
    }
  }
}

function drawShieldOutline(cx, cy, w, h, thickness, r, g, b, a) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const inside = isInsideShield(x, y, cx, cy, w, h);
      // Check if any neighbor is outside
      if (inside) {
        let onEdge = false;
        for (let dy = -thickness; dy <= thickness && !onEdge; dy++) {
          for (let dx = -thickness; dx <= thickness && !onEdge; dx++) {
            if (dx * dx + dy * dy <= thickness * thickness) {
              if (!isInsideShield(x + dx, y + dy, cx, cy, w, h)) {
                onEdge = true;
              }
            }
          }
        }
        if (onEdge) setPixel(x, y, r, g, b, a);
      }
    }
  }
}

// --- Colors ---
const BG = [14, 17, 33];        // Deep navy
const SHIELD_FILL = [20, 50, 90]; // Dark blue fill
const BLUE = [0, 160, 255];     // Primary blue
const CYAN = [40, 220, 255];    // Bright cyan
const WHITE = [255, 255, 255];

// --- Draw ---

// 1. Background
fillRoundedRect(0, 0, SIZE, SIZE, 22, ...BG);

// 2. Shield body (larger, fills more space)
const shieldCX = 64, shieldCY = 60;
const shieldW = 88, shieldH = 92;

// Gradient-like shield fill: darker at top, slightly brighter at bottom
for (let y = 0; y < SIZE; y++) {
  const t = y / SIZE;
  const sr = Math.round(15 + t * 20);
  const sg = Math.round(35 + t * 30);
  const sb = Math.round(70 + t * 40);
  for (let x = 0; x < SIZE; x++) {
    if (isInsideShield(x, y, shieldCX, shieldCY, shieldW, shieldH)) {
      setPixel(x, y, sr, sg, sb, 180);
    }
  }
}

// 3. Shield outline - bright blue, thick
drawShieldOutline(shieldCX, shieldCY, shieldW, shieldH, 2.5, ...BLUE, 255);

// 4. Glow effect on shield top
drawThickLine(32, 23, 96, 23, 2, ...CYAN, 100);

// 5. Big bold checkmark - the hero element
const checkX1 = 40, checkY1 = 62;
const checkX2 = 56, checkY2 = 82;
const checkX3 = 90, checkY3 = 40;
drawThickLine(checkX1, checkY1, checkX2, checkY2, 6, ...WHITE);
drawThickLine(checkX2, checkY2, checkX3, checkY3, 6, ...WHITE);

// 6. Glow around checkmark
drawThickLine(checkX1, checkY1, checkX2, checkY2, 10, ...CYAN, 30);
drawThickLine(checkX2, checkY2, checkX3, checkY3, 10, ...CYAN, 30);

// 7. Two scan lines under the checkmark
drawThickLine(36, 94, 92, 94, 1.5, ...CYAN, 100);
drawThickLine(42, 100, 86, 100, 1.5, ...CYAN, 60);

// 8. Small diamond at shield top
fillCircle(64, 18, 3, ...CYAN, 220);

// --- PNG Encoder ---
function encodePNG(width, height, rgbaData) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0;
    rgbaData.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(rawData, { level: 9 });

  function makeChunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crcData = Buffer.concat([typeBuffer, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcData) >>> 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
  }

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return crc ^ 0xFFFFFFFF;
}

const png = encodePNG(SIZE, SIZE, pixels);
fs.writeFileSync('media/icon.png', png);
console.log(`Icon: ${png.length} bytes (${SIZE}x${SIZE})`);
