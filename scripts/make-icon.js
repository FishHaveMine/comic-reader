'use strict';

/**
 * 生成应用图标 build/icon.png（1024×1024）。
 *
 * 不引入任何图像库：按 PNG 规范手写编码器（IHDR + IDAT + IEND），
 * 画一个 macOS 风格圆角方块 + 漫画对话气泡，用 3 倍超采样做抗锯齿。
 * 与 video-player 的图标保持同一套视觉：同样的底板与强调色，只换中心图形。
 */

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 1024;
const SUPER = 3;
const SAMPLES = SIZE * SUPER;

const TOP = [34, 48, 92];      // 渐变顶部 #22305c
const BOTTOM = [11, 11, 15];   // 渐变底部 #0b0b0f
const ACCENT = [91, 140, 255]; // 气泡 #5b8cff
const RADIUS = 0.2246;         // 圆角比例，对齐 macOS 图标规范

// 对话气泡：圆角矩形 + 左下角小尾巴（归一化坐标）
const BUBBLE = { x0: 0.205, y0: 0.235, x1: 0.795, y1: 0.605, r: 0.085 };
const TAIL = [[0.315, 0.595], [0.300, 0.790], [0.475, 0.595]];

/* --------------------------------------------------------------- PNG 编码 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ 绘制 */

function insideRoundedRect(u, v, box) {
  const dx = Math.max(box.x0 + box.r - u, u - (box.x1 - box.r), 0);
  const dy = Math.max(box.y0 + box.r - v, v - (box.y1 - box.r), 0);
  return dx * dx + dy * dy <= box.r * box.r;
}

function edgeSign(px, py, a, b) {
  return (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
}

function insideTriangle(px, py, [a, b, c]) {
  const d1 = edgeSign(px, py, a, b);
  const d2 = edgeSign(px, py, b, c);
  const d3 = edgeSign(px, py, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** 返回 [r, g, b, a]，坐标为 0~1 */
function sample(u, v) {
  const dx = Math.max(RADIUS - u, u - (1 - RADIUS), 0);
  const dy = Math.max(RADIUS - v, v - (1 - RADIUS), 0);
  if (dx * dx + dy * dy > RADIUS * RADIUS) return [0, 0, 0, 0];

  if (insideRoundedRect(u, v, BUBBLE) || insideTriangle(u, v, TAIL)) {
    return [ACCENT[0], ACCENT[1], ACCENT[2], 255];
  }

  return [
    TOP[0] + (BOTTOM[0] - TOP[0]) * v,
    TOP[1] + (BOTTOM[1] - TOP[1]) * v,
    TOP[2] + (BOTTOM[2] - TOP[2]) * v,
    255,
  ];
}

function render() {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const total = SUPER * SUPER;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;

      for (let sy = 0; sy < SUPER; sy += 1) {
        const v = (y * SUPER + sy + 0.5) / SAMPLES;
        for (let sx = 0; sx < SUPER; sx += 1) {
          const u = (x * SUPER + sx + 0.5) / SAMPLES;
          const [cr, cg, cb, ca] = sample(u, v);
          const a = ca / 255;
          r += cr * a;
          g += cg * a;
          b += cb * a;
          alpha += a;
        }
      }

      const index = (y * SIZE + x) * 4;
      if (alpha > 0) {
        out[index] = Math.round(r / alpha);
        out[index + 1] = Math.round(g / alpha);
        out[index + 2] = Math.round(b / alpha);
      }
      out[index + 3] = Math.round((alpha / total) * 255);
    }
  }

  return out;
}

const target = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, encodePng(SIZE, SIZE, render()));
console.log(`图标已生成：${target}`);
