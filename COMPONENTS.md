# 功能组件清单

抖音指数「人群分析」自动抓取工具 —— 各功能组件与其在代码中的位置。
运行时**零第三方依赖**（仅 Android 框架 API），构建期仅 AGP + Gradle wrapper。

同一个仓库还派生了一个 **PWA 网页版**（由 `tools/build-pwa.js` 从 `assets/ranking.html` 转换生成，GitHub Pages 托管），供 iPhone Safari「添加到主屏幕」后离线使用；网页版不具备自动抓取能力，数据通过导入 CSV 获取（见「七、PWA 网页版」）。

---

## 一、应用外壳层 `app/src/main/java/com/lmt/dyindex/MainActivity.java`

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 配置常量 | `DEFAULT_KEYWORD`、`DESKTOP_UA` | 默认关键词「穿搭」；桌面版 Chrome UA（各分析页为桌面端页面，需桌面 UA 才能拿到全部区块）。目标地址构造见 `AppUrls` |
| 布局骨架 | `onCreate` | 纵向四段：模式切换 chips / 顶部输入栏 / WebView / 底部控制区 |
| 模式切换组件 | `MODE_*`、`MODE_LABELS`、`MODE_HINTS`、`modeChips`、`setMode()` | 输入框上方一行单选 chips：关键词（默认）/ 达人 / 视频 / 话题；选中态主色实心，未选描边；切换只更新选中态与输入框 hint，不自动跳转 |
| 关键词输入组件 | `keywordInput`、`openBtn`、`openKeyword()` | EditText（预填 + 圆角底 + 按模式换 hint）+「打开」按钮，支持软键盘回车触发；按模式跳对应页面：关键词直达分析页（自动抓取），达人→`/daren/search`、视频→`/videosearch`、话题→`/topicsearch`（状态栏引导手动进详情切分析页签后再抓取） |
| 更新入口 | `updateBtn` | 顶栏「更新」按钮 → 手动检查新版本（每次回到前台另有静默自动检查，见「内置版本更新」） |
| 网页承载组件 | `webView` + `WebSettings` | JS / DOM 存储 / 数据库 / 宽视口 / 概览模式 / 桌面 UA / 混合内容兼容 |
| 登录态组件 | `CookieManager`、`onResume`、`onPause`、`onPageFinished` | 接受第三方 Cookie；在页面加载完成、回前台、切后台三处 `flush()` 落盘，实现免重复扫码 |
| 导航与进度 | `WebViewClient.onPageFinished`、`onProgressChanged`、`onConsoleMessage` | 页面完成即注入脚本；加载百分比可视化；页面 JS 报错转 logcat（tag `DyIndexJS`） |
| 状态栏组件 | `statusView`、`setStatus()` | 单行 + 省略号，汇报加载进度 / 空数据 / 抓取结果 |
| 操作按钮组 | `runBtn`、`rankingBtn` | 开始抓取 / **综合排名**，两个按钮等宽；抓取成功后自动启用「综合排名」（失败则保留上一份成功结果，可点开旧数据）；CSV / xlsx 导出统一在排名页内完成，外壳层不再写系统下载目录 |
| 注入与保活 | `injectExtractor()`、`pollReinject` | 注入 assets 脚本；每 2.5s 轮询补注入，应对 SPA 路由重置导致脚本丢失；`POSTROBOT_READY_SEED` 预热与注入检查**合并为一次 `evaluateJavascript`**（预热脚本自带幂等守卫），省掉一半跨进程调用；**仅前台轮询**（`onPause` 停止、`onResume` 恢复），切后台（如打开排名页）时停止以省电省 CPU |
| UI 样式工具 | `bg()`、`actionButton()`、`hDivider()`、`addWeighted()`、`dp()` | 圆角背景 / 主次按钮样式 / 分割线 / 等宽排布 / dp 换算 |
| 资源与生命周期 | `readAsset()`、`onKeyDown`、`onDestroy` | 读取 assets；返回键回溯历史；销毁时清理 WebView |

### 原生 ↔ JS 通信桥

