/*
 * PWA 启动脚本（仅网页版加载，Android WebView 不引用）
 *
 * 网页版没有 Android 的原生能力，因此这里只做三件事：
 *   1. 收起 / 改造仅原生端有意义的入口（「返回抓取」「重新分析」），放出「加载示例数据」；
 *   2. 注入 CSV 导入卡片（选择文件 / 粘贴），复用页面已有的 handleFile 解析链路，
 *      不重复实现解析、清洗与评分；
 *   3. 注册 Service Worker 并给出「添加到主屏幕」提示。
 *
 * 依赖：ranking.html 内联脚本里的全局函数 handleFile / setCollapsed / showToast。
 */
(function () {
  'use strict';

  const INSTALL_HINT_KEY = 'dyrank.pwa.installHint';

  const isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  function byId(id) { return document.getElementById(id); }

  function toast(msg) {
    if (typeof window.showToast === 'function') window.showToast(msg);
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ============================ 入口改造 ============================ */

  function adaptNativeOnlyUI() {
    // 「返回抓取」依赖原生桥关闭 Activity，网页版没有抓取页可回
    const back = byId('backBtn');
    if (back) back.hidden = true;
    // 「重新分析」只是对同一份数据重跑，导入后无意义，隐藏以减少按钮占位
    const reanalyze = byId('reanalyzeBtn');
    if (reanalyze) reanalyze.hidden = true;
    // 网页版没有可用数据来源，放出示例数据入口便于先看效果
    const sample = byId('sampleBtn');
    if (sample) sample.hidden = false;

    document.title = '抖音指数综合排名（PWA）';

    // 首页空状态文案：原生端会自动载入，网页端需要明确引导导入
    const empty = byId('emptyState');
    if (empty && !hasLoadedData()) {
      empty.textContent = '尚未导入数据：点「选择 CSV 文件」导入安卓 App 导出的 CSV，或先「加载示例数据」查看效果。';
    }
  }

  function hasLoadedData() {
    try {
      return typeof state !== 'undefined' && state && state.file;
    } catch (e) {
      return false;
    }
  }

  /* ============================ 导入入口 ============================ */

  function mountImportCard() {
    const row = document.querySelector('#controlBody .btn-row') || document.querySelector('.btn-row');
    if (!row) return;

    const card = document.createElement('div');
    card.className = 'upload-card pwa-import';
    card.id = 'pwaImportCard';
    card.innerHTML =
      '<div class="upload-main">' +
        '<strong>导入人群分析 CSV</strong>' +
        '<span>网页版无法进入抖音后台自动抓取：请在安卓 App 抓取后导出 CSV，再在此导入（也可先加载示例数据）。</span>' +
      '</div>' +
      '<div class="upload-actions">' +
        '<button type="button" class="btn primary" id="pwaPickBtn">选择 CSV 文件</button>' +
        '<button type="button" class="btn" id="pwaPasteBtn">粘贴 CSV</button>' +
        '<span class="file-pill" id="pwaFileName" hidden></span>' +
      '</div>';
    row.parentNode.insertBefore(card, row);

    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'pwaFileInput';
    input.accept = '.csv,text/csv,text/plain,.json,application/json';
    input.hidden = true;
    card.appendChild(input);

    const pickBtn = byId('pwaPickBtn');
    if (pickBtn) {
      pickBtn.addEventListener('click', function () {
        // 必须在用户手势内触发，iOS Safari 才允许打开文件选择器
        input.click();
      });
    }

    input.addEventListener('change', function () {
      const file = input.files && input.files[0];
      input.value = '';  // 清空后才能重复选择同一个文件
      if (file) importFile(file);
    });

    // 桌面端顺手支持拖拽（iPhone 上无拖拽，不影响）
    ['dragenter', 'dragover'].forEach(function (type) {
      card.addEventListener(type, function (e) {
        e.preventDefault();
        card.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      card.addEventListener(type, function (e) {
        e.preventDefault();
        card.classList.remove('drag');
      });
    });
    card.addEventListener('drop', function (e) {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) importFile(file);
    });

    const pasteBtn = byId('pwaPasteBtn');
    if (pasteBtn) pasteBtn.addEventListener('click', importFromClipboard);
  }

  async function importFile(file) {
    const pill = byId('pwaFileName');
    if (pill) {
      pill.textContent = (file.name || 'CSV') + (file.size ? ' · ' + formatSize(file.size) : '');
      pill.hidden = false;
    }
    if (typeof window.handleFile !== 'function') {
      toast('页面尚未就绪，请稍后重试');
      return;
    }
    try {
      // 复用页面内置的解析链路：编码校验 → 格式识别 → 清洗 → 评分 → 渲染
      await window.handleFile(file);
    } catch (e) {
      toast('导入失败：' + (e && e.message ? e.message : e));
      return;
    }
    const exportBtn = byId('exportBtn');
    if (exportBtn && !exportBtn.disabled) toast('导入完成');
  }

  async function importFromClipboard() {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      toast('当前浏览器不支持读取剪贴板，请改用「选择 CSV 文件」');
      return;
    }
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      toast('读取剪贴板被拒绝，请改用「选择 CSV 文件」');
      return;
    }
    text = String(text || '').trim();
    if (!text) {
      toast('剪贴板为空');
      return;
    }
    try {
      // 包成 File 走同一条导入链路，保持编码校验与错误提示一致
      const file = new File([text], '剪贴板导入.csv', { type: 'text/csv' });
      await importFile(file);
    } catch (e) {
      // 极旧浏览器不支持 File 构造器时，退回直接灌入 CSV 文本
      if (typeof window.loadFromCsv === 'function') window.loadFromCsv(text, '剪贴板导入', '');
    }
  }

  /* ============================ 安装提示 ============================ */

  function mountInstallHint() {
    if (isStandalone) return;  // 已全屏打开，无需再提示
    try {
      if (localStorage.getItem(INSTALL_HINT_KEY) === '1') return;
    } catch (e) { /* 隐私模式下 localStorage 不可用，直接展示 */ }

    const body = byId('controlBody');
    if (!body) return;

    const hint = document.createElement('div');
    hint.className = 'pwa-hint';
    hint.innerHTML =
      '<span>' + (isIOS
        ? '可添加到主屏幕：点 Safari 底部「分享」→「添加到主屏幕」，之后全屏打开、断网也能用。'
        : '可安装到桌面：在浏览器菜单中选择「安装应用」或「添加到主屏幕」，之后全屏打开、断网也能用。') +
      '</span>' +
      '<button type="button" class="pwa-hint-close" aria-label="关闭提示">×</button>';
    body.insertBefore(hint, body.firstChild);

    const close = hint.querySelector('.pwa-hint-close');
    if (close) {
      close.addEventListener('click', function () {
        hint.remove();
        try { localStorage.setItem(INSTALL_HINT_KEY, '1'); } catch (e) { /* ignore */ }
      });
    }
  }

  /* ============================ Service Worker ============================ */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // 本地 file:// 调试不注册；改为 http(s) 后才生效
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('[PWA] Service Worker 注册失败：', e);
      });
    });
  }

  /* ============================ 启动 ============================ */

  adaptNativeOnlyUI();
  mountInstallHint();
  mountImportCard();
  // 折叠态会同时藏起导入卡片与「当前关键词」标签，网页端默认展开
  if (typeof window.setCollapsed === 'function') window.setCollapsed(false);
  registerServiceWorker();
})();
