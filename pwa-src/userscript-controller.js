/*
 * 用户脚本控制器（网页版抓取入口）
 *
 * 运行位置：creator.douyin.com 页面内（Userscripts / 篡改猴），属同源脚本，
 * 因此可以直接调用页面 DOM 与共享的 extract.js —— 这是网页端唯一可行的抓取方式。
 *
 * 职责：
 *   1. 提供 window.DyBridge 的网页版实现（extract.js 通过它回传日志/结果/错误）；
 *   2. 右下角浮动按钮「抓取数据」→ 调 window.__dyRun()（extract.js 导出）；
 *   3. 抓取完成后给出「复制 CSV / 下载 CSV / 打开排名页」，把 CSV 交给 PWA 导入。
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
    '</style>' +
    '<div class="wrap">' +
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
    els.close = root.querySelector('.close');

    els.fab.addEventListener('click', run);
    els.close.addEventListener('click', function () { els.card.hidden = true; });

    root.querySelectorAll('.actions .btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-act');
        if (act === 'copy') doCopy();
        else if (act === 'download') doDownload();
        else if (act === 'open') window.open(PWA_URL, '_blank');
      });
    });
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