| 组件 | 符号 | 职责 |
| --- | --- | --- |
| 进度回传 | `DyBridge.onLog(String)` | 脚本进度 → 状态栏 |
| 结果回传 | `DyBridge.onResult(String)` | 解析 JSON → 缓存 CSV / 行数 / 页名 `pageNameCache` / 页型 `pageTypeCache`（keyword/topic/daren/video）；**只有本次抓到数据才覆盖缓存**（失败时保留上一份成功结果，避免旧 CSV 配新页名）；完整快照仅在失败时打 logcat；`openRanking()` 把页名与页型一并透传给 `RankingActivity`（`EXTRA_KEYWORD` / `EXTRA_PAGE_TYPE`） |
| 异常回传 | `DyBridge.onError(String)` | 脚本异常 → 状态栏 |

---

## 二、纯逻辑工具类 `app/src/main/java/com/lmt/dyindex/`

不依赖 Android 框架，可在 JVM 上直接单测（测试见 `app/src/test/java/com/lmt/dyindex/`）。

| 组件 | 符号 | 职责 |
| --- | --- | --- |
| 目标地址构造 | `AppUrls.BASE_URL`、`ANALYSIS_URL`、`DAREN_SEARCH_URL`、`VIDEO_SEARCH_URL`、`TOPIC_SEARCH_URL`、`targetUrl(kw)`、`darenSearchUrl(kw)`、`videoSearchUrl(kw)`、`topicSearchUrl(kw)` | 关键词→直达人群分析页地址；达人→`/daren/search?keyword=`；视频→`/videosearch?query=`；话题→`/topicsearch?topic=`；统一 `enc()` 做 URL 编码（中文 / 空格 / 特殊字符） |
| 导出文件名 | `CsvUtils.sanitizeFileName(kw)`、`CsvUtils.fileNameFor(kw)` | 清洗文件名非法字符、空值兜底「关键词」；按关键词固定命名（同名覆盖，不堆重复文件） |
| 版本号比较 | `VersionUtils.normalize / parseSegments / compare / isNewer` | 解析 `v1.2.3` 形态 tag（剥离前导 v 与 `-`/`+` 后缀），逐段按数值比较，段数不一致按 0 补 |

### 单元测试

| 测试类 | 覆盖点 |
| --- | --- |
| `AppUrlsTest` | 中文百分号编码、空格→加号、`&`/`=` 转义、固定查询参数保留、空关键词与 null；达人/视频/话题三个搜索地址的前缀、参数名（`keyword`/`query`/`topic`）、中文编码与空值兜底 |
| `CsvUtilsTest` | 非法字符全替换、首尾空白、空/null 兜底、固定命名与完整后缀 |
| `VersionUtilsTest` | 前导 v / 后缀剥离、段数不一致视为相等、1.10 &gt; 1.9、主版本优先、空版本最低 |

---

## 三、内置版本更新

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 更新检查 | `Updater.checkAndPrompt(activity, manual)` | 免登录请求 `releases/latest`（GitHub API，需 User-Agent）；`manual=false` 每次重新打开/回到前台都静默查（仅 60s 进程内冷却、失败静默）、`manual=true` 用户点「更新」（无视冷却并回提示）；发现新版即后台下载并调起系统安装器（同版本已有下载在途时跳过）；私有仓库 404 给可读提示而非崩溃 |
| 版本比对 | `Updater.parseRelease()` + `VersionUtils` | 取 `tag_name` 规整后与当前 `versionName` 比较；从 `assets` 挑 `.apk`（优先带 `release` 字样）与 `.apk.sha256` |
| 下载 | `Updater.startDownload()` + DownloadManager | 先查「安装未知应用」授权（未授权则引导去设置）；下载到应用私有 `updates/` 目录；下载前清理遗留安装包 |
| 校验与安装 | `Updater.handleIfFinished()` | 下载完成广播 / onResume 补装两路；SHA-256 摘要校验 → 签名兼容性比对 → 调起系统安装器；签名不一致时引导卸载重装，**Activity 已销毁时改用应用上下文 Toast 提示，不再静默丢弃更新**；**所有 UI 回调（runOnUiThread / 弹对话框）均先判 `isFinishing() || isDestroyed()`**，避免 Activity 销毁后崩溃 |
| 安装包共享 | `ApkFileProvider`（authority `${applicationId}.apk`） | 自建极简 ContentProvider，以 content:// 只读形式把 APK 交给系统安装器（替代需要 androidx 的 FileProvider） |
| 断点接续 | `Updater.resumePendingInstall()` + `SharedPreferences` | 进程若在下载期间被回收，onResume 依据持久化的下载 id 接续校验与安装 |
| 清单声明 | `AndroidManifest.xml` | `REQUEST_INSTALL_PACKAGES` 权限 + `<provider>` 声明 |

