#!/usr/bin/env node
/*
 * PWA 构建脚本（零依赖，仅用 Node 内置模块）
 *
 * 作用：把 Android 端共用的排名页 app/src/main/assets/ranking.html 转换为可部署的 PWA，
 * 输出到 pwa-dist/（不入库，由 GitHub Pages 工作流构建后直接发布）。
 *
 * 为什么是「转换」而不是「复制一份页面」：
 *   ranking.html 是 Android 端与网页端唯一的排名实现来源，任何改动（评分口径、表格、导出）
 *   都必须对两端同时生效。这里只在 <head> / </body> 前后追加 PWA 独有的元数据与启动脚本，
 *   不修改页面任何业务逻辑，避免出现两份分叉的实现。
 *
 * 用法：node tools/build-pwa.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'app', 'src', 'main', 'assets');
const PWA_SRC_DIR = path.join(ROOT, 'pwa-src');
const OUT_DIR = path.join(ROOT, 'pwa-dist');

const APP_NAME = '抖音指数综合排名';

function fail(msg) {
  console.error('构建失败：' + msg);
  process.exit(1);
}

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeFile(rel, content) {
  const target = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

/* ============================ 图标生成 ============================ */

const CRC_TABLE = (function () {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  // PNG 块头顺序为「长度(4) → 类型(4)」，写反会生成无法解码的文件
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([body, crc]);
}

function pngEncode(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 位深
  ihdr[9] = 6;  // 颜色类型 6 = RGBA
  // 每行前置 1 字节过滤类型（0 = None）
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* 圆角矩形命中判定（px/py 为像素中心坐标），用于给背景与柱体做抗锯齿前的覆盖测试 */
function inRoundRect(px, py, x0, y0, w, h, r) {
  const dx = Math.abs(px - (x0 + w / 2)) - (w / 2 - r);
  const dy = Math.abs(py - (y0 + h / 2)) - (h / 2 - r);
  if (dx <= 0 && dy <= 0) return true;
  const qx = Math.max(dx, 0);
  const qy = Math.max(dy, 0);
  return qx * qx + qy * qy <= r * r;
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

/*
 * 图标：蓝紫渐变底 + 四根上升白色柱体（直接对应「综合排名」），
 * rounded=true 生成带透明圆角的版本给 manifest 用；rounded=false 生成满幅方形，
 * 交给 iOS 自行切圆角（apple-touch-icon 由系统统一加圆角与阴影）。
 */
function renderIcon(size, rounded) {
  const scale = 3;
  const N = size * scale;
  const buf = new Uint8Array(N * N * 4); // 默认全透明

  // 背景渐变：#2563eb → #4338ca
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (rounded && !inRoundRect(px, py, 0, 0, N, N, N * 0.22)) continue;
      const t = (px + py) / (2 * N);
      const off = (y * N + x) * 4;
      buf[off] = lerp(0x25, 0x43, t);
      buf[off + 1] = lerp(0x63, 0x38, t);
      buf[off + 2] = lerp(0xeb, 0xca, t);
      buf[off + 3] = 255;
    }
  }

  // 四根上升柱体
  const barW = N * 0.105;
  const gap = N * 0.048;
  const heights = [0.16, 0.24, 0.33, 0.43].map((v) => v * N);
  const total = barW * heights.length + gap * (heights.length - 1);
  let x0 = (N - total) / 2;
  const baseline = N * 0.80;
  heights.forEach((h, i) => {
    const top = baseline - h;
    const radius = barW / 2;
    for (let y = Math.floor(top); y < Math.ceil(baseline); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x0 + barW); x++) {
        if (!inRoundRect(x + 0.5, y + 0.5, x0, top, barW, h, radius)) continue;
        const off = (y * N + x) * 4;
        buf[off] = 255;
        buf[off + 1] = 255;
        buf[off + 2] = 255;
        buf[off + 3] = 255;
      }
    }
    x0 += barW + gap;
  });

  // 面积平均下采样，得到抗锯齿边缘
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const off = ((y * scale + sy) * N + (x * scale + sx)) * 4;
          const alpha = buf[off + 3];
          // 预乘 alpha 再平均，避免透明边缘出现暗边
          r += buf[off] * alpha;
          g += buf[off + 1] * alpha;
          b += buf[off + 2] * alpha;
          a += alpha;
        }
      }
      const off = (y * size + x) * 4;
      if (a > 0) {
        out[off] = Math.round(r / a);
        out[off + 1] = Math.round(g / a);
        out[off + 2] = Math.round(b / a);
        out[off + 3] = Math.round(a / (scale * scale));
      }
    }
  }
  return pngEncode(size, size, out);
}

