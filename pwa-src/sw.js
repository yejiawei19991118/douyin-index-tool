/*
 * PWA Service Worker
 *
 * 目标：iPhone 添加到主屏后，即使没网也能打开并分析已导入过的数据。
 * 策略：
 *   - 导航请求（打开页面）：网络优先，成功即更新缓存；离线回退缓存的 index.html。
 *   - 静态资源：缓存优先，后台顺带更新（下次打开即为新版本）。
 * 页面内所有资源都是同源相对路径，无第三方 CDN，因此离线可完整运行。
 */
'use strict';

/* 缓存名带构建版本（tools/build-pwa.js 注入）：每次发布都换新缓存，装完即接管 */
const CACHE_NAME = 'dyrank-pwa-__CACHE_VERSION__';

/* 相对路径以 sw.js 所在目录为基准（GitHub Pages 子路径部署同样适用） */
const PRECACHE = [
  './',
  'index.html',
  'scoring.js',
  'web-boot.js',
  'web.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  // 页面导航：网络优先，保证更新后立刻生效；离线时回退壳页面
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put('index.html', copy); });
          return res;
        })
        .catch(function () { return caches.match('index.html'); })
    );
    return;
  }

  // 仅接管同源资源，跨域请求原样放行
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then(function (cached) {
      const network = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