---

## 四、页面注入脚本层 `app/src/main/assets/extract.js`

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 配置 | `TITLES`、`REGION_TABS` | 六个区块名（地域/年龄/性别/用户内容浏览/手机品牌/手机价格）；地域维度优先级 **城市 → 城市级别 → 省份** |
| 页型识别 | `detectPage()`、`pageLabel()` | 按 URL 识别 keyword（`/analysis?keyword=`）/ topic（`/analysis?topic=`）/ daren（`/daren/detail`）/ video（`/videoanalysis`）；区块按页面实际存在探测，缺失自动跳过（达人页无内容浏览块，仅达人页有手机分布块） |
| 页名 | `pageName()`、`textOf()` | **状态栏 / 综合排名页标题 / 导出文件名的唯一来源（同源）**（导出表内不再单列关键词）。四种页面各自按真实渲染元素取值，不做坐标/黑名单排除：关键词页与话题页取页头筛选行的主题 chip（`.filterDate-*` 内的 `.tag-*`，取不到回退 URL 参数）；达人页取作者资料卡昵称（`.author-*` 卡片内的 `.nickname-*`，回退 `达人+uid`）；视频页取视频详情卡标题（`.videoAnalysis-* → .tabHead-* → span.title-*`，回退 `视频+id`）。类名为 CSS Modules（语义前缀 + 构建哈希），按前缀匹配；页名在切页签/下钻之前采集，避免标题元素被重渲染 |
| 基础工具 | `sleep()`、`bridge()` | 延时；统一封装 `window.DyBridge` 回传 |
| 区块定位 | `findTitleMarks()`、`sectionFor()`、`getCharts()`、`findChartIn()`、`sectionRoot()` | TreeWalker 扫纯文本节点定位标题；按垂直 + 水平距离判定图表归属；收集图表容器与 tooltip 兄弟节点；`sectionRoot` 取含 canvas 的最低祖先 |
| canvas 采集 | `parseTip()`、`scanCanvas()` | 解析 tooltip 的「占比 / TGI」；多行 y × x 步进派发合成 mousemove 逼出 tooltip |
| 地域采集 | `parseRegionTable()`、`clickTab()`、`extractRegion()` | 解析 DOM 表格；切换子维度页签；按维度优先级编排采集 |
| 通用区块采集 | `hasTitle()`、`parseTableNear()`、`extractGeneric()` | 手机品牌/价格分布：优先 canvas 扫描，空则退「标题附近含 排名+TGI 表头容器」的 DOM 表格解析；标题不在场直接跳过 |
| 性别采集 | `nearestCommon()`、`extractGender()` | 取「男性 / 女性」标签的最小公共祖先容器隔离解析；紧邻正则避免命中介绍文案 |
| 兴趣下钻采集 | `browsingChart()`、`chartStale()`、`drillHost()`、`backButton()`、`clickChart()`、`sweepBars()`、`extractBrowsing()` | 「用户内容浏览分布」实为**柱状图**：单行扫 x 读出全部主标签 → 逐个点击柱体下钻（点击 y 取 0.80，落在柱体上）→ 扫子层 → 点「返回上一级」回主层；子标签名为「主标签_子标签」，输出 `时尚` / `时尚_穿搭` 平铺行 |
| 输出 | `pageName()`、`csvEscape()`、`buildCsv()` | 按页型取页名；CSV 转义；按区块 + 维度组装 CSV（表头 `区块,分类,占比,TGI,父类`，`父类` 由下钻时的主标签显式写入，供排名侧判定二级类目，不再依赖 `_` 命名约定） |
| 流程编排 | `scrollThrough()`、`countRows()`、`extractAll()` | 整页滚动逼出懒加载图表；统计行数；按「年龄 → 兴趣 → 性别 → 地域」顺序采集（地域放最后，避免切页签重渲染影响其它图表） |
| 诊断快照 | `debug`（随结果回传） | 标题命中位置、图表归属、性别容器原文、兴趣下钻概况（主标签数 / 成功下钻数 / 行数）；**仅在 0 行时**追加 DOM dump 与 canvas 探针，正常抓取路径不再做这几轮全文档扫描 |
| 触发组件 | `window.__dyRun()`、`watch()` | 手动触发；关键词/话题页就绪后 1.5s 自动触发一次，达人/视频页只提示就绪（避免用户还在浏览时自动抓完跳走） |

