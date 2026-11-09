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
const SITE_URL = 'https://yejiawei19991118.github.io/douyin-index-tool/';
const USERSCRIPT_NAME = 'douyin-index-extract.user.js';

function fail(msg) {
  console.error('构建失败：' + msg);
  process.exit(1);
}

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

/*
 * 构建号：取 git 提交数（本地与 CI 一致、每次提交必然递增，用户脚本靠它才会自动更新）；
 * 取不到时退回 CI 运行号，最后兜底 0。@version = versionName + '.' + 构建号。
 */
function buildNumber() {
  try {
    const n = require('child_process').execSync('git rev-list --count HEAD', {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim();
    if (/^\d+$/.test(n)) return n;
  } catch (e) { /* 无 git 环境时继续退回 CI 运行号 */ }
  const ci = process.env.GITHUB_RUN_NUMBER;
  return ci && /^\d+$/.test(ci) ? ci : '0';
}

/*
 * 版本号：与 app/build.gradle 使用同一算法，保证 APK / PWA / 用户脚本三者一致。
 * 基础版本取 build.gradle 的 VERSION_NAME_BASE，追加 git 提交数；
 * @version / SW 缓存名 / <meta dyrank-version> 全部由它派生。
 */
function appVersionBase() {
  const gradle = readUtf8(path.join(ROOT, 'app', 'build.gradle'));
  const m = gradle.match(/VERSION_NAME_BASE\s*=\s*['"]([^'"]+)['"]/);
  if (m) return m[1];
  // 兼容旧写法（versionName 仍是字面量）
  const legacy = gradle.match(/versionName\s+"([^"]+)"/);
  if (legacy) return legacy[1];
  fail('app/build.gradle 未找到 VERSION_NAME_BASE')
}

function fullVersion() {
  const n = buildNumber();
  const base = appVersionBase();
  return n === '0' ? base : base + '.' + n;
}

const VERSION = fullVersion();

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
  // CRC 只覆盖「类型 + 数据」，长度字段不参与计算；带上长度会让 IEND 等块的校验值错误，
  // 严格校验的 PNG 解码器（含部分图标审计工具）会直接判定文件损坏。
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
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
  '<meta name="dyrank-version" content="' + VERSION + '">',
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

/* ============================ 用户脚本 ============================ */

/*
 * 页面地址的唯一来源是 Android 端 AppUrls.java：构建时解析 BASE_URL、各页面路径常量
 * 与各构图方法的 return 表达式，生成「含 {kw} 占位符」的四条 URL 模板注入用户脚本。
 * 这样改 APK 的地址或参数后，脚本自动跟着变，不需要人工同步第二份逻辑。
 */
function readPageUrlTemplates() {
  const javaPath = path.join(ROOT, 'app', 'src', 'main', 'java', 'com', 'lmt', 'dyindex', 'AppUrls.java');
  const src = readUtf8(javaPath);
  const base = src.match(/BASE_URL\s*=\s*"([^"]+)"/);
  if (!base) fail('AppUrls.java 未解析到 BASE_URL');

  const RULES = {
    keyword: ['targetUrl', 'ANALYSIS_URL'],
    daren: ['darenSearchUrl', 'DAREN_SEARCH_URL'],
    video: ['videoSearchUrl', 'VIDEO_SEARCH_URL'],
    topic: ['topicSearchUrl', 'TOPIC_SEARCH_URL']
  };

  const templates = {};
  Object.keys(RULES).forEach(function (type) {
    const fn = RULES[type][0];
    const constName = RULES[type][1];

    const pathMatch = src.match(new RegExp(constName + '\\s*=\\s*BASE_URL\\s*\\+\\s*"([^"]+)"'));
    if (!pathMatch) fail('AppUrls.java 未解析到 ' + constName);

    // return <常量> + "?参数=" + enc(keyword) [+ "&其他参数"];  参数名与附加参数都来自 APK
    const bodyMatch = src.match(new RegExp(
      'String\\s+' + fn + '\\s*\\(' + '[\\s\\S]*?' +
      'return\\s+' + constName + '\\s*\\+\\s*"([^"]*)"\\s*\\+\\s*enc\\(keyword\\)\\s*(?:\\+\\s*"([^"]*)")?'
    ));
    if (!bodyMatch) fail('AppUrls.java 的 ' + fn + ' 结构已变化，请同步更新 tools/build-pwa.js');

    templates[type] = base[1] + pathMatch[1] + bodyMatch[1] + '{kw}' + (bodyMatch[2] || '');
  });

  return templates;
}

