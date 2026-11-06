const test = require('node:test');
const assert = require('node:assert');
const scoring = require('../app/src/main/assets/scoring.js');

/* 注意单位：share 与展示口径一致，用**小数**（0.096 = 9.6%）。 */
function rows(list) {
  return list.map((r, i) => ({ share: r[0], tgi: r[1], name: 'c' + i, _rowIndex: i }));
}

test('头部不再饱和：占比更高的一定得分更高，且头部不被压成同分', () => {
  const src = rows([[0.1148, 100], [0.0421, 100], [0.0200, 100], [0.0100, 100], [0.0047, 100]]);
  const res = scoring.scoreRows(src);
  assert.ok(res.S[0] > res.S[1], '11.48% 应高于 4.21%');
  assert.ok(res.S[1] > res.S[2]);
  assert.ok(res.S[0] - res.S[1] > 1, '头部两条应拉开差距，而不是都截到 100');
});

test('0% 占比 + 高 TGI 不会靠偏好混进中上游', () => {
  const src = rows([[0, 230], [0.05, 120], [0.03, 110], [0.01, 100], [0.005, 90]]);
  const res = scoring.scoreRows(src);
  assert.strictEqual(res.rank[0], 5, '0% 占比记录应排最后');
});

test('综合得分随名义权重在 0.3–0.7 之间给出一致的名次区间', () => {
  const src = rows([[0.09, 90], [0.002, 200], [0.04, 110], [0.012, 130], [0.025, 105], [0.005, 150]]);
  const res = scoring.scoreRows(src);
  for (let i = 0; i < src.length; i++) {
    assert.ok(res.rankLo[i] <= res.rank[i], 'rankLo 不应大于主名次');
    assert.ok(res.rankHi[i] >= res.rank[i], 'rankHi 不应小于主名次');
    assert.ok(res.rankHi[i] - res.rankLo[i] <= src.length - 1);
  }
  const placed = res.rank.slice().sort((a, b) => a - b);
  assert.deepStrictEqual(placed, [1, 2, 3, 4, 5, 6], '主名次应为 1..n 的排列');
});

test('宽分布下不出现截断同分：所有行分值严格可区分且恒为正', () => {
  /* 复刻真实榜的形态：占比跨 3 个数量级（0.02%–11.5%），TGI 挤在 78–192。 */
  const src = [];
  const n = 60;
  for (let i = 0; i < n; i++) {
    const share = 0.0002 * Math.pow(574, i / (n - 1));
    const tgi = 78 + (192 - 78) * (n - 1 - i) / (n - 1);
    src.push([share, tgi]);
  }
  const res = scoring.scoreRows(rows(src));
  assert.ok(res.S.every((v) => v > 0), '规模分不应被截断为 0');
  assert.ok(res.P.every((v) => v > 0), '偏好分不应被截断为 0');
  const uniq = new Set(res.composite.map((v) => v.toFixed(9)));
  assert.strictEqual(uniq.size, src.length, '综合分不应出现同分');
  assert.ok(Math.min(...res.S) < 40 && Math.max(...res.S) > 70, '规模分跨度应足够大');
});

test('某维完全相同：该维记 50 分并标记 flat，不判四象限', () => {
  const src = rows([[0.09, 100], [0.03, 100], [0.01, 100], [0.002, 100]]);
  const res = scoring.scoreRows(src);
  assert.strictEqual(res.flatP, true);
  assert.ok(res.P.every((v) => v === 50));
  assert.strictEqual(res.flatS, false);
});

test('样本不足（n=1）返回 NaN 而不是伪造分数', () => {
  const res = scoring.scoreRows(rows([[0.05, 120]]));
  assert.ok(Number.isNaN(res.composite[0]));
  assert.ok(Number.isNaN(res.rank[0]));
});

test('相同输入结果可复现', () => {
  const src = rows([[0.09, 90], [0.002, 200], [0.04, 110], [0.012, 130]]);
  const a = scoring.scoreRows(src);
  const b = scoring.scoreRows(src);
  assert.deepStrictEqual(a.composite, b.composite);
  assert.deepStrictEqual(a.rank, b.rank);
});

test('综合得分与主名次单调一致', () => {
  const src = rows([[0.09, 90], [0.002, 200], [0.04, 110], [0.012, 130], [0.025, 105], [0.005, 150]]);
  const res = scoring.scoreRows(src);
  for (let i = 0; i < src.length; i++) {
    for (let j = 0; j < src.length; j++) {
      if (res.rank[i] < res.rank[j]) assert.ok(res.composite[i] >= res.composite[j]);
    }
  }
});

test('对负数/非法输入取 0，不产生 NaN 分数', () => {
  const src = rows([[-1, -5], [0.03, 100], [0, 0], [0.01, 120]]);
  const res = scoring.scoreRows(src);
  assert.ok(res.composite.every((v) => isFinite(v) && v >= 0));
});