---

## 五、综合排名分析页 `RankingActivity.java` + `assets/ranking.html` + `assets/scoring.js`

抓取成功后点底部「综合排名」进入本页，把人群分析 CSV 直接灌入内置排名工具，**无需手动导出/上传**。

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 页面承载 | `RankingActivity.onCreate` / `onPause` / `onResume` / `onDestroy` | 全屏 WebView 加载 `file:///android_asset/ranking.html`；页面就绪后 `evaluateJavascript` 调 `window.loadFromCsv(csv, keyword, pageType)` 自动分析；切后台 `webView.onPause()` 停 JS 计时器与渲染，回前台 `onResume()`；销毁时先 `stopLoading` → 摘除 `DyRankingBridge` → 从视图树移除 → `destroy()`，避免 WebView/Activity 泄漏 |
| 页型标签 | `PAGE_TYPE_LABEL` / `tipsHTML()` | 控制区标题按页型显示「当前关键词 / 当前话题 / 当前达人 / 当前视频」；标签独占一行居中、`white-space:nowrap` 固定不收缩（不会被长标题压成竖排），正文**完整展示不截断**，仅在超长英文串处强制换行 |
| 数据入口 | `window.loadFromCsv()`、`parseCsv()`、`parseCsvText()` | 原生传入 CSV 文本 → 内置 RFC4180 解析器（无第三方依赖，返回**二维数组**）→ `buildTable` → `processTable`；自动完成清洗、打分、四象限、二级混合榜。两条入口共用同一解析器：原生走 `loadFromCsv → parseCsvText`，网页版走 `handleFile → parseCsv → parseCsvText`，后者只做「空结果判错」，不得再按 PapaParse 的 `{ rows }` 结构取数 |
| 原生回传桥 | `DyRankingBridge`（`window.DyRankingBridge`） | `exportCsv(text, name)`：页面「导出结果」交由原生写入系统下载目录；`.xlsx` 走 base64 解码后二进制写入，`.csv` 走 UTF-8 字节写入；**同名文件覆盖写先置 `IS_PENDING=1`，失败只还原标记、绝不删除用户上一份完整导出**；文件名经 `CsvUtils.sanitizeFileName` 净化；成功/失败由原生 Toast 单条提示（WebView 内 `<a download>` 不落盘）；`close()`：「返回抓取」关闭本 Activity |
| 多 Sheet 导出 | `buildMultiSheetXlsx()`、`xlsxSheetXml()` | 纯 JS OOXML 生成器（crc32 + zip STORED + inline strings），一个区块一个 sheet；区块 sheet 隐藏 R/R状态 两列，**二级混合总榜** sheet 保留全部列；仅对有数据的区块生成 sheet。混合榜 12 列、区块 sheet 10 列（均含「名次区间（权重0.3–0.7）」） |
| 导出命名 | `state.currentKeyword` | 文件名 `抖音指数_<页名>_综合排名.xlsx` 与页面标题都取自抓取侧的页名（`pageName`）；关键词/话题页=页头主题 chip、达人页=昵称、视频页=视频标题（不使用达人抖音号）。表内不再重复写 `关键词 / 榜单名称 / 分组名` 三列（文件名与 sheet 名已表达）。原生注入时 `loadFromCsv` 标记 `meta.nativeName`，`cleanData` 直接沿用该页名、不再按文件名规则二次截断，保证一致 |
| 排名算法 | `assets/scoring.js`（`DyScoring`）/ `buildList` / `buildKeywordResult` / `computeR` / `isSecondaryRow` | 9 步数据清洗；占比→规模分 S、TGI→偏好分 P：两维先在 log 空间做稳健标准化（中位数 0、1 IQR=1），再用有界单调映射 `100/(1+3^-z)` 转为分数（中位数 50、中间区段 1 IQR≈±25 分、值域 (0,100) 且不做硬截断）；composite = `S^wS · P^(1-wS)` 几何合成（wS=0.5）；名次区间 = wS∈{0.3,0.5,0.7} 三种权重下的最好/最差名次；四象限（HH 重点机会 / HL / LH / LL）；兴趣子类 R = 子类占比/父类占比×100（父类取抓取侧显式 `父类` 字段，回退 `_` 拆分），>100 标「超常发挥」。注意 `scoring.js` 的 `share` 入参是小数（0.09=9%），与展示口径一致 |
| 标准区块 | `STANDARD_BLOCKS` | 地域分布-城市/城市级别/省份、年龄分布、性别分布、用户内容浏览分布、手机价格分布、手机品牌分布；缺失区块在覆盖率中如实标注 |
| 资产独立性 | `ranking.html` | 已剥离 PapaParse/SheetJS CDN 与文件上传 UI，仅保留分析逻辑与渲染，可离线运行；CSV 解析统一走内联 `parseCsvText`（不依赖 PapaParse），Excel 解析在 XLSX 未加载时给出明确提示而非崩溃。上传解析函数 `handleFile()` 仍保留，网页版由 `pwa-src/web-boot.js` 重新挂载导入入口后复用同一条解析链路（`handleFile → parseCsv → parseCsvText`）；新增 CSV 入口一律直接消费 `parseCsvText` 的二维数组返回值，避免出现第二套解析/取数约定 |

