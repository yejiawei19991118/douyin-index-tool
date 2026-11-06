/*
 * 综合评分模块（纯函数，无 DOM 依赖）
 *
 * 设计要点（口径 v2.1）：
 *  1. 对数空间标准化：占比与 TGI 都是乘性量（跨数量级变化），先取 log 再做
 *     稳健标准化（中位数 0、每 1 IQR 记 1 个 z）。
 *  2. 分数用有界单调映射 100/(1+3^-z)：中位数恒为 50 分，
 *     中间区段 1 IQR 约合 ±25 分，天然落在 (0, 100) 内且严格单调。
 *     不做硬截断，因此不会出现「几十行同分、名次靠占比兜底」的假排名，
 *     也不会把头部压成 100 分而让名次由 TGI 单独决定。
 *  3. 两维几何合成：对数空间等权相加 = 几何平均。规模小一个数量级会被如实拉低，
 *     不会被高 TGI 抵消（0% 占比的噪声类目因此排在榜尾附近）。
 *  4. 名次区间：在权重 wS ∈ {0.3, 0.5, 0.7} 下各排一次，取最好/最差名次，
 *     用来表达「结论对权重设定的敏感度」，不是统计置信区间。
 *
 * 注意单位：调用方传入的 share 是**小数**（0.09 = 9%），不是百分点。
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.DyScoring = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 'v2.1-logexp';
  // 占比按小数计，0 值补 0.01 个百分点（= 0.0001），与展示口径（两位小数的百分比）对齐。
  var DEFAULT_EPS_SHARE = 0.0001;
  var DEFAULT_EPS_TGI = 1;        // TGI 下限，避免 log(0)
  // IQR 下限（对数域）：约等于 20% 的乘性差异。TGI 在 100 附近常常挤得很紧
  // （IQR 可能只有 9%），若不设下限，微小差异会被放大成极端 z 值，
  // 综合分会被 TGI 单独主导。
  var DEFAULT_IQR_FLOOR = Math.log(1.2);
  // 有界映射的陡度：取 ln(3)，使 1 IQR 的中位两侧刚好对应 75 / 25 分。
  var LINK_K = Math.log(3);
  var WEIGHT_SET = [0.3, 0.5, 0.7];

  function logSafe(v, eps) {
    var x = Number(v);
    if (!isFinite(x) || x < 0) x = 0;
    return Math.log(x + eps);
  }

  function ascending(a, b) { return a - b; }

  function medianOfSorted(sorted) {
    var n = sorted.length;
    if (!n) return NaN;
    var mid = n >> 1;
    return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function quantileOfSorted(sorted, p) {
    var n = sorted.length;
    if (!n) return NaN;
    if (n === 1) return sorted[0];
    var pos = (n - 1) * p;
    var lo = Math.floor(pos);
    var hi = Math.min(n - 1, lo + 1);
    var w = pos - lo;
    return sorted[lo] * (1 - w) + sorted[hi] * w;
  }

  /* 有界单调映射：z=0 → 50 分；z=±1（1 IQR）→ 75 / 25 分。
     值域自然落在 (0, 100)，不需要截断，且任意两个不同的 z 都得到不同的分数。 */
  function scoreOfZ(z) {
    return 100 / (1 + Math.exp(-LINK_K * z));
  }

  /* 稳健标准化：返回 z 分数（中位数 0、1 IQR = 1）。
     iqrFloor 给对数域 IQR 设下限，避免分布过窄时把小差异放大成极端 z。
     IQR 为 0（该维完全相同）时全部记 0。 */
  function robustZ(values, iqrFloor) {
    var n = values.length;
    var floor = isFinite(iqrFloor) ? iqrFloor : 0;
    if (n < 2) return { z: new Array(n).fill(NaN), med: NaN, iqr: NaN, flat: true };
    var sorted = values.slice().sort(ascending);
    var med = medianOfSorted(sorted);
    var rawIqr = quantileOfSorted(sorted, 0.75) - quantileOfSorted(sorted, 0.25);
    if (!(rawIqr > 0)) return { z: new Array(n).fill(0), med: med, iqr: 0, flat: true };
    var iqr = Math.max(rawIqr, floor);
    return {
      z: values.map(function (v) { return (v - med) / iqr; }),
      med: med,
      iqr: rawIqr,
      flat: false
    };
  }

  /* 两维加权合成：几何平均（wS=0.5 时 = sqrt(S*P)）。
     加性 0.5*S+0.5*P 的问题是 0% 占比可以被高 TGI 抵消；
     几何合成要求两维同时不低，0% 占比的类目会如实沉底。 */
  function compositeOf(S, P, wS) {
    var wP = 1 - wS;
    var s = Math.max(0, S);
    var p = Math.max(0, P);
    if (s === 0 || p === 0) return 0;
    return Math.pow(s, wS) * Math.pow(p, wP);
  }

  /**
   * @param {Array<{share:number, tgi:number, name?:string}>} rows 同榜内待排序的记录
   * @param {{epsShare?:number, epsTgi?:number}} [opts]
   * @returns {{
   *   S:number[], P:number[], composite:number[], rank:number[],
   *   rankLo:number[], rankHi:number[],
   *   flatS:boolean, flatP:boolean, version:string,
   *   medShare:number, iqrShare:number, medTgi:number, iqrTgi:number
   * }}
   */
  function scoreRows(rows, opts) {
    opts = opts || {};
    var epsShare = isFinite(opts.epsShare) ? opts.epsShare : DEFAULT_EPS_SHARE;
    var epsTgi = isFinite(opts.epsTgi) ? opts.epsTgi : DEFAULT_EPS_TGI;
    var n = rows.length;

    if (n < 2) {
      return {
        S: new Array(n).fill(NaN),
        P: new Array(n).fill(NaN),
        composite: new Array(n).fill(NaN),
        rank: new Array(n).fill(NaN),
        rankLo: new Array(n).fill(NaN),
        rankHi: new Array(n).fill(NaN),
        flatS: true, flatP: true, version: VERSION,
        medShare: NaN, iqrShare: NaN, medTgi: NaN, iqrTgi: NaN
      };
    }

    var logShare = rows.map(function (r) { return logSafe(r.share, epsShare); });
    var logTgi = rows.map(function (r) { return logSafe(r.tgi, epsTgi); });
    var iqrFloor = isFinite(opts.iqrFloor) ? opts.iqrFloor : DEFAULT_IQR_FLOOR;
    var rs = robustZ(logShare, iqrFloor);
    var rp = robustZ(logTgi, iqrFloor);

    /* 50 分 = 榜内中位数；指数映射不打截断，头部与尾部都保留区分度。 */
    var S = rs.z.map(scoreOfZ);
    var P = rp.z.map(scoreOfZ);

    var composite = new Array(n);
    var rank = new Array(n);
    var rankByWeight = WEIGHT_SET.map(function () { return new Array(n); });

    function orderBy(wS) {
      var idx = [];
      for (var i = 0; i < n; i++) idx.push(i);
      var scores = new Array(n);
      for (var j = 0; j < n; j++) scores[j] = compositeOf(S[j], P[j], wS);
      idx.sort(function (a, b) {
        if (scores[b] !== scores[a]) return scores[b] - scores[a];
        if (rows[b].share !== rows[a].share) return rows[b].share - rows[a].share;
        if (rows[b].tgi !== rows[a].tgi) return rows[b].tgi - rows[a].tgi;
        return (rows[a]._rowIndex || 0) - (rows[b]._rowIndex || 0);
      });
      return { order: idx, scores: scores };
    }

    var main = orderBy(0.5);
    composite = main.scores;
    main.order.forEach(function (rowIdx, pos) { rank[rowIdx] = pos + 1; });

    WEIGHT_SET.forEach(function (w, wi) {
      var res = orderBy(w);
      res.order.forEach(function (rowIdx, pos) { rankByWeight[wi][rowIdx] = pos + 1; });
    });

    var rankLo = new Array(n);
    var rankHi = new Array(n);
    for (var i = 0; i < n; i++) {
      var lo = n, hi = 1;
      WEIGHT_SET.forEach(function (w, wi) {
        var v = rankByWeight[wi][i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      });
      rankLo[i] = lo;
      rankHi[i] = hi;
    }

    /* S/P 的 50 分恒定对应「榜内中位数」（对数空间单调映射），
       故四象限的判定阈值仍是 50，与旧版一致。 */
    return {
      S: S, P: P, composite: composite, rank: rank, rankLo: rankLo, rankHi: rankHi,
      flatS: rs.flat, flatP: rp.flat, version: VERSION,
      medShare: Math.exp(rs.med) - epsShare,
      iqrShare: rs.iqr,
      medTgi: Math.exp(rp.med) - epsTgi,
      iqrTgi: rp.iqr
    };
  }

  return {
    VERSION: VERSION,
    WEIGHT_SET: WEIGHT_SET,
    robustZ: robustZ,
    compositeOf: compositeOf,
    scoreRows: scoreRows,
    medianOfSorted: medianOfSorted,
    quantileOfSorted: quantileOfSorted
  };
});
