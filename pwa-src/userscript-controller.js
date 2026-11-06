/*
 * 用户脚本控制器（网页版抓取入口）
 *
 * 运行位置：creator.douyin.com 页面内（Userscripts / 篡改猴），属同源脚本，
 * 因此可以直接调用页面 DOM 与共享的 extract.js —— 这是网页端唯一可行的抓取方式。
 *
 * 职责：
 *   1. 提供 window.DyBridge 的网页版实现（extract.js 通过它回传日志/结果/错误）；
 *   2. 右下角浮动按钮「抓取数据」→ 调 window.__dyRun()（extract.js 导出）；
 *   3. 抓取完成后给出「复制 CSV / 下载 CSV / 打开排名页」，把 CSV 交给 PWA 导入；
 *   4. 「打开页面」入口：输入关键词后一键打开抖音指数的四类页面（与 Android 端 AppUrls 一致）。
 *
 * 注意：本文件由 tools/build-pwa.js 注入 extract.js 后生成 .user.js，
 * 不要在页面里单独引用它（它依赖 extract.js 定义的 window.__dyRun）。
 */
(function () {
  'use strict';

  if (window.__dyWebPanel) return;  // 防止扩展重复注入
  window.__dyWebPanel = true;

  var PWA_URL = '__PWA_URL__';

  var HOST_ID = 'dywx-panel-host';
  var els = {};
  var lastCsv = '';
  var lastName = '抖音指数_人群分析.csv';

  var PAGE_TYPE_LABEL = { keyword: '关键词', topic: '话题', daren: '达人', video: '视频' };

  /* 与 Android 端 AppUrls 完全一致：指数页根地址 + 四类入口 */
  var INDEX_BASE = 'https://creator.douyin.com/creator-micro/creator-count/arithmetic-index';

  var TEMPLATE =
    '<style>' +
      ':host{all:initial}' +
      '.wrap{position:fixed;right:12px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:2147483000;' +
        'display:flex;flex-direction:column;align-items:flex-end;gap:8px;' +
        'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;' +
        'color:#1f2937;line-height:1.5}' +
      '.fab{border:0;border-radius:999px;background:#2563eb;color:#fff;font-size:14px;font-weight:600;' +
        'padding:12px 18px;min-height:44px;box-shadow:0 6px 20px rgba(37,99,235,.35);cursor:pointer;' +
        '-webkit-tap-highlight-color:transparent}' +
      '.fab[disabled]{opacity:.75;cursor:default}' +
      '.fab:active{transform:scale(.97)}' +
      '.card{width:min(320px,calc(100vw - 24px));background:#fff;border:1px solid #e5e7eb;border-radius:14px;' +
        'box-shadow:0 10px 30px rgba(17,24,39,.18);padding:12px 14px}' +
      '.card[hidden]{display:none}' +
      '.head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}' +
      '.title{font-weight:600;font-size:14px}' +
      '.close{border:0;background:transparent;color:#9ca3af;font-size:18px;line-height:1;padding:0 2px;cursor:pointer}' +
      '.status{color:#4b5563;font-size:12px;word-break:break-word}' +
      '.status.err{color:#b91c1c}' +
      '.result{margin-top:8px;padding-top:8px;border-top:1px dashed #e5e7eb}' +
      '.result[hidden]{display:none}' +
      '.summary{font-size:13px;font-weight:600;color:#111827;word-break:break-word}' +
      '.hint{font-size:12px;color:#6b7280;margin-top:2px}' +
      '.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}' +
      '.btn{border:1px solid #e5e7eb;background:#f9fafb;color:#1f2937;border-radius:8px;padding:8px 12px;' +
        'font-size:13px;min-height:36px;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
      '.btn.primary{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}' +
      '.btn:active{transform:scale(.97)}' +
      '.help{position:fixed;inset:0;z-index:2147483001;background:rgba(17,24,39,.45);' +
        'display:flex;align-items:flex-end;justify-content:center}' +
      '.help[hidden]{display:none}' +
      '.help-panel{width:100%;max-width:560px;max-height:80vh;overflow-y:auto;background:#fff;' +
        'border-radius:16px 16px 0 0;box-shadow:0 -8px 24px rgba(17,24,39,.22);' +
        'padding:14px 16px calc(16px + env(safe-area-inset-bottom))}' +
      '.help-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}' +
      '.help-title{font-weight:600;font-size:15px}' +
      '.help ol{margin:0;padding-left:20px;font-size:13px;line-height:1.7;color:#374151}' +
      '.help li{margin-bottom:5px;word-break:break-word}' +
      '.help .note{margin-top:12px;font-size:12px;color:#6b7280;line-height:1.6}' +
      '.link{border:1px solid #e5e7eb;background:#fff;color:#4b5563;border-radius:999px;' +
        'padding:6px 12px;font-size:12px;min-height:32px;cursor:pointer;' +
        'box-shadow:0 2px 8px rgba(17,24,39,.12);-webkit-tap-highlight-color:transparent}' +
      '.link:active{transform:scale(.97)}' +
      '.pills{display:flex;align-items:center;gap:8px}' +
      '.launcher{width:min(320px,calc(100vw - 24px));background:#fff;border:1px solid #e5e7eb;border-radius:14px;' +
        'box-shadow:0 10px 30px rgba(17,24,39,.18);padding:12px 14px}' +
      '.launcher[hidden]{display:none}' +
      '.kw{width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;' +
        'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;' +
        'font-size:16px;min-height:38px;color:#111827;background:#fff;outline:none;-webkit-appearance:none}' +
      '.kw:focus{border-color:#2563eb}' +
      '.launch-tip{font-size:12px;color:#6b7280;margin-top:6px;word-break:break-word}' +
      '.launch-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}' +
    '</style>' +
    '<div class="wrap">' +
      '<div class="pills">' +
        '<button type="button" class="link" data-act="launch">打开页面</button>' +
        '<button type="button" class="link" data-act="help">iPhone 用法</button>' +
      '</div>' +
      '<div class="launcher" hidden>' +
        '<div class="head"><span class="title">打开指数页面</span>' +
          '<button type="button" class="close" data-act="launch-close" aria-label="收起">×</button></div>' +
        '<input class="kw" type="search" placeholder="关键词 / 抖音号 / 话题" ' +
          'autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
        '<div class="launch-grid">' +
          '<button type="button" class="btn primary" data-page="keyword">关键词分析</button>' +
          '<button type="button" class="btn" data-page="daren">达人搜索</button>' +
          '<button type="button" class="btn" data-page="video">视频搜索</button>' +
          '<button type="button" class="btn" data-page="topic">话题搜索</button>' +
        '</div>' +
        '<div class="launch-tip">输入后点对应按钮直达该页面；达人/视频/话题页进去后还需手动进入详情。</div>' +
      '</div>' +
      '<div class="card" hidden>' +
        '<div class="head"><span class="title">抖音指数抓取</span>' +
          '<button type="button" class="close" aria-label="收起">×</button></div>' +
        '<div class="status"></div>' +
        '<div class="result" hidden>' +
          '<div class="summary"></div>' +
          '<div class="hint">复制后切到主屏的排名 PWA，点「粘贴 CSV」即可分析。</div>' +
          '<div class="actions">' +
            '<button type="button" class="btn primary" data-act="copy">复制 CSV</button>' +
            '<button type="button" class="btn" data-act="download">下载 CSV</button>' +
            '<button type="button" class="btn" data-act="open">打开排名页</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="help" hidden>' +
        '<div class="help-panel">' +
          '<div class="help-head"><span class="help-title">iPhone 用法</span>' +
            '<button type="button" class="close" data-act="help-close" aria-label="关闭">×</button></div>' +
          '<ol>' +
            '<li>选页：点「打开页面」输入关键词，再点「关键词分析 / 达人搜索 / 视频搜索 / 话题搜索」直达该页</li>' +
            '<li>抓取前：登录创作者中心并打开人群分析页，等图表全部渲染完成</li>' +
            '<li>点右下角「抓取数据」，期间保持在当前页面（脚本会自动滚动与下钻）</li>' +
            '<li>抓完点「复制 CSV」；被系统拒绝时改用「下载 CSV」</li>' +
            '<li>切到主屏的「抖音指数排名」→「粘贴 CSV」（或用「选择 CSV 文件」导入下载好的 CSV）</li>' +
            '<li>首次使用排名页：Safari 打开后点「分享 → 添加到主屏幕」，之后全屏、断网也能用</li>' +
          '</ol>' +
          '<div class="note">CSV 只在本机流转；抓取脚本依赖抖音页面结构，改版可能失效，请控制抓取频率。</div>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="fab">抓取数据</button>' +
    '</div>';

  function mountUI() {
    var old = document.getElementById(HOST_ID);
    if (old) old.remove();

    var host = document.createElement('div');
    host.id = HOST_ID;
    var root = host;
    if (host.attachShadow) root = host.attachShadow({ mode: 'open' });
    root.innerHTML = TEMPLATE;
    document.body.appendChild(host);

    els.host = host;
    els.fab = root.querySelector('.fab');
    els.card = root.querySelector('.card');
    els.status = root.querySelector('.status');
    els.result = root.querySelector('.result');
    els.summary = root.querySelector('.summary');
    els.close = root.querySelector('.card .close');  // 注意：launcher 里也有 .close，必须限定
    els.help = root.querySelector('.help');
    els.launcher = root.querySelector('.launcher');
    els.kw = root.querySelector('.kw');
    els.launchTip = root.querySelector('.launch-tip');
    els.launchTipDef = els.launchTip ? els.launchTip.textContent : '';

    els.fab.addEventListener('click', run);
    els.close.addEventListener('click', function () { els.card.hidden = true; });

    // 「打开页面」：与 Android APK 的四种模式一致，输入关键词后一键直达
    root.querySelectorAll('[data-act="launch"]').forEach(function (btn) {
      btn.addEventListener('click', toggleLauncher);
    });
    var launchClose = root.querySelector('[data-act="launch-close"]');
    if (launchClose) launchClose.addEventListener('click', function () { els.launcher.hidden = true; });
    root.querySelectorAll('[data-page]').forEach(function (btn) {
      btn.addEventListener('click', function () { openPage(btn.getAttribute('data-page')); });
    });
    if (els.kw) {
      els.kw.addEventListener('input', function () { setLaunchTip(''); });
      els.kw.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); openPage('keyword'); }
      });
    }

    root.querySelectorAll('.actions .btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-act');
        if (act === 'copy') doCopy();
        else if (act === 'download') doDownload();
        else if (act === 'open') window.open(PWA_URL, '_blank');
      });
    });

    // 「iPhone 用法」入口（卡片外的小胶囊按钮），未抓取时也能查看步骤
    root.querySelectorAll('[data-act="help"]').forEach(function (btn) {
      btn.addEventListener('click', function () { els.help.hidden = false; });
    });

    // 「iPhone 用法」弹层：关闭按钮 + 点遮罩空白处关闭
    var helpClose = root.querySelector('[data-act="help-close"]');
    if (helpClose) helpClose.addEventListener('click', function () { els.help.hidden = true; });
    els.help.addEventListener('click', function (e) {
      if (e.target === els.help) els.help.hidden = true;
    });
  }

  /* ============================ 打开指数页面 ============================ */

  var KW_KEY = 'dywx.launchKw';

  function pageUrl(type, kw) {
    var k = encodeURIComponent(kw);
    if (type === 'daren') return INDEX_BASE + '/daren/search?keyword=' + k;
    if (type === 'video') return INDEX_BASE + '/videosearch?query=' + k;
    if (type === 'topic') return INDEX_BASE + '/topicsearch?topic=' + k;
    return INDEX_BASE + '/analysis?keyword=' + k + '&tab=crowd&appName=aweme&source=creator';
  }

  function toggleLauncher() {
    var open = els.launcher.hidden;
    els.launcher.hidden = !open;
    if (!open) return;
    // 两个面板互斥展开，避免小屏下叠加超出视口
    els.card.hidden = true;
    if (!els.kw) return;
    if (!els.kw.value) {
      try { els.kw.value = localStorage.getItem(KW_KEY) || ''; } catch (e) { /* 隐私模式忽略 */ }
    }
    setLaunchTip('');
    els.kw.focus();
  }

  function setLaunchTip(text, isError) {
    if (!els.launchTip) return;
    els.launchTip.textContent = text || els.launchTipDef;
    els.launchTip.style.color = isError ? '#b91c1c' : '';
  }

  function openPage(type) {
    var kw = String((els.kw && els.kw.value) || '').trim();
    if (!kw) {
      setLaunchTip('请先输入关键词（达人页可填抖音号）', true);
      if (els.kw) els.kw.focus();
      return;
    }
    try { localStorage.setItem(KW_KEY, kw); } catch (e) { /* 忽略 */ }
    // 同标签跳转：目标页同属 creator 域，脚本会在新页面重新注入
    location.href = pageUrl(type, kw);
  }

  function setStatus(text, isError) {
    if (els.status) {
      els.status.textContent = text;
      els.status.classList.toggle('err', !!isError);
    }
  }

  function start() {
    ensureUI();
    els.card.hidden = false;
    els.launcher.hidden = true;
    els.result.hidden = true;
    els.fab.disabled = true;
    els.fab.textContent = '抓取中…';
  }

  function finish() {
    if (!els.fab) return;
    els.fab.disabled = false;
    els.fab.textContent = '再次抓取';
  }

  function ensureUI() {
    if (els.host && els.host.isConnected) return;
    mountUI();
  }

  function run() {
    ensureUI();
    if (!window.__dyRun) {
      els.card.hidden = false;
      setStatus('抓取脚本尚未就绪：请先进入人群分析页，等图表加载完成后再点。', true);
      return;
    }
    if (window.__dyRunning) {
      els.card.hidden = false;
      setStatus('正在抓取中，请勿操作页面…');
      return;
    }
    start();
    setStatus('开始抓取…页面会自动滚动以加载全部图表，请保持页面在前台。');
    // __dyRun 内部已做异常捕获，异常会走 DyBridge.onError
    window.__dyRun();
    // 兜底：极端情况下 extract.js 未回调，3 分钟后恢复按钮，避免界面卡死
    setTimeout(function () {
      if (els.fab && els.fab.disabled) {
        finish();
        setStatus('抓取超时：请确认页面已加载完整后重试。', true);
      }
    }, 180000);
  }

  /* ============================ 结果处理 ============================ */

  function showResult(res) {
    finish();
    if (!res || typeof res.csv !== 'string' || !res.csv) {
      setStatus('未提取到数据：请确认当前页是人群分析页（地域/年龄/性别等图表已渲染）。', true);
      return;
    }
    lastCsv = res.csv;
    var kw = String(res.keyword || '人群分析').trim() || '人群分析';
    var typeLabel = PAGE_TYPE_LABEL[res.pageType] || '';
    lastName = '抖音指数_' + kw.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').slice(0, 80) +
      (typeLabel ? '_' + typeLabel : '') + '.csv';

    els.result.hidden = false;
    els.summary.textContent = kw + (typeLabel ? '（' + typeLabel + '）' : '') + ' · ' +
      (res.rowCount || 0) + ' 行';

    if (res.ok === false || (res.rowCount || 0) === 0) {
      setStatus('数据为空，可能是页面区块未加载完成，建议刷新页面后重试。', true);
      return;
    }

    // 自动复制一次（Safari 可能因非用户手势拒绝，失败时提示点按钮手动复制）
    copyText(lastCsv).then(function (ok) {
      setStatus(ok ? '已复制 CSV 到剪贴板，去 PWA 点「粘贴 CSV」。' : '抓取完成，请点下方「复制 CSV」。');
    });
  }

  function showError(msg) {
    finish();
    els.card.hidden = false;
    setStatus('抓取失败：' + msg, true);
  }

  function doCopy() {
    if (!lastCsv) return;
    copyText(lastCsv).then(function (ok) {
      setStatus(ok ? '已复制 CSV 到剪贴板，去 PWA 点「粘贴 CSV」。' : '复制被浏览器拒绝，请用「下载 CSV」。', !ok);
    });
  }

  function doDownload() {
    if (!lastCsv) return;
    try {
      // 加 BOM，Excel / 数字工具打开不乱码（与 Android 端导出口径一致）
      var blob = new Blob(['\ufeff' + lastCsv], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = lastName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      setStatus('已触发下载，可在「文件 → 下载」中分享到 iPhone 的 PWA。');
    } catch (e) {
      setStatus('下载失败：' + String(e && e.message ? e.message : e), true);
    }
  }

  function copyText(text) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(
          function () { resolve(true); },
          function () { resolve(fallbackCopy(text)); }
        );
        return;
      }
      resolve(fallbackCopy(text));
    });
  }

  function fallbackCopy(text) {
    var ta;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) {
      if (ta && ta.parentNode) ta.remove();
      return false;
    }
  }

  /* ============================ 桥接 ============================ */

  // extract.js 只会在调用时读取 window.DyBridge，因此先挂桥再注入脚本也安全
  if (!window.DyBridge) {
    window.DyBridge = {
      onLog: function (msg) {
        ensureUI();
        els.card.hidden = false;
        setStatus(String(msg || ''));
      },
      onError: function (msg) {
        ensureUI();
        showError(String(msg || '未知错误'));
      },
      onResult: function (json) {
        var res = null;
        try { res = JSON.parse(json); } catch (e) { res = null; }
        ensureUI();
        els.card.hidden = false;
        showResult(res);
      }
    };
  }

  // 页面是 SPA，body 可能还没就绪；同时兼容脚本晚注入的情况
  function boot() {
    if (!document.body) {
      setTimeout(boot, 300);
      return;
    }
    ensureUI();
  }

  boot();
})();