---

## 六、构建与交付链

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| 模块构建脚本 | `app/build.gradle` | release 签名绑定、**版本号自动派生**、compileSdk 34 / minSdk 26 / targetSdk 34 |
| 版本号派生 | `app/build.gradle` 的 `VERSION_NAME_BASE` + `dyBuildNumber` | `versionName = 基础版本 + '.' + git 提交数`、`versionCode = 25 + 提交数`；CI 可用 `DYINDEX_BUILD_NUMBER` 覆盖（浅克隆时保证与 PWA / 用户脚本一致） |
| 签名前置校验 | `app/build.gradle` 的 `gradle.taskGraph` 检查 | 请求 release 产物但 `keystore.properties`／字段／keystore 文件缺失时**立即失败并给出提示**，不静默产出未签名包；debug 构建不受影响 |
| 混淆 keep 规则 | `app/proguard-rules.pro` | 保留 `@JavascriptInterface` 注解与方法、注入桥 `DyBridge` 全部成员，防日后开启混淆导致桥失效（当前 `minifyEnabled false`，规则为前置保险） |
| 工程构建脚本 | `build.gradle`、`settings.gradle` | AGP 8.13.0、镜像仓库、模块声明 |
| 密钥隔离 | `.gitignore` | 排除 `release.jks`、`keystore.properties`、`local.properties`、构建产物 |
| 单元测试闸门 | `.github/workflows/release.yml`「单元测试」步骤 | `assembleRelease` 之前先跑 `./gradlew test`，测试不过直接 fail，不产出也不发布 APK |
| 发布流水线 | `.github/workflows/release.yml` | **任何推送 main（.md 除外）即触发**，也支持推送 `v*` 标签 / 手动触发：校验 Secrets → 计算版本号 → 还原签名文件 → **单元测试** → `assembleRelease` → 产物校验 → 生成带版本号资产与 SHA256 → 以 `v<版本>` 建标签并发布 Release |
| PWA 部署流水线 | `.github/workflows/pages.yml` | 推送 `main`（`**.md` 除外）即触发：`node tools/build-pwa.js` 转换页面 → 产物自检 → 上传 Pages 产物 → 部署 GitHub Pages；`workflow_dispatch` 可手动重发 |

### 版本发布流程

```
改代码 → 提交并推送 main → CI 自动构建、自动递增版本并发布 Release + 更新 PWA
```

**无需手动改版本号、无需手动打标签、无需本机执行构建命令**。版本号由「基础版本 + git 提交数」自动派生，每次提交必然递增。

推送 `main` 后由 CI 自动完成：

1. 校验签名 Secrets 是否齐全（缺失即失败，不白跑构建）
2. 计算版本号：`N = git rev-list --count HEAD`，`tag = v<基础版本>.<N>`，并以 `DYINDEX_BUILD_NUMBER` 传给 Gradle
3. 由 Secrets 还原 `release.jks` 与 `keystore.properties`（仅存在于本次 runner，用完销毁）
4. 将 Gradle 分发包从国内镜像切到官方源（境外 runner 拉取更稳）
5. **`./gradlew test`**（另需 `node --test tools/scoring.test.js` 校验评分模块）：单元测试不全绿即中止，绝不产出/发布半成品
6. `./gradlew assembleRelease`
7. **产物校验**：文件存在 → `apksigner verify` 签名校验（未签名直接中止发布）→ 确认包内含 `assets/extract.js`、`assets/ranking.html`、`assets/scoring.js`
8. 生成 `douyin-index-tool-v<版本>-release.apk` 与同名 `.sha256`
9. 发布 Release（同一次推送内创建同名标签），App 内 `Updater` 据此提示升级

