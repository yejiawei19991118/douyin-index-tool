/*
 * 抖音指数「人群分析」自动提取脚本（注入到 creator.douyin.com 页面内运行）。
 *
 * 支持四种页型（detectPage 按 URL 识别）：
 *   关键词 /analysis?keyword=… 、话题 /analysis?topic=…（结构相同：地域/年龄/性别/内容浏览）
 *   达人   /daren/detail?uid=…（粉丝分析：地域/年龄/性别/手机品牌/手机价格，无内容浏览）
 *   视频   /videoanalysis?id=…（观众分析：地域/年龄/性别/内容浏览）
 * 区块按页面实际存在探测，不硬编码清单；缺失区块自动跳过。
 *
 * 数据来源分两类：
 *   1) DOM 文本：地域「省份/城市级别/城市」表格、性别分布
 *   2) canvas 图表：图表用 canvas 绘制，具体数值只在鼠标悬停 tooltip 里出现，
 *      故对每个图表容器沿 x 轴（多行 y）派发合成 mousemove 事件，读取其「兄弟节点」tooltip 文本。
 *
 * 结果通过 window.DyBridge.onResult(json) 回传给原生侧。
 * 本脚本可重复执行：window.__dyRun() 由原生侧「开始抓取」按钮手动触发；
 * 注入后 watcher 只负责探测页面就绪状态并回传提示，不会自动跑。
 */
