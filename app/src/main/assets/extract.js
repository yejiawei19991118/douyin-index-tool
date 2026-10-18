/*
 * 抖音指数「人群分析」自动提取脚本（注入到 creator.douyin.com 页面内运行）。
 *
 * 数据来源分两类：
 *   1) DOM 文本：地域「省份/城市级别/城市」表格、性别分布
 *   2) canvas 图表：图表用 canvas 绘制，具体数值只在鼠标悬停 tooltip 里出现，
 *      故对每个图表容器沿 x 轴（多行 y）派发合成 mousemove 事件，读取其「兄弟节点」tooltip 文本。
 *
 * 结果通过 window.DyBridge.onResult(json) 回传给原生侧。
 * 本脚本可重复执行：window.__dyRun() 手动触发；注入后另起一个 watcher 在页面就绪时自动触发一次。
 */
(function () {
  if (window.__dyInjected) return;
  window.__dyInjected = true;

  var TITLES = ['地域分布', '年龄分布', '性别分布', '用户内容浏览分布'];
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
    var out = [];

    // ① 定位两个标签元素：真实页面里标签是纯文本叶子，故取「去空白后 <= 10 字」的元素。
    var mLab = null, fLab = null;
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      var s = (e.textContent || '').replace(/\s+/g, '');
      if (!s || s.length > 10) continue;
      if (!mLab && s.indexOf('男性') >= 0) mLab = e;
      if (!fLab && s.indexOf('女性') >= 0) fLab = e;
      if (mLab && fLab) break;
    }

    // ② 得到性别区块容器（两个标签都找不到时退回整页，仅作最后兜底）。
    var box = (mLab && fLab) ? nearestCommon(mLab, fLab) : document.body;

    // ③ 容器内压平文本，按「标签…占比X%…TGI Y」解析（页面文本里含「占比」「TGI」字样）。
    var flat = ((box && box.innerText) || '').replace(/\s+/g, '');
    if (!flat) flat = (document.body.innerText || '').replace(/\s+/g, '');
    lastGenderBoxText = flat.slice(0, 200);
    // 标签必须与「占比」紧邻：数据行写作「男性占比48%TGI91」；
    // 而区块顶部还有一句介绍文案「女性占比最高，女性偏好度（TGI指数）最高」，
    // 里面同样出现「女性…占比」——若用「女性.*?占比」懒匹配会跨越文案抓到男性的 48%/91
    // （这是真机诊断确认的残留 bug），故去掉中间的通配，只认紧邻形式。
    var m = flat.match(/男性占比(\d+(?:\.\d+)?)%TGI(\d+(?:\.\d+)?)/);
    var f = flat.match(/女性占比(\d+(?:\.\d+)?)%TGI(\d+(?:\.\d+)?)/);
    if (m) out.push({ name: '男性', ratio: m[1] + '%', tgi: m[2] });
    if (f) out.push({ name: '女性', ratio: f[1] + '%', tgi: f[2] });

    // 兜底：容器文本里没有「占比 / TGI」字样时，退回按行结构解析（范围仍锁定在容器内）。
    if (!out.length) {
      var lines = (((box && box.innerText) || document.body.innerText || ''))
          .split('\n').map(function (t) { return t.trim(); });
      var names = ['男性', '女性'];
      for (var k = 0; k < names.length; k++) {
        var idx = lines.indexOf(names[k]);
        if (idx < 0) continue;
        var ratio = null, tgi = null;
        for (var j = idx + 1; j < Math.min(lines.length, idx + 14); j++) {
          var t = lines[j];
          if (!ratio && /^\d+(?:\.\d+)?%$/.test(t)) ratio = t;
          else if (ratio && !tgi && /^\d+(?:\.\d+)?$/.test(t)) { tgi = t; break; }
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

  function keyword() {
    try {
      var v = new URL(location.href).searchParams.get('keyword');
      return v ? decodeURIComponent(v) : '';
    } catch (e) { return ''; }
  }

  function csvEscape(s) {
    s = (s == null ? '' : String(s));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv(sections) {
    var lines = ['区块,分类,占比,TGI'];
    var order = ['地域分布', '年龄分布', '性别分布', '用户内容浏览分布'];
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
    var sections = {};

    // 先做 canvas 图表（年龄 / 兴趣），再抓性别与地域；
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
      titleMarks: marks.map(function (m) { return { title: m.t, top: Math.round(m.top) }; }),
      charts: debugSections,
      genderText: '',
      browsingTabs: ''
    };
    // 回给用户一句人话；详细映射（标题命中位置/图表归属）只留在 debug 快照里，供「诊断」查看。
    bridge('onLog', '已定位 ' + marks.length + ' 个区块、' + charts.length + ' 个图表，开始解析…');

    sections['年龄分布'] = await scanCanvas(findChartIn(charts, '年龄分布'));
    // 用户内容浏览分布是「主标签 → 子标签」两级结构，需逐级点开采集；
    // 放在年龄之后、地域之前：地域会切自己的页签重渲染，必须留在最后。
    sections['用户内容浏览分布'] = await extractBrowsing();
    sections['性别分布'] = extractGender();
    sections['地域分布'] = await extractRegion();
    debug.genderText = lastGenderBoxText;
    debug.browsingTabs = lastBrowsingTabs;

    var csv = buildCsv(sections);
    return {
      ok: countRows(sections) > 0,
      keyword: keyword(),
      generatedAt: new Date().toISOString(),
      chartCount: charts.length,
      debugSections: debugSections,
      debug: debug,
      counts: {
        region: (sections['地域分布'] && Object.keys(sections['地域分布']).length) || 0,
        age: sections['年龄分布'].length,
        gender: sections['性别分布'].length,
        interest: rowCount(sections['用户内容浏览分布'])
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

  // watcher：页面出现「人群分析」相关区块且图表已渲染时，自动跑一次
  (function watch() {
    var ticks = 0;
    var timer = setInterval(function () {
      ticks++;
      var ready = false;
      try {
        var txt = document.body ? document.body.innerText : '';
        var hasCanvas = document.querySelectorAll('.lightcharts-container canvas').length > 0;
        ready = hasCanvas && /地域分布|年龄分布|性别分布|用户内容浏览分布/.test(txt);
      } catch (e) { ready = false; }
      if (ready) { clearInterval(timer); setTimeout(function () { window.__dyRun(); }, 1500); }
      else if (ticks > 300) { clearInterval(timer); bridge('onLog', '未检测到人群分析区块'); }
    }, 1000);
  })();
})();