### 签名配置约定

- **绝不入库**：`release.jks` 与 `keystore.properties` 均被 `.gitignore` 排除。私钥一旦泄露，他人可伪造出被系统当作「正版升级」接受的 APK
- CI 通过仓库 Secrets 提供签名信息：`SIGNING_KEYSTORE_BASE64`（keystore 的 base64）、`SIGNING_STORE_PASSWORD`、`SIGNING_KEY_ALIAS`、`SIGNING_KEY_PASSWORD`
- 本地缺少签名配置时 `assembleRelease` 会直接失败并给出提示；如需本地验证签名产物，需自行从安全位置恢复这两个文件
- 同类工程若换 keystore，务必沿用同一份密钥，否则无法覆盖升级

---

## 七、PWA 网页版（iPhone Safari）

**定位**：同一仓库派生的网页端，只负责「导入 CSV → 综合排名 → 导出 xlsx」，**页面本身不做抓取**。浏览器既不能向 `creator.douyin.com` 注入脚本，也无法读取跨域 DOM；网页端要用数据，只能靠同仓库派生的用户脚本在抖音页面内同源采集（见下「网页端抓取脚本」）。

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| 转换构建 | `tools/build-pwa.js` | 读取 `app/src/main/assets/ranking.html`，仅在 `</head>` / `</body>` 前追加 PWA 元数据与启动脚本 → 输出 `pwa-dist/`（已 gitignore）。同时复制 `assets/scoring.js`（与 App 共用同一份算法，绝不另存副本），并用 Node 内置 `zlib` 程序化生成图标（零依赖，CI 可复现） |
| 页面 | `pwa-dist/index.html` | 与 Android 端同一份排名页，业务逻辑零改动；两端差异只有注入的标签与启动脚本，改口径只需改 `ranking.html` 一处 |
| 应用清单 | `pwa-src/manifest.webmanifest` | `display: standalone`、`theme_color: #2563eb`、`start_url: ./`（GitHub Pages 子路径部署同样可用）、192/512 图标 |
| 离线缓存 | `pwa-src/sw.js` | 安装即预缓存页面壳与全部静态资源；导航请求网络优先、离线回退 `index.html`；静态资源缓存优先并在后台更新；`skipWaiting` + `clients.claim` 让新版本立即接管 |
| 启动脚本 | `pwa-src/web-boot.js` | ①隐藏原生专属入口：「返回抓取」（依赖原生桥关闭 Activity）、「重新分析」（导入后无意义）；放出「加载示例数据」；②在控制区注入「选择 CSV 文件 / 粘贴 CSV」导入卡片，文件交给页面内置 `handleFile()`，复用同一条「编码校验 → `parseCsv`（内联 `parseCsvText`）→ 清洗 → 评分 → 渲染」链路，与原生注入使用同一个解析器；③首次访问显示「添加到主屏幕」提示，关闭后写入 localStorage；④注册 Service Worker；⑤改写首页空状态文案为导入引导；⑥顶栏「iPhone 用法」按钮 → 底部弹层教程（添加主屏 / 安装抓取脚本 / 抓取并导入 / 离线 / 常见问题） |
| 补充样式 | `pwa-src/web.css` | 导入卡片、提示条；并为 `#backBtn[hidden]` / `#reanalyzeBtn[hidden]` / `#sampleBtn[hidden]` 补显式 `display:none`——`.btn` 的 `inline-flex` 会盖掉浏览器对 `[hidden]` 的默认样式 |
| 图标 | 构建期生成 `icons/icon-192.png`、`icon-512.png`、`icon-180.png` | PNG 编码手写（IHDR/IDAT/IEND + CRC32），无需 canvas 或三方库；manifest 用透明圆角版，apple-touch-icon 用满幅方形交由 iOS 自行切圆角 |
| 用户脚本（网页端抓取） | `pwa-src/userscript-controller.js` → 构建产物 `pwa-dist/douyin-index-extract.user.js` | 网页端唯一的抓取形态：脚本注入 `creator.douyin.com` 页面内（同源），直接复用 `assets/extract.js` 的采集实现（由构建脚本原样拼接，不复制逻辑）；控制器提供 `window.DyBridge` 的网页版实现（`onLog` / `onResult` / `onError`）、右下角「抓取数据」悬浮按钮（Shadow DOM 隔离样式）、抓完后的「复制 CSV / 下载 CSV / 打开排名页」、以及「打开页面」四入口——输入关键词后一键直达关键词分析 / 达人搜索 / 视频搜索 / 话题搜索（URL 构造与 Android 端 `AppUrls` 一致）；`@match` 限定 creator 域、`@grant none` |
| 部署 | `.github/workflows/pages.yml` | 推送 `main` 自动转换并发布到 GitHub Pages，产物自检（关键文件 + 注入标记）不通过即失败；见「六、构建与交付链」 |
| 使用方式（iPhone） | Safari 打开线上地址 → 分享 → 添加到主屏幕 | 全屏无地址栏运行；首次联网后资源进缓存，断网仍可导入分析；数据只在本机处理 |
| 与 App 的边界 | — | 数据来源：只用「网页端抓取脚本」复制/下载 CSV 后导入；导出沿用页面既有逻辑，网页端走浏览器下载（不写系统下载目录） |