/* ============================ 页面转换 ============================ */

const HEAD_TAGS = [
  '<!-- 本文件由 tools/build-pwa.js 从 app/src/main/assets/ranking.html 生成，请勿直接修改 -->',
  '<meta name="theme-color" content="#2563eb">',
  '<meta name="description" content="抖音指数人群分析 CSV 的离线综合排名工具（PWA）">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  '<meta name="apple-mobile-web-app-title" content="' + APP_NAME + '">',
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="apple-touch-icon" sizes="180x180" href="icons/icon-180.png">',
  '<link rel="stylesheet" href="web.css">'
].join('\n');

const BOOT_SCRIPT = '<script src="web-boot.js"></script>';

function buildIndexHtml() {
  const source = readUtf8(path.join(SRC_DIR, 'ranking.html'));
  if (!/<\/head>/.test(source)) fail('ranking.html 缺少 </head>');
  if (!/<\/body>/.test(source)) fail('ranking.html 缺少 </body>');
  if (!/src="scoring\.js"/.test(source)) fail('ranking.html 未引用 scoring.js');

  return source
    .replace(/<\/head>/, HEAD_TAGS + '\n</head>')
    .replace(/<\/body>/, BOOT_SCRIPT + '\n</body>');
}

/* ============================ 主流程 ============================ */

function main() {
  if (!fs.existsSync(SRC_DIR)) fail('找不到 Android 资产目录：' + SRC_DIR);
  if (!fs.existsSync(PWA_SRC_DIR)) fail('找不到 PWA 源目录：' + PWA_SRC_DIR);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const written = [];
  function emit(rel, content) {
    written.push(writeFile(rel, content));
  }

  // 1) 排名页（转换）
  emit('index.html', buildIndexHtml());

  // 2) 评分算法与页面共用同一份实现，直接复制，绝不在此处另存副本逻辑
  emit('scoring.js', fs.readFileSync(path.join(SRC_DIR, 'scoring.js')));

  // 3) PWA 专属资源（manifest / service worker / 启动脚本 / 补充样式）
  for (const name of ['manifest.webmanifest', 'sw.js', 'web-boot.js', 'web.css']) {
    const p = path.join(PWA_SRC_DIR, name);
    if (!fs.existsSync(p)) fail('缺少 pwa-src/' + name);
    emit(name, fs.readFileSync(p));
  }

  // 4) 图标：manifest 用带圆角透明底，iOS 用满幅方形（由系统切圆角）
  emit('icons/icon-192.png', renderIcon(192, true));
  emit('icons/icon-512.png', renderIcon(512, true));
  emit('icons/icon-180.png', renderIcon(180, false));

  // 5) 输出清单，便于 CI 日志里核对
  const total = written.reduce((sum, p) => sum + fs.statSync(p).size, 0);
  console.log('PWA 构建完成 → ' + OUT_DIR);
  written
    .map((p) => path.relative(OUT_DIR, p))
    .sort()
    .forEach((rel) => console.log('  ' + rel + '  ' + fs.statSync(path.join(OUT_DIR, rel)).size + ' B'));
  console.log('共 ' + written.length + ' 个文件，' + (total / 1024).toFixed(1) + ' KB');
}

main();