(function () {
  if (window.__dyInjected) return;
  window.__dyInjected = true;

  var TITLES = ['地域分布', '年龄分布', '性别分布', '用户内容浏览分布', '手机品牌分布', '手机价格分布'];
  // 地域维度以「城市」为主：先切到城市再依次抓，结果对象按此顺序插入，
  // buildCsv 里 Object.keys 也就会让 CSV 先输出「城市」再「城市级别」「省份」。
  var REGION_TABS = ['城市', '城市级别', '省份'];
  // 性别区块容器内的文本（供诊断快照回传）。
  var lastGenderBoxText = '';
  // 用户内容浏览分布区的采集概况（主标签数 / 成功下钻数 / 采集行数），供诊断快照回传。
  var lastBrowsingTabs = '';

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function bridge(name, payload) {
    try {
      if (window.DyBridge && typeof window.DyBridge[name] === 'function') {
        window.DyBridge[name](payload);
      }
    } catch (e) { /* 原生桥不可用时静默忽略（例如在桌面浏览器里调试） */ }
  }

  // ---------- 区块标题定位 ----------
  // 用 TreeWalker 只扫「文本节点」：标题文字本身所在的文本节点就是「地域分布」这类纯文字，
  // 而它的父元素往往还包着 tooltip 图标 / 统计口径说明等兄弟节点，textContent 会超出长度阈值——
  // 旧实现「扫所有元素再判 textContent 长度」正是因此漏掉全部标题（本次 bug 的根因）。
  function findTitleMarks() {
    var marks = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var s = (node.nodeValue || '').replace(/\s+/g, '');
      if (!s || s.length > 20) continue;
      for (var t = 0; t < TITLES.length; t++) {
        if (s.indexOf(TITLES[t]) < 0) continue;
        var el = node.parentElement;
        if (el) {
          var r;
          try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
          if (r && (r.width > 0 || r.height > 0)) {
            marks.push({ t: TITLES[t], top: r.top, cx: r.left + r.width / 2 });
          }
        }
        break;
      }
    }
    return marks;
  }

  // 取「位于图表上方的最近标题」。年龄分布与性别分布是左右并排的两个卡片，
  // 两者标题 top 几乎相同，故同高时再用「水平中心距离」择优，避免把年龄图表误判成性别。
  function sectionFor(el, marks) {
    var er = el.getBoundingClientRect();
    var et = er.top + 2;
    var ecx = er.left + er.width / 2;
    var best = null, bt = -1e9, bd = Infinity;
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (m.top > et) continue;                       // 只看图表上方的标题
      var d = Math.abs(m.cx - ecx);
      var higher = m.top > bt + 2;                    // 明显更高的标题优先
      var sameLevelCloser = Math.abs(m.top - bt) <= 2 && d < bd;
      if (higher || sameLevelCloser) {
        if (higher) bt = m.top;
        bd = d;
        best = m.t;
      }
    }
    return best;
  }

  // 收集页面上所有 lightcharts 图表（canvas + 其对应的 tooltip 兄弟节点 + 所属区块）
  function getCharts() {
    var marks = findTitleMarks();
    var out = [];
    var cs = document.querySelectorAll('.lightcharts-container');
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      var holder = c.parentElement;
      var tip = holder ? holder.querySelector('.lightcharts-tooltip') : null;
      var canvas = c.querySelector('canvas');
      if (!canvas) continue;
      out.push({ section: sectionFor(c, marks), canvas: canvas, tip: tip });
    }
    // 标题定位不完整时的兜底：按图表「出现顺序」逐个补（地域 → 年龄 → 兴趣）。
    // 注意是「逐个补」而不是「全都没识别上才补」——真实页面里常常只有部分标题能定位，
    // 若坚持整体兜底，已识别的那一个之外的图表会全部采不到（本次 bug 的另一半根因）。
    // 已被真实标题占用的区块名不再重复分配，避免两个图表映射到同一区块。
    var fallback = ['地域分布', '年龄分布', '用户内容浏览分布'];
    var used = {};
    for (var u = 0; u < out.length; u++) if (out[u].section) used[out[u].section] = 1;
    for (var k = 0; k < out.length && k < fallback.length; k++) {
      if (out[k].section || used[fallback[k]]) continue;
      out[k].section = fallback[k];
      used[fallback[k]] = 1;
    }
    return out;
  }

  function findChartIn(charts, section) {
    for (var i = 0; i < charts.length; i++) if (charts[i].section === section) return charts[i];
    return null;
  }

  // ---------- tooltip 文本解析 ----------

  // 形如「时尚\n占比\n14.26%\nTGI\n125.72\n点击查看兴趣详情」或「潍坊\t占比\t0.68%\tTGI\t111.00」
  function parseTip(raw) {
    if (!raw) return null;
    var s = String(raw).replace(/\s+/g, '').replace(/点击查看兴趣详情/g, '');
    var m = s.match(/^(.*?)占比(\d+(?:\.\d+)?)%TGI(\d+(?:\.\d+)?)$/);
    if (m) return { name: m[1], ratio: m[2] + '%', tgi: m[3] };
    m = s.match(/^(.*?)占比(\d+(?:\.\d+)?)%TGI(\d+(?:\.\d+)?)/);
    if (m) return { name: m[1], ratio: m[2] + '%', tgi: m[3] };
    // 手机分布等图表的 tooltip 可能没有 TGI：只有占比的形态也收（TGI 留空）。
    m = s.match(/^(.*?)占比(\d+(?:\.\d+)?)%$/);
    if (m) return { name: m[1], ratio: m[2] + '%', tgi: '' };
    return null;
  }

  // ---------- canvas 扫描 ----------

  async function scanCanvas(chart) {
    var pts = [], seen = {};
    if (!chart || !chart.canvas || !chart.tip) return pts;
    var canvas = chart.canvas, tip = chart.tip;
    var r;
    try { r = canvas.getBoundingClientRect(); } catch (e) { return pts; }
    if (!r || r.width < 2 || r.height < 2) return pts;
    var ys = [0.25, 0.5, 0.75];
    for (var yi = 0; yi < ys.length; yi++) {
      var y = r.top + r.height * ys[yi];
      for (var i = 1; i <= 70; i++) {
        var x = r.left + r.width * (i / 71);
        try {
          canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
          canvas.dispatchEvent(new MouseEvent('mouseover', { clientX: x, clientY: y, bubbles: true }));
          if (window.PointerEvent) {
            canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
          }
        } catch (e) { /* 合成事件失败则跳过该点 */ }
        await sleep(15);
        var disp;
        try { disp = getComputedStyle(tip).display; } catch (e) { disp = 'none'; }
        if (disp !== 'none' && (tip.innerText || '').trim()) {
          var it = parseTip(tip.innerText);
          if (it && !seen[it.name]) { seen[it.name] = 1; pts.push(it); }
        }
      }
    }
    return pts;
  }

  // ---------- 地域表格（省份/城市级别/城市）----------

  function parseRegionTable(lines) {
    var start = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '排名') { start = i; break; }
    }
    if (start < 0) return [];
    var j = start + 1;
    var headers = ['省份', '城市级别', '城市', '分布占比', 'TGI指数', '占比', 'TGI'];
    while (j < lines.length && headers.indexOf(lines[j].trim()) >= 0) j++;
    var rows = [];
    while (j + 3 < lines.length) {
      var rank = lines[j].trim(), name = lines[j + 1].trim(),
          ratio = lines[j + 2].trim(), tgi = lines[j + 3].trim();
      if (!/^\d+$/.test(rank)) break;
      if (!/%$/.test(ratio)) break;
      rows.push({ name: name, ratio: ratio, tgi: tgi });
      j += 4;
    }
    return rows;
  }

  async function clickTab(label) {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].textContent || '').trim() === label) {
        try { btns[i].click(); } catch (e) { return false; }
        await sleep(1400);
        return true;
      }
    }
    return false;
  }

  async function extractRegion() {
    var result = {};
    for (var t = 0; t < REGION_TABS.length; t++) {
      var tab = REGION_TABS[t];
      await clickTab(tab); // 点不动也继续按当前视图尝试
      await sleep(900);
      var rows = parseRegionTable(document.body.innerText.split('\n'));
      if (!rows.length) {
        // 表格不存在（城市维度是图表）→ 重新查询图表引用后扫描
        var chart = findChartIn(getCharts(), '地域分布');
        if (chart) rows = await scanCanvas(chart);
      }
      if (rows.length) result[tab] = rows;
    }
    if (!Object.keys(result).length) {
      var rows2 = parseRegionTable(document.body.innerText.split('\n'));
      if (rows2.length) result['当前视图'] = rows2;
    }
    return result;
  }

  // ---------- 通用区块（手机品牌 / 手机价格等）----------

  // 诊断辅助：把某区块标题附近（向上 3 层祖先）的叶子节点文本 dump 出来，
  // 用于定位「为什么 extractGender / extractGeneric 返回空数组」。
  function dumpNearTitle(title) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node, label = null;
    while ((node = walker.nextNode())) {
      var s = (node.nodeValue || '').replace(/\s+/g, '');
      if (!s || s.length > 20) continue;
      if (s.indexOf(title) >= 0 && node.parentElement) { label = node.parentElement; break; }
    }
    if (!label) return { found: false };
    var boxes = [];
    var cur = label;
    for (var up = 0; cur && cur !== document.body && up < 4; up++) {
      var all = cur.querySelectorAll('*');
      var lines = [];
      for (var i = 0; i < all.length; i++) {
        var t = (all[i].innerText || '').trim();
        if (t && t.length < 400) {
          var isLeaf = !all[i].querySelector('*');
          lines.push((isLeaf ? '[L] ' : '[C] ') + t.replace(/\s+/g, ' ').slice(0, 200));
        }
      }
      boxes.push({ up: up, tag: cur.tagName, cls: String(cur.className).slice(0, 80), sample: lines.slice(0, 15) });
      cur = cur.parentElement;
    }
    var best = boxes[0]; var bestLen = 0;
    for (var u = 0; u < boxes.length; u++) {
      var len = boxes[u].sample.join('\n').length;
      if (len > bestLen) { bestLen = len; best = boxes[u]; }
    }
    return {
      found: true,
      labelTag: label.tagName,
      labelCls: String(label.className).slice(0, 80),
      fullText: (label.innerText || '').slice(0, 800),
      bestContainer: best
    };
  }

  // 把图表 canvas 上的 tooltip 直接读一遍（y=0.3 扫一遍 x，不做下钻），
  // 用于诊断手机分布等区块 canvas tooltip 是否真有数据。
  async function probeCanvasTip(chartName) {
    var chart = findChartIn(getCharts(), chartName);
    if (!chart) return { found: false, reason: 'no chart in getCharts()' };
    if (!chart.canvas) return { found: false, reason: 'no canvas' };
    if (!chart.tip) return { found: false, reason: 'no tooltip element' };
    var r;
    try { r = chart.canvas.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r || r.width < 2) return { found: false, reason: 'canvas too small' };
    var y = r.top + r.height * 0.3;
    var samples = []; var seen = {};
    for (var i = 1; i <= 30; i++) {
      var xf = i / 31;
      var x = r.left + r.width * xf;
      try { chart.canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true })); } catch (e) { /* 忽略 */ }
      await sleep(12);
      var txt = '';
      try { txt = (chart.tip.innerText || '').trim(); } catch (e) { txt = ''; }
      if (txt && !seen[txt]) { seen[txt] = 1; samples.push({ xf: xf.toFixed(2), text: txt.slice(0, 120) }); }
    }
    return { found: true, rect: { w: Math.round(r.width), h: Math.round(r.height) }, samples: samples.slice(0, 10) };
  }

  function hasTitle(marks, name) {
    for (var i = 0; i < marks.length; i++) if (marks[i].t === name) return true;
    return false;
  }

  // 只含 DOM 表格（无 canvas）的区块兜底：
  // ① 从标题向上找到「同时包含标题文本和 canvas 图表」的最近祖先——
  //    这样锁定在本区块根节点，不会把上方地域分布的表格误当成手机分布。
  // ② 在该容器内找「含排名 + TGI 表头」的表格，按四列结构解析。
  function parseTableNear(title) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node, label = null;
    while ((node = walker.nextNode())) {
      var s = (node.nodeValue || '').replace(/\s+/g, '');
      if (!s || s.length > 20) continue;
      if (s.indexOf(title) >= 0 && node.parentElement) { label = node.parentElement; break; }
    }
    if (!label) return [];

    // 锁定本区块根：含 canvas 且标题在容器内。
    var root = label, depth = 0;
    while (root && root !== document.body && depth < 8) {
      if (root.querySelector('.lightcharts-container canvas')) break;
      root = root.parentElement;
      depth++;
    }

    // 在 root 范围内向上找含 排名+TGI 表头的容器。
    var cur = root; depth = 0;
    while (cur && cur !== document.body && depth < 4) {
      var txt = cur.innerText || '';
      if (txt.indexOf('排名') >= 0 && txt.indexOf('TGI') >= 0) {
        var rows = parseRegionTable(txt.split('\n'));
        if (rows.length) return rows;
      }
      cur = cur.parentElement;
      depth++;
    }
    return [];
  }

  // 手机分布区块：优先 canvas 扫描（与年龄分布同一渲染组件），空则退 DOM 表格；
  // 标题不在场（非达人页）直接返回空，不浪费扫描时间。
  async function extractGeneric(charts, marks, title) {
    var chart = findChartIn(charts, title);
    if (chart) {
      var pts = await scanCanvas(chart);
      if (pts.length) return pts;
    }
    if (!hasTitle(marks, title)) return [];
    return parseTableNear(title);
  }

  // ---------- 性别分布 ----------
  // 性别区块是 DOM 文本（无 canvas）。旧实现用「整页行数组里 indexOf('女性')」定位标签，
  // 会命中页面别处的同名字样，于是把「女性」错读成了男性的 48%/91。
  // 现改为三步：① 找承载「男性 / 女性」的短文本元素 → ② 取两者最小公共祖先作为
  // 「性别区块容器」→ ③ 只在该容器文本内解析，彻底隔离其它区块的串扰。

  // 取两个节点的最小公共祖先（用于把解析范围收窄到性别卡片内部）。
  function nearestCommon(a, b) {
    var chain = [];
    for (var x = a; x; x = x.parentElement) chain.push(x);
    for (var y = b; y; y = y.parentElement) {
      if (chain.indexOf(y) >= 0) return y;
    }
    return document.body;
  }

  function extractGender() {
    // 先找「性别分布」标题，从它向上找一个足够大的容器：
    // 容器要么含 canvas（关键词页），要么同时出现「男性」「女性」和「占比 X%」数字（达人页）。
    // 这样避开介绍文案被拆成短 span 导致 nearestCommon 只覆盖介绍文案的问题。
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node, titleEl = null;
    while ((node = walker.nextNode())) {
      var s = (node.nodeValue || '').replace(/\s+/g, '');
      if (!s || s.length > 20) continue;
      if (s === '性别分布' && node.parentElement) { titleEl = node.parentElement; break; }
    }
    var box = titleEl;
    if (box) {
      // 向上找：直到容器里有 canvas 或有 男性+女性+占比数字 三个特征同时出现。
      var cur = titleEl, depth = 0;
      while (cur && cur !== document.body && depth < 10) {
        var flatTest = (cur.innerText || '').replace(/\s+/g, '');
        var hasCanvas = cur.querySelector('.lightcharts-container canvas') != null;
        var hasBothGender = flatTest.indexOf('男性') >= 0 && flatTest.indexOf('女性') >= 0;
        var hasRatio = /占比\d+(?:\.\d+)?%/.test(flatTest);
        if (hasCanvas || (hasBothGender && hasRatio)) break;
        cur = cur.parentElement;
        depth++;
      }
      box = cur;
    } else {
      // 退回旧的 nearestCommon 定位（关键词页介绍文案是整句不拆 span，不会误命中）。
      var mLab = null, fLab = null;
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        var st = (e.textContent || '').replace(/\s+/g, '');
        if (!st || st.length > 10) continue;
        if (!mLab && st.indexOf('男性') >= 0) mLab = e;
        if (!fLab && st.indexOf('女性') >= 0) fLab = e;
        if (mLab && fLab) break;
      }
      box = (mLab && fLab) ? nearestCommon(mLab, fLab) : document.body;
    }

    // 容器内压平文本，按正则解析。
    var flat = ((box && box.innerText) || '').replace(/\s+/g, '');
    if (!flat) flat = (document.body.innerText || '').replace(/\s+/g, '');
    lastGenderBoxText = flat.slice(0, 300);

    var out = [];
    // 紧邻正则（关键词/达人页压平后都能匹配）
    var m = flat.match(/男性占比(\d+(?:\.\d+)?)%TGI(\d+(?:\.\d+)?)/);
    var f = flat.match(/女性占比(\d+(?:\.\d+)?)%TGI(\d+(?:\.\d+)?)/);
    // 宽松正则（万一压平没彻底，带可选空格）
    if (!m) m = flat.match(/男性\s*占比\s*(\d+(?:\.\d+)?)\s*%\s*TGI\s*(\d+(?:\.\d+)?)/);
    if (!f) f = flat.match(/女性\s*占比\s*(\d+(?:\.\d+)?)\s*%\s*TGI\s*(\d+(?:\.\d+)?)/);
    if (m) out.push({ name: '男性', ratio: m[1] + '%', tgi: m[2] });
    if (f) out.push({ name: '女性', ratio: f[1] + '%', tgi: f[2] });

    // 兜底：按行结构解析，过滤掉介绍文案行。
    if (!out.length) {
      var lines = (((box && box.innerText) || document.body.innerText || ''))
          .split('\n').map(function (t) { return t.trim(); });
      var dataLines = [];
      for (var li = 0; li < lines.length; li++) {
        var ln = lines[li];
        if (!ln) continue;
        if (/指数|偏好度|最高|最低/.test(ln) && !/\d+(?:\.\d+)?%/.test(ln)) continue;
        dataLines.push(ln);
      }
      var names = ['男性', '女性'];
      for (var k = 0; k < names.length; k++) {
        var idx = -1;
        for (var d = 0; d < dataLines.length; d++) {
          if (dataLines[d].indexOf(names[k]) === 0) { idx = d; break; }
        }
        if (idx < 0) continue;
        var ratio = null, tgi = null;
        for (var j = idx; j < Math.min(dataLines.length, idx + 6); j++) {
          var t = dataLines[j];
          if (!ratio && /占比.*?(\d+(?:\.\d+)?)%/.test(t)) {
            var rm = t.match(/占比.*?(\d+(?:\.\d+)?)%/);
            if (rm) ratio = rm[1] + '%';
          }
          if (ratio == null && /^(\d+(?:\.\d+)?)%$/.test(t)) ratio = t;
          if (tgi == null && /^(\d+(?:\.\d+)?)$/.test(t)) tgi = t;
        }
        if (ratio || tgi) out.push({ name: names[k], ratio: ratio || '', tgi: tgi || '' });
      }
    }
    return out;
  }

  // ---------- 用户内容浏览分布（主标签 → 子标签，柱状图点击下钻）----------
  // 实机排查结论：该区块**不是页签结构，而是柱状图**——主标签就是柱子（x 轴类别），
  // 子标签必须「点击柱子」下钻后才会出现，页面 DOM 里没有预渲染。
  // 例：点击「时尚」→ 子层出现 时尚_穿搭 / 时尚_美妆 / 时尚_美发 / 时尚_美容。
  // 下钻后区块内出现可点击的「返回上一级」，点它回到主层，再点下一个主标签。
  //
  // 三个实机约束（均已在真机验证）：
  //   ① tooltip 按 x 邻近命中，故「读」只需一行 y 扫 x，不必多行；
  //   ② 点击必须落在柱体上：柱底基线约在 canvas 高度的 0.83 处，故点击 y 取 0.80；
  //      取 0.88 会落到坐标轴下方，点了没反应；
  //   ③ tooltip 不会自动消失，最左侧 y 轴空白区会读到上一次的残留值。
  //      对策：同名以「最后一次出现」的 xf 为准（残留只在最左，会被真实柱体覆盖），
  //      子层再用「主标签_」前缀过滤兜底。

  function rectOf(el) { try { return el.getBoundingClientRect(); } catch (e) { return null; } }

  function isVisible(el) {
    try {
      var st = getComputedStyle(el);
      if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0)) return false;
    } catch (e) { /* 取不到样式时按可见处理 */ }
    var r = rectOf(el);
    return !r || r.width > 0 || r.height > 0;
  }

  // 区块容器：从标题纯文本节点向上找「最低的、含图表 canvas 的祖先」，最多上溯 8 层。
  function sectionRoot(title) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node, label = null;
    while ((node = walker.nextNode())) {
      var s = (node.nodeValue || '').replace(/\s+/g, '');
      if (!s || s.length > 20) continue;
      if (s.indexOf(title) >= 0 && node.parentElement) { label = node.parentElement; break; }
    }
    if (!label) return null;
    var cur = label, depth = 0;
    while (cur && cur !== document.body && depth < 8) {
      if (cur.querySelector && cur.querySelector('.lightcharts-container canvas')) return cur;
      cur = cur.parentElement;
      depth++;
    }
    return label.parentElement || label;
  }

  // 从区块容器再向上找「含『返回上一级』的那层容器」。该按钮在下钻后出现，
  // 主层时也在 DOM 里（宽 0 不可见），故按文本上溯即可。
  function drillHost(root) {
    var cur = root, depth = 0;
    while (cur && cur !== document.body && depth < 8) {
      if ((cur.textContent || '').indexOf('返回上一级') >= 0) return cur;
      cur = cur.parentElement;
      depth++;
    }
    return root || document.body;
  }

  // 取区块当前图表的 canvas 与 tooltip（下钻会重绘，故一律现取现用）。
  function browsingChart(title) {
    var root = sectionRoot(title);
    var c = root && root.querySelector('.lightcharts-container');
    if (!c) return null;
    var holder = c.parentElement;
    var canvas = c.querySelector('canvas');
    var tip = holder ? holder.querySelector('.lightcharts-tooltip') : null;
    if (!canvas || !tip) return null;
    return { section: title, canvas: canvas, tip: tip, root: root };
  }

  function chartStale(ch) {
    return !ch || !ch.canvas || !ch.canvas.isConnected || !ch.tip;
  }

  // 区块内可见的「返回上一级」叶子元素（主层时它在 DOM 里但不可见，故必须按可见性过滤）。
  function backButton(host) {
    var all = (host || document).querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.children.length) continue;
      if ((e.textContent || '').indexOf('返回上一级') < 0) continue;
      if (!isVisible(e)) continue;
      return e;
    }
    return null;
  }

  // 在 canvas 上补发按下 / 抬起 / 点击（模拟真实鼠标），用于把柱体「点开」下钻。
  async function clickChart(canvas, r, xf, yf) {
    var x = r.left + r.width * xf, y = r.top + r.height * yf;
    try {
      canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
    } catch (e) { return false; }
    await sleep(1300);
    return true;
  }

  // 单行（yFrac）扫 x：tooltip 按 x 邻近命中，一行即可覆盖全部柱子。
  // 同名以「最后一次出现」的 xf 为准：最左侧 y 轴空白区会读到残留 tooltip，
  // 而残留只出现在最前，之后一定会被真实柱体覆盖，故取最后位置即可自动校正。
  async function sweepBars(chart, steps, yFrac) {
    var order = [], idx = {};
    if (chartStale(chart)) return order;
    var canvas = chart.canvas, tip = chart.tip;
    var r = rectOf(canvas);
    if (!r || r.width < 2 || r.height < 2) return order;
    var y = r.top + r.height * yFrac;
    for (var i = 1; i <= steps; i++) {
      var xf = i / (steps + 1);
      var x = r.left + r.width * xf;
      try {
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
        canvas.dispatchEvent(new MouseEvent('mouseover', { clientX: x, clientY: y, bubbles: true }));
        if (window.PointerEvent) {
          canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
        }
      } catch (e) { /* 合成事件失败则跳过该点 */ }
      await sleep(12);
      var raw = '';
      try { raw = (tip.innerText || '').trim(); } catch (e) { raw = ''; }
      if (!raw) continue;
      var it = parseTip(raw);
      if (!it) continue;
      if (idx[it.name] === undefined) {
        idx[it.name] = order.length;
        it.xf = xf;
        order.push(it);
      } else {
        var prev = order[idx[it.name]];           // 同名「后出现」的位置 / 数值更可信，覆盖之
        prev.xf = xf;
        prev.ratio = it.ratio;
        prev.tgi = it.tgi;
      }
    }
    return order;
  }

  // 扫描区块「当前视图」的图表；每次都重新查询，避免持有切换页签后已失效的引用。
  async function scanSection(title) {
    var chart = findChartIn(getCharts(), title);
    if (!chart) {
      var root = sectionRoot(title);
      var c = root && root.querySelector('.lightcharts-container');
      if (c) {
        var holder = c.parentElement;
        chart = {
          section: title,
          canvas: c.querySelector('canvas'),
          tip: holder ? holder.querySelector('.lightcharts-tooltip') : null
        };
      }
    }
    return chart ? await scanCanvas(chart) : [];
  }

  // 用户内容浏览分布：主层扫出全部主标签 → 逐个点柱体下钻扫子层 → 点「返回上一级」回主层。
  // 返回的是「平铺数组」：先主标签行（如「时尚」），紧接其子标签行（如「时尚_穿搭」），
  // 层级由名字本身表达，故 buildCsv 的数组分支可直接输出，无需额外结构。
  async function extractBrowsing() {
    var title = '用户内容浏览分布';
    var chart = browsingChart(title);
    if (chartStale(chart)) {
      lastBrowsingTabs = '未找到图表容器，退回单层扫描';
      return await scanSection(title);
    }

    // 主层：一行扫 x，拿到全部主标签及其柱体的横向位置。
    var mains = await sweepBars(chart, 60, 0.3);
    if (!mains.length) {
      lastBrowsingTabs = '未扫到主标签柱体，退回单层扫描';
      return await scanSection(title);
    }

    var out = [], seen = {}, drilled = 0;
    for (var k = 0; k < mains.length; k++) {
      var main = mains[k];
      if (chartStale(chart)) chart = browsingChart(title);
      if (chartStale(chart)) break;
      var r = rectOf(chart.canvas);
      if (!r) break;

      await clickChart(chart.canvas, r, main.xf, 0.80);   // 点柱体下钻
      var back = backButton(drillHost(chart.root));
      if (!back) {
        // 没钻进去（点到空白 / 该标签无子层）：仅记录主标签本身，不丢数据。
        if (!seen[main.name]) { seen[main.name] = 1; out.push({ name: main.name, ratio: main.ratio, tgi: main.tgi }); }
        continue;
      }
      drilled++;
      if (!seen[main.name]) { seen[main.name] = 1; out.push({ name: main.name, ratio: main.ratio, tgi: main.tgi }); }

      // 子层：再扫一行；子标签名为「主标签_子标签」，用前缀过滤掉起始处的残留值。
      if (chartStale(chart)) chart = browsingChart(title);
      var subs = chartStale(chart) ? [] : await sweepBars(chart, 40, 0.3);
      var kept = [], pref = main.name + '_';
      for (var s = 0; s < subs.length; s++) {
        if (subs[s].name.indexOf(pref) === 0) kept.push(subs[s]);
      }
      if (!kept.length) kept = subs;                      // 命名规则若变化则兜底
      for (var t = 0; t < kept.length; t++) {
        var it = kept[t];
        if (!it.name || it.name === main.name || seen[it.name]) continue;
        seen[it.name] = 1;
        out.push({ name: it.name, ratio: it.ratio, tgi: it.tgi });
      }

      try { back.click(); } catch (e) { /* 点不动也继续下一个 */ }
      await sleep(1000);                                  // 等图表回到主层再继续
    }

    lastBrowsingTabs = '主标签 ' + mains.length + ' 个，成功下钻 ' + drilled + ' 个，共 ' + out.length + ' 行';
    if (!drilled) {
      var fb = await scanSection(title);
      if (fb.length) { out = fb; lastBrowsingTabs = '下钻失败，退回单层扫描'; }
    }
    return out;
  }

  // ---------- 组装 ----------

  // ---------- 页型识别与页名 ----------

  // 按 URL 识别页型：keyword / topic / daren / video / unknown。
  function detectPage() {
    try {
      var u = new URL(location.href);
      var p = u.pathname || '';
      if (p.indexOf('/daren/detail') >= 0) return 'daren';
      if (p.indexOf('/videoanalysis') >= 0) return 'video';
      if (p.indexOf('/analysis') >= 0) return u.searchParams.get('topic') ? 'topic' : 'keyword';
    } catch (e) { /* 忽略 */ }
    return 'unknown';
  }

  function pageLabel(page) {
    return { keyword: '关键词', topic: '话题', daren: '达人', video: '视频' }[page] || '未知页型';
  }

  // 达人昵称 / 视频标题 / 话题名在 URL 里没有（话题详情页 URL 只有数字 ID），
  // 按「顶部内容区内的短文本叶子」猜测：黑名单滤掉页签/指标/按钮/左侧导航文案，
  // 含标点或纯数字的行也排除，且只认右侧内容区（left >= 12% 视口宽，跳过左侧导航栏）。
  // 猜不中返回空串，原生侧会回退用户输入框里的词（抖音号 / 搜索词），保证文件名可读。
  function guessDisplayName(blacklist, minLen, maxLen, maxTop) {
    var minLeft = (window.innerWidth || 0) * 0.12;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var s = (node.nodeValue || '').trim();
      if (s.length < minLen || s.length > maxLen) continue;
      if (/^\d+$/.test(s) || /[%：:，,。.、/\\]/.test(s)) continue;
      var bad = false;
      for (var i = 0; i < blacklist.length; i++) {
        if (s.indexOf(blacklist[i]) >= 0) { bad = true; break; }
      }
      if (bad) continue;
      var el = node.parentElement;
      if (!el) continue;
      var r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (!r || r.width <= 0 || r.top < 0 || r.top > maxTop || r.left < minLeft) continue;
      return s;
    }
    return '';
  }

  // 作者信息区（头像 + 昵称 + 抖音号）：视频页顶部与视频标题同处右侧内容区，
  // 先找出含「抖音号 / 昵称 / 账号」标签的小容器，标题候选跳过这些容器内的文本，
  // 避免把达人的抖音号当成视频标题。
  function accountContainers() {
    var roots = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var s = (node.nodeValue || '').trim();
      if (!s || s.length > 20 || !/(抖音号|昵称|账号|UID|uid)/.test(s)) continue;
      var root = node.parentElement;
      if (!root) continue;
      // 向上收敛到「只装作者信息」的小容器：父容器整段文字超过 80 字就停，防止吞掉标题块。
      while (root.parentElement) {
        var t = (root.parentElement.innerText || '').trim();
        if (!t || t.length > 80) break;
        root = root.parentElement;
      }
      roots.push(root);
    }
    return roots;
  }

  function withinAny(el, roots) {
    for (var i = 0; i < roots.length; i++) {
      try { if (roots[i] === el || roots[i].contains(el)) return true; } catch (e) { /* 忽略 */ }
    }
    return false;
  }

  // 视频页标题：优先 document.title（形如「视频标题 - 抖音指数」），
  // 否则在顶部内容区取最长的中文候选（标题通常比昵称 / 抖音号长），
  // 并排除作者信息区、账号 ID 形态（无中文）与说明性长句。
  var VIDEO_LABELS = ['视频', '指数', '对比', '观众分析', '分析', '播放', '点赞', '评论',
    '分享', '完播', '抖音', '时长', '发布', '返回', '下载', '更多', '登录', '作品', '查看',
    '暂无', '数据概览', '作品分析', '核心数据', '观众画像'];
  function videoTitle() {
    try {
      var t = (document.title || '').replace(/\s+/g, ' ').trim();
      var m = t.match(/^(.{4,120}?)\s*(?:[|｜\-–—·]\s*)?(?:抖音指数|创作者中心|抖音创作服务平台|抖音)$/);
      if (m && /[\u4e00-\u9fa5]/.test(m[1])) return m[1].trim();
    } catch (e) { /* 忽略 */ }

    var roots = accountContainers();
    var minLeft = (window.innerWidth || 0) * 0.12;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    var best = '';
    while ((node = walker.nextNode())) {
      var s = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (s.length < 4 || s.length > 80) continue;
      if (!/[\u4e00-\u9fa5]/.test(s)) continue;                 // 账号 ID 多为纯字母/数字
      if (/[%。！？]$/.test(s)) continue;                          // 说明性长句
      if (/抖音号|昵称|账号|UID|uid/.test(s)) continue;
      var isLabel = false;
      for (var i = 0; i < VIDEO_LABELS.length; i++) {
        if (s === VIDEO_LABELS[i]) { isLabel = true; break; }     // 整串等于页签/指标名才排除，保留含这些字眼的标题
      }
      if (isLabel) continue;
      for (var j = 0; j < NAV_BLACKLIST.length; j++) {
        if (s === NAV_BLACKLIST[j]) { isLabel = true; break; }
      }
      if (isLabel) continue;
      var el = node.parentElement;
      if (!el || withinAny(el, roots)) continue;
      var r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (!r || r.width <= 0 || r.top < 0 || r.top > 900 || r.left < minLeft) continue;
      if (!best || s.length > best.length) best = s;
    }
    return best;
  }

  // 左侧竖排导航与页头通用文案：达人/话题/视频页的名字都在右侧内容区，这些先排除。
  var NAV_BLACKLIST = ['作品发布', '首页', '内容管理', '数据中心', '收入变现', '创作服务',
    'AI分身', '随变', '世界书', '造世界', 'AI工坊', '抖音指数', '创作指南', '趋势报告',
    '服务中心', '创作灵感', '授权管理', '开放平台'];
  var DAREN_BLACKLIST = NAV_BLACKLIST.concat(['达人', '分析', '粉丝', '关注', '获赞', '抖音号',
    'IP', '属地', '指数', '合作', '授权', '私信', '作品', '直播', '店铺', '更多', '暂无',
    '查看', '登录']);
  var TOPIC_BLACKLIST = NAV_BLACKLIST.concat(['话题', '指数', '对比', '相关', '分析', '人群',
    '热门', '视频', '创作者', '排行', '添加', '点赞', '评论', '登录', '抖音']);

  // 结果里的「页名」：CSV 文件名与综合排名标题都以此为准。
  function pageName(page) {
    try {
      var u = new URL(location.href);
      if (page === 'keyword') {
        var k = u.searchParams.get('keyword');
        return k ? decodeURIComponent(k) : '';
      }
      if (page === 'topic') {
        // 话题详情页的 topic 参数是数字 ID，优先从页面顶部内容区取话题名，取不到再回退 ID。
        var tn = guessDisplayName(TOPIC_BLACKLIST, 1, 30, 700);
        if (tn) return tn;
        var t = u.searchParams.get('topic');
        return t ? decodeURIComponent(t) : '';
      }
      if (page === 'daren') {
        return guessDisplayName(DAREN_BLACKLIST, 1, 30, 600);
      }
      if (page === 'video') {
        // 视频页优先取视频标题，而不是顶部的达人昵称 / 抖音号。
        var guess = videoTitle();
        var id = u.searchParams.get('id');
        return guess || (id ? '视频' + id : '');
      }
    } catch (e) { /* 忽略 */ }
    return '';
  }

  function csvEscape(s) {
    s = (s == null ? '' : String(s));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv(sections) {
    var lines = ['区块,分类,占比,TGI'];
    var order = ['地域分布', '年龄分布', '性别分布', '用户内容浏览分布', '手机品牌分布', '手机价格分布'];
    // 固定顺序之外若还有区块（未来新增），追加在最后，避免静默丢数据。
    var keys = Object.keys(sections);
    for (var k = 0; k < keys.length; k++) if (order.indexOf(keys[k]) < 0) order.push(keys[k]);
    for (var i = 0; i < order.length; i++) {
      var name = order[i];
      var data = sections[name];
      if (!data) continue;
      if (Array.isArray(data)) {
        for (var j = 0; j < data.length; j++) {
          var it = data[j];
          lines.push([csvEscape(name), csvEscape(it.name), csvEscape(it.ratio), csvEscape(it.tgi)].join(','));
        }
      } else {
        var tabs = Object.keys(data);
        for (var t = 0; t < tabs.length; t++) {
          var tab = tabs[t];
          for (var m = 0; m < data[tab].length; m++) {
            var r = data[tab][m];
            lines.push([csvEscape(name + '-' + tab), csvEscape(r.name), csvEscape(r.ratio), csvEscape(r.tgi)].join(','));
          }
        }
      }
    }
    return lines.join('\r\n');
  }

  // 先整页滚动一遍，逼出懒加载/虚拟化渲染的图表，再回到顶部。
  async function scrollThrough() {
    try {
      var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      var step = Math.max(200, window.innerHeight * 0.8);
      for (var y = 0; y < h; y += step) { window.scrollTo(0, y); await sleep(180); }
      window.scrollTo(0, 0);
      await sleep(500);
    } catch (e) { /* 忽略 */ }
  }

  // 单个区块的行数：数组=平铺区块；对象=带页签的区块（值为各页签的行数组）。
  function rowCount(d) {
    if (!d) return 0;
    if (Array.isArray(d)) return d.length;
    var n = 0, tabs = Object.keys(d);
    for (var t = 0; t < tabs.length; t++) n += d[tabs[t]].length;
    return n;
  }

  function countRows(sections) {
    var n = 0;
    var keys = Object.keys(sections);
    for (var i = 0; i < keys.length; i++) n += rowCount(sections[keys[i]]);
    return n;
  }

  async function extractAll() {
    await scrollThrough();
    var page = detectPage();
    var sections = {};

    // 先做 canvas 图表（年龄 / 手机分布 / 兴趣），再抓性别与地域；
    // 地域会切换子页签导致重渲染，放最后做，避免影响其它图表引用。
    // 诊断快照：把「脚本实际看到了什么」如实回传。识别失败时不必再猜，直接看这份快照即可
    // 定位是标题没匹配上、图表顺序不对，还是性别区块文本结构与预期不同。
    var marks = findTitleMarks();
    var charts = getCharts();
    var debugSections = charts.map(function (c) {
      var r = null;
      try { r = c.canvas.getBoundingClientRect(); } catch (e) { r = null; }
      return {
        section: c.section || '未知',
        top: r ? Math.round(r.top) : -1,
        w: r ? Math.round(r.width) : -1,
        hasTip: !!c.tip
      };
    });
    var debug = {
      pageType: page,
      titleMarks: marks.map(function (m) { return { title: m.t, top: Math.round(m.top) }; }),
      charts: debugSections,
      genderText: '',
      browsingTabs: ''
    };
    // 回给用户一句人话；详细映射（标题命中位置/图表归属）只留在 debug 快照里，供「诊断」查看。
    bridge('onLog', '已定位 ' + marks.length + ' 个区块、' + charts.length
        + ' 个图表（' + pageLabel(page) + '页），开始解析…');

    // 年龄分布：canvas 图表，各页型通用；图表不存在则记空。
    var ageChart = findChartIn(charts, '年龄分布');
    sections['年龄分布'] = ageChart ? await scanCanvas(ageChart) : [];

    // 手机品牌 / 价格分布：仅达人粉丝分析页有；标题不在场即跳过。
    sections['手机品牌分布'] = await extractGeneric(charts, marks, '手机品牌分布');
    sections['手机价格分布'] = await extractGeneric(charts, marks, '手机价格分布');

    // 用户内容浏览分布是「主标签 → 子标签」两级结构，需逐级点开采集；
    // 达人页没有该区块（标题不在场即跳过），关键词/话题/视频页均有。
    // 放在年龄之后、地域之前：地域会切自己的页签重渲染，必须留在最后。
    if (page !== 'daren'
        && (hasTitle(marks, '用户内容浏览分布') || findChartIn(charts, '用户内容浏览分布'))) {
      sections['用户内容浏览分布'] = await extractBrowsing();
    } else {
      sections['用户内容浏览分布'] = [];
    }

    sections['性别分布'] = extractGender();
    sections['地域分布'] = await extractRegion();
    debug.genderText = lastGenderBoxText;
    debug.browsingTabs = lastBrowsingTabs;

    // 诊断 dump：把性别/手机分布区块附近的 DOM 文本和 canvas tooltip 样本全部放进 debug。
    // 这样「诊断」按钮复制出来的快照里就包含了根因证据。
    debug.dumps = {
      genderBlock: dumpNearTitle('性别分布'),
      phoneBrandBlock: dumpNearTitle('手机品牌分布'),
      phonePriceBlock: dumpNearTitle('手机价格分布')
    };
    debug.probes = {
      phoneBrandCanvas: await probeCanvasTip('手机品牌分布'),
      phonePriceCanvas: await probeCanvasTip('手机价格分布')
    };

    var csv = buildCsv(sections);
    return {
      ok: countRows(sections) > 0,
      pageType: page,
      keyword: pageName(page),
      generatedAt: new Date().toISOString(),
      chartCount: charts.length,
      debugSections: debugSections,
      debug: debug,
      counts: {
        region: (sections['地域分布'] && Object.keys(sections['地域分布']).length) || 0,
        age: rowCount(sections['年龄分布']),
        gender: rowCount(sections['性别分布']),
        interest: rowCount(sections['用户内容浏览分布']),
        phoneBrand: rowCount(sections['手机品牌分布']),
        phonePrice: rowCount(sections['手机价格分布'])
      },
      rowCount: countRows(sections),
      csv: csv
    };
  }

  window.__dyRun = async function () {
    if (window.__dyRunning) return;
    window.__dyRunning = true;
    bridge('onLog', '开始抓取…');
    try {
      var res = await extractAll();
      bridge('onResult', JSON.stringify(res));
    } catch (e) {
      bridge('onError', String((e && e.stack) || e));
    } finally {
      window.__dyRunning = false;
    }
  };

  // watcher：统一为手动触发，无论关键词 / 话题 / 达人 / 视频四种页面，
  // 都等待用户点底部「开始抓取」按钮才执行。脚本只负责探测页面是否已就绪，
  // 就绪后回一条提示给状态栏，不会自动跑。
  // page 检测放在 timer 里每次重试：SPA 路由切换可能导致首次 detectPage 拿到中间态 URL
  // （返回 unknown），等 DOM 渲染稳定后再检测一次就能拿到正确页型。
  (function watch() {
    var ticks = 0;
    var timer = setInterval(function () {
      ticks++;
      var ready = false;
      try {
        var txt = document.body ? document.body.innerText : '';
        var hasCanvas = document.querySelectorAll('.lightcharts-container canvas').length > 0;
        ready = hasCanvas && /地域分布|年龄分布|性别分布|用户内容浏览分布|手机品牌分布|手机价格分布/.test(txt);
      } catch (e) { ready = false; }
      var page = detectPage();
      if (ready) {
        clearInterval(timer);
        if (page !== 'unknown') {
          bridge('onLog', pageLabel(page) + '页已就绪，点底部「开始抓取」提取数据');
        } else {
          bridge('onLog', '页面已就绪，点底部「开始抓取」提取数据');
        }
      } else if (ticks > 300) {
        clearInterval(timer);
        bridge('onLog', '未检测到分析区块，请确认已进入对应分析页');
      }
    }, 1000);
  })();
})();