### APK 改动如何自动同步到脚本与 PWA

两端不维护第二份实现：APK 侧改动在构建期进入网页产物，推送 `main` 即自动重建并发布（纯 `.md` 除外）。

| APK 侧改动 | 同步方式 | 作用位置 |
| --- | --- | --- |
| `assets/ranking.html`（页面 / 交互 / 导出） | 构建时整页转换，只追加 PWA 标签与启动脚本 | PWA `index.html` |
| `assets/scoring.js`（评分口径） | 原样复制，不另存副本 | PWA `scoring.js` |
| `assets/extract.js`（抓取实现） | 原样拼接进用户脚本 | `.user.js` 的抓取逻辑 |
| `AppUrls.java`（页面地址 / 参数） | 构建时解析 `BASE_URL`、路径常量与 `return` 表达式 → 注入 `PAGE_URLS` | 脚本「打开页面」四入口 |
| `app/build.gradle` 的 `VERSION_NAME_BASE` + 构建号 | 生成用户脚本 `@version`、SW 缓存名、页面版本标记（与 APK `versionName` 完全同一算法、同一数值） | 扩展自动更新、PWA 自动换缓存 |

版本与升级链路：`versionName = VERSION_NAME_BASE + '.' + 提交数`（APK、PWA、用户脚本三者同版本），每次提交必然递增：APK 由 `release.yml` 在推送 `main` 时自动构建并以同版本 `v*` 标签发布，`Updater` 比对 `tag_name` 后提示升级；用户脚本按 `@updateURL` 定期检查并更新；PWA 的 `CACHE_NAME` 带同一版本，新 SW `skipWaiting` + `clients.claim` 立即接管，页面回到前台时还会主动 `reg.update()`，因此下次打开即为新内容。构建脚本解析 `AppUrls.java` / `VERSION_NAME_BASE` 失败会直接报错，杜绝两端悄悄分叉。

**本地自测**：`node tools/build-pwa.js` 后用任意静态服务器指向 `pwa-dist/`，浏览器打开即可验证导入、排名、导出；Service Worker 需要 `http://localhost` 或 https 环境才会注册。

### 网页端抓取脚本（可选，iPhone 上的另一条入口）

PWA 页面本身无法跨域抓取，但把脚本注入抖音页面内部（同源）就能抓。构建脚本会把 `pwa-src/userscript-controller.js` 与 `assets/extract.js` 拼成一个用户脚本，随 Pages 一起发布：

```
https://yejiawei19991118.github.io/douyin-index-tool/douyin-index-extract.user.js
```

安装与使用（iPhone）：

1. App Store 安装 **Userscripts**（Safari 扩展），在「设置 → Safari → 扩展」里启用，并允许其访问 `creator.douyin.com`
2. Safari 直接打开上面的 `.user.js` 地址 → 扩展会提示安装脚本
3. 打开抖音创作者中心的人群分析页，等图表渲染完成后点右下角「抓取数据」（页面会自动滚动、逐个下钻）
4. 抓完点「复制 CSV」→ 切到主屏的 PWA → 点「粘贴 CSV」；复制被拒时改用「下载 CSV」，再从「文件」App 导入

桌面 Chrome 也可用篡改猴（Tampermonkey）安装同一脚本。**风险**：采集依赖页面 CSS Modules 类名与 canvas tooltip 结构，抖音改版可能导致失效；高频抓取有账号风控风险，请控制频率并自行评估合规性。
