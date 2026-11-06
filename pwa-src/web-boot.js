/*
 * PWA 启动脚本（仅网页版加载，Android WebView 不引用）
 *
 * 网页版没有 Android 的原生能力，因此这里只做以下四件事：
 *   1. 收起 / 改造仅原生端有意义的入口（「返回抓取」「重新分析」），放出「加载示例数据」；
 *   2. 注入 CSV 导入卡片（选择文件 / 粘贴），复用页面已有的 handleFile 解析链路，
 *      不重复实现解析、清洗与评分；
 *   3. 注册 Service Worker，回到前台时检查更新，并给出「添加到主屏幕」提示；
 *   4. 顶栏「iPhone 用法」入口：弹出抓取脚本 + 本应用的详细使用步骤。
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

  /* ============================ iPhone 用法 ============================ */

  const SCRIPT_URL = 'https://yejiawei19991118.github.io/douyin-index-tool/douyin-index-extract.user.js';
  let helpMask = null;

  /* 教程内容：抓取脚本负责「拿数据」，本应用负责「排名分析」，两条数据来源分开写清楚 */
  const HELP_HTML =
    '<div class="pwa-sheet" role="dialog" aria-modal="true" aria-labelledby="pwaHelpTitle">' +
      '<div class="pwa-sheet-head">' +
        '<h2 id="pwaHelpTitle">iPhone 用法</h2>' +
        '<button type="button" class="pwa-sheet-close" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="pwa-sheet-body pwa-help">' +
        '<p class="pwa-lede">抓取脚本负责「拿到数据」，本应用负责「排名分析」。按下面顺序做一遍即可。</p>' +

        '<h3>0. 先添加到主屏幕（只做一次）</h3>' +
        '<ol class="pwa-steps">' +
          '<li>用 Safari 打开本页面（就是现在的这个地址）</li>' +
          '<li>点底部「分享」→「添加到主屏幕」→「添加」</li>' +
          '<li>之后从主屏图标打开：全屏无地址栏，断网也能用</li>' +
        '</ol>' +

        '<h3>1. 安装抓取脚本（只做一次）</h3>' +
        '<ol class="pwa-steps">' +
          '<li>App Store 安装「Userscripts」，再到「设置 → Safari → 扩展」里启用，并允许它访问 creator.douyin.com</li>' +
          '<li>Safari 打开 <a href="' + SCRIPT_URL + '" target="_blank" rel="noopener">抓取脚本安装页</a>，按扩展提示安装</li>' +
        '</ol>' +

        '<h3>2. 抓取并导入（每次分析都走一遍）</h3>' +
        '<ol class="pwa-steps">' +
          '<li>登录抖音创作者中心，打开人群分析页（关键词 / 达人 / 话题 / 视频都可以），等图表加载完成</li>' +
          '<li>点右下角「抓取数据」；期间不要切走页面（脚本会自动滚动并逐个下钻）</li>' +
          '<li>抓完后点「复制 CSV」；被系统拒绝时改用「下载 CSV」</li>' +
          '<li>回到主屏的「抖音指数排名」→ 点「粘贴 CSV」；也可用「选择 CSV 文件」导入「文件」App 里已下载的 CSV</li>' +
        '</ol>' +

        '<h3>3. 离线使用</h3>' +
        '<ol class="pwa-steps">' +
          '<li>首次联网打开后，页面与评分算法会自动缓存</li>' +
          '<li>之后断网也能打开、导入、排名、导出，数据全部留在本机</li>' +
          '<li>只有「抓取」这一步需要联网，它发生在抖音页面，不在本应用内</li>' +
        '</ol>' +

        '<h3>4. 常见问题</h3>' +
        '<ul class="pwa-steps pwa-faq">' +
          '<li>「粘贴 CSV」没反应：剪贴板权限被拒或应用不在前台，改用「选择 CSV 文件」</li>' +
          '<li>一直显示「尚未导入数据」：还没导入成功，可先点「加载示例数据」验证页面正常</li>' +
          '<li>抓取结果为空：图表没加载完或不在人群分析页，刷新后等图表渲染完再抓</li>' +
          '<li>找不到「抓取数据」按钮：确认脚本已安装并刷新页面；抖音改版也可能让采集失效</li>' +
        '</ul>' +

        '<p class="tip">抓取脚本依赖抖音页面结构（CSS Modules 类名、canvas tooltip），平台改版可能失效；' +
          '高频抓取有账号风控风险，请控制频率并自行评估合规性。</p>' +
      '</div>' +
    '</div>';

  function mountHelpButton() {
    const right = document.querySelector('.topbar-right');
    if (!right) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ghost sm';
    btn.id = 'pwaHelpBtn';
    btn.textContent = 'iPhone 用法';
    const collapse = byId('collapseBtn');
    if (collapse && collapse.parentNode === right) right.insertBefore(btn, collapse);
    else right.appendChild(btn);
    btn.addEventListener('click', openHelp);
  }

  function buildHelp() {
    helpMask = document.createElement('div');
    helpMask.className = 'pwa-mask';
    helpMask.innerHTML = HELP_HTML;
    document.body.appendChild(helpMask);

    const close = helpMask.querySelector('.pwa-sheet-close');
    if (close) close.addEventListener('click', closeHelp);
    // 点遮罩空白处关闭；点面板内部不关闭
    helpMask.addEventListener('click', function (e) {
      if (e.target === helpMask) closeHelp();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && helpMask && !helpMask.hidden) closeHelp();
    });
  }

  function openHelp() {
    if (!helpMask) buildHelp();
    helpMask.hidden = false;
    document.body.classList.add('pwa-help-open');
    const close = helpMask.querySelector('.pwa-sheet-close');
    if (close) close.focus();
  }

  function closeHelp() {
    if (!helpMask) return;
    helpMask.hidden = true;
    document.body.classList.remove('pwa-help-open');
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
      empty.textContent = '尚未导入数据：点「粘贴 CSV」或「选择 CSV 文件」导入数据，也可先「加载示例数据」查看效果。';
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
        '<span>本页不能直接抓取：先在创作者中心用抓取脚本取数（右上角「iPhone 用法」有详细步骤），再「粘贴 CSV」；也可先加载示例数据。</span>' +
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
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        // 每次回到前台检查一次更新（限频 10 分钟）：发布后无需用户手动清缓存
        let lastCheck = 0;
        function checkUpdate() {
          if (document.visibilityState !== 'visible') return;
          const now = Date.now();
          if (now - lastCheck < 10 * 60 * 1000) return;
          lastCheck = now;
          reg.update().catch(function () { /* 离线时忽略 */ });
        }
        document.addEventListener('visibilitychange', checkUpdate);
        setTimeout(checkUpdate, 60 * 1000);  // 打开 1 分钟后补一次，避免与首屏争带宽
      }).catch(function (e) {
        console.warn('[PWA] Service Worker 注册失败：', e);
      });
    });
  }

  /* ============================ 启动 ============================ */

  adaptNativeOnlyUI();
  mountHelpButton();
  mountInstallHint();
  mountImportCard();
  // 折叠态会同时藏起导入卡片与「当前关键词」标签，网页端默认展开
  if (typeof window.setCollapsed === 'function') window.setCollapsed(false);
  registerServiceWorker();
})();