/*
 * 网页端抓取的唯一可行形态：把脚本注入 creator.douyin.com 页面内（同源），
 * 抓完把 CSV 交给 PWA。extract.js 与 Android 端共用，这里只拼接「网页版桥 + 悬浮面板」。
 */
function buildUserscript() {
  const pageUrls = readPageUrlTemplates();
  Object.keys(pageUrls).forEach(function (type) {
    if (pageUrls[type].indexOf('{kw}') < 0) fail('页面地址模板缺少关键词占位符：' + type);
  });

  const rawController = readUtf8(path.join(PWA_SRC_DIR, 'userscript-controller.js'));
  if (!/__PAGE_URLS__/.test(rawController)) fail('用户脚本缺少 __PAGE_URLS__ 注入点');
  const controller = rawController
    .replace(/__PWA_URL__/g, SITE_URL)
    .replace(/__PAGE_URLS__/, function () { return JSON.stringify(pageUrls); });

  const extract = readUtf8(path.join(SRC_DIR, 'extract.js'));
  if (!/window\.__dyRun\s*=/.test(extract)) fail('extract.js 未导出 window.__dyRun');
  if (!/window\.DyBridge/.test(extract)) fail('extract.js 未通过 window.DyBridge 回传');

  const header = [
    '// ==UserScript==',
    '// @name         抖音指数人群分析抓取（网页版）',
    '// @namespace    https://github.com/yejiawei19991118/douyin-index-tool',
    '// @version      ' + VERSION,
    '// @description  在 creator.douyin.com 人群分析页抓取数据，复制 CSV 后导入同行 PWA 排名',
    '// @match        https://creator.douyin.com/*',
    '// @run-at       document-idle',
    '// @grant        none',
    '// @noframes',
    '// @homepageURL  ' + SITE_URL,
    '// @downloadURL  ' + SITE_URL + USERSCRIPT_NAME,
    '// @updateURL    ' + SITE_URL + USERSCRIPT_NAME,
    '// ==/UserScript==',
    '',
    '/* 本文件由 tools/build-pwa.js 生成（含 Android 端共用的 extract.js），请勿直接修改。 */'
  ].join('\n');

  return header + '\n\n' + controller +
    '\n\n/* ==================== 以下为与 Android 端共用的抓取实现 extract.js ==================== */\n' +
    extract;
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
  //    sw.js 的缓存名带构建版本：每次发布都会生成新缓存并接管，避免旧资源残留
  for (const name of ['manifest.webmanifest', 'sw.js', 'web-boot.js', 'web.css']) {
    const p = path.join(PWA_SRC_DIR, name);
    if (!fs.existsSync(p)) fail('缺少 pwa-src/' + name);
    let content = readUtf8(p);
    if (name === 'sw.js') {
      if (!/__CACHE_VERSION__/.test(content)) fail('pwa-src/sw.js 缺少 __CACHE_VERSION__');
      content = content.replace(/__CACHE_VERSION__/g, VERSION);
    }
    emit(name, content);
  }

  // 4) 用户脚本：网页端唯一可行的抓取形态（页面内同源执行），抓完把 CSV 交给 PWA
  emit(USERSCRIPT_NAME, buildUserscript());

  // 5) 图标：manifest 用带圆角透明底，iOS 用满幅方形（由系统切圆角）
  emit('icons/icon-192.png', renderIcon(192, true));
  emit('icons/icon-512.png', renderIcon(512, true));
  emit('icons/icon-180.png', renderIcon(180, false));

  // 6) 输出清单，便于 CI 日志里核对
  const total = written.reduce((sum, p) => sum + fs.statSync(p).size, 0);
  console.log('PWA 构建完成 → ' + OUT_DIR + '（版本 ' + VERSION + '）');
  written
    .map((p) => path.relative(OUT_DIR, p))
    .sort()
    .forEach((rel) => console.log('  ' + rel + '  ' + fs.statSync(path.join(OUT_DIR, rel)).size + ' B'));
  console.log('共 ' + written.length + ' 个文件，' + (total / 1024).toFixed(1) + ' KB');
}

main();
