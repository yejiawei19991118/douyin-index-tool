# 功能组件清单

抖音指数「人群分析」自动抓取工具 —— 各功能组件与其在代码中的位置。
运行时**零第三方依赖**（仅 Android 框架 API），构建期仅 AGP + Gradle wrapper。

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
| 操作按钮组 | `runBtn`、`copyBtn`、`exportBtn`、`rankingBtn`、`debugBtn` | 开始抓取 / 复制 / 导出 CSV / **综合排名** / 诊断，五个按钮等宽排布；「综合排名」在抓取成功后自动跳转（也可手动点） |
| 注入与保活 | `injectExtractor()`、`pollReinject` | 注入 assets 脚本；每 2.5s 轮询补注入，应对 SPA 路由重置导致脚本丢失；**仅前台轮询**（`onPause` 停止、`onResume` 恢复），切后台（如打开排名页）时停止以省电省 CPU |
| 数据导出 | `exportCsv()`、`writeToDownloads()`、`findDownloadsFile()` | MediaStore 写入系统「下载」目录，带 UTF-8 BOM；同名文件复用 Uri 覆盖写入，不产生重复文件；文件名规则见 `CsvUtils.fileNameFor` |
| 剪贴板组件 | `copyCsv()`、`copyDebug()` | 复制 CSV；复制抓取诊断快照 |
| UI 样式工具 | `bg()`、`actionButton()`、`hDivider()`、`addWeighted()`、`setCopyEnabled()`、`dp()` | 圆角背景 / 主次按钮样式 / 分割线 / 等宽排布 / 禁用态置灰 / dp 换算 |
| 资源与生命周期 | `readAsset()`、`onKeyDown`、`onDestroy` | 读取 assets；返回键回溯历史；销毁时清理 WebView |

### 原生 ↔ JS 通信桥

| 组件 | 符号 | 职责 |
| --- | --- | --- |
| 进度回传 | `DyBridge.onLog(String)` | 脚本进度 → 状态栏 |
| 结果回传 | `DyBridge.onResult(String)` | 解析 JSON → 缓存 CSV / 行数 / 诊断快照 → 自动导出 |
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
| 校验与安装 | `Updater.handleIfFinished()` | 下载完成广播 / onResume 补装两路；SHA-256 摘要校验 → 签名兼容性比对 → 调起系统安装器；签名不一致时引导卸载重装；**所有 UI 回调（runOnUiThread / 弹对话框）均先判 `isFinishing() || isDestroyed()`**，避免 Activity 销毁后崩溃 |
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
| 输出 | `pageName()`、`csvEscape()`、`buildCsv()` | 按页型取页名；CSV 转义；按区块 + 维度组装 CSV（固定六区块顺序，额外区块追加在后） |
| 流程编排 | `scrollThrough()`、`countRows()`、`extractAll()` | 整页滚动逼出懒加载图表；统计行数；按「年龄 → 兴趣 → 性别 → 地域」顺序采集（地域放最后，避免切页签重渲染影响其它图表） |
| 诊断快照 | `debug`（随结果回传） | 标题命中位置、图表归属、性别容器原文、兴趣下钻概况（主标签数 / 成功下钻数 / 行数），供「诊断」按钮排查 |
| 触发组件 | `window.__dyRun()`、`watch()` | 手动触发；关键词/话题页就绪后 1.5s 自动触发一次，达人/视频页只提示就绪（避免用户还在浏览时自动抓完跳走） |

---

## 五、综合排名分析页 `RankingActivity.java` + `assets/ranking.html`

抓取完成后自动跳入本页，把人群分析 CSV 直接灌入内置排名工具，**无需手动导出/上传**。

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 页面承载 | `RankingActivity.onCreate` | 全屏 WebView 加载 `file:///android_asset/ranking.html`；页面就绪后 `evaluateJavascript` 调 `window.loadFromCsv(csv, keyword)` 自动分析 |
| 数据入口 | `window.loadFromCsv()` / `parseCsvText()` | 原生传入 CSV 文本 → 内置 RFC4180 解析器（无第三方依赖）→ `buildTable` → `processTable`；自动完成清洗、打分、四象限、二级混合榜 |
| 原生回传桥 | `DyRankingBridge`（`window.DyRankingBridge`） | `exportCsv(text, name)`：页面「导出结果」交由原生写入系统下载目录；`.xlsx` 走 base64 解码后二进制写入，`.csv` 走 UTF-8 字节写入；成功/失败由原生 Toast 单条提示（WebView 内 `<a download>` 不落盘）；`close()`：「返回抓取」关闭本 Activity |
| 多 Sheet 导出 | `buildMultiSheetXlsx()`、`xlsxSheetXml()` | 纯 JS OOXML 生成器（crc32 + zip STORED + inline strings），一个区块一个 sheet；区块 sheet 隐藏 R/R状态 两列，**二级混合总榜** sheet 保留全部列；仅对有数据的区块生成 sheet |
| 导出命名 | `state.currentKeyword` | 文件名 `抖音指数_<页名>_综合排名.xlsx` 与页面标题都取自抓取侧的页名（`pageName`）；关键词/话题页=页头主题 chip、达人页=昵称、视频页=视频标题（不使用达人抖音号）。表内不再重复写 `关键词 / 榜单名称 / 分组名` 三列（文件名与 sheet 名已表达）。原生注入时 `loadFromCsv` 标记 `meta.nativeName`，`cleanData` 直接沿用该页名、不再按文件名规则二次截断，保证一致 |
| 排名算法 | `cleanData` / `robustScores` / `buildList` / `buildKeywordResult` / `computeR` | 9 步数据清洗；占比→规模分 S、TGI→偏好分 P（稳健标准化：中位数 50、每 IQR=25 分）；composite = 0.5S + 0.5P 等权合成；四象限（HH 重点机会 / HL / LH / LL）；兴趣子类 R = 子类占比/父类占比×100，>100 标「超常发挥」 |
| 标准区块 | `STANDARD_BLOCKS` | 地域分布-城市/城市级别/省份、年龄分布、性别分布、用户内容浏览分布、手机价格分布、手机品牌分布；缺失区块在覆盖率中如实标注 |
| 资产独立性 | `ranking.html` | 已剥离 PapaParse/SheetJS CDN 与文件上传 UI，仅保留分析逻辑与渲染，可离线运行；CSV 解析统一走内联 `parseCsvText`（不依赖 PapaParse），Excel 解析在 XLSX 未加载时给出明确提示而非崩溃 |

---

## 六、构建与交付链

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| 模块构建脚本 | `app/build.gradle` | release 签名绑定、版本号、compileSdk 34 / minSdk 26 / targetSdk 34 |
| 签名前置校验 | `app/build.gradle` 的 `gradle.taskGraph` 检查 | 请求 release 产物但 `keystore.properties`／字段／keystore 文件缺失时**立即失败并给出提示**，不静默产出未签名包；debug 构建不受影响 |
| 混淆 keep 规则 | `app/proguard-rules.pro` | 保留 `@JavascriptInterface` 注解与方法、注入桥 `DyBridge` 全部成员，防日后开启混淆导致桥失效（当前 `minifyEnabled false`，规则为前置保险） |
| 工程构建脚本 | `build.gradle`、`settings.gradle` | AGP 8.13.0、镜像仓库、模块声明 |
| 密钥隔离 | `.gitignore` | 排除 `release.jks`、`keystore.properties`、`local.properties`、构建产物 |
| 单元测试闸门 | `.github/workflows/release.yml`「单元测试」步骤 | `assembleRelease` 之前先跑 `./gradlew test`，测试不过直接 fail，不产出也不发布 APK |
| 发布流水线 | `.github/workflows/release.yml` | 推送 `v*` 标签即触发：校验 Secrets → 还原签名文件 → **单元测试** → `assembleRelease` → 产物校验 → 生成带版本号资产与 SHA256 → 发布 Release |

### 版本发布流程

```
改代码 → 提交并推送 → git tag vX.Y && git push origin vX.Y
```

推送标签后由 CI 自动完成，**无需本机执行任何构建命令**：

1. 校验签名 Secrets 是否齐全（缺失即失败，不白跑构建）
2. 由 Secrets 还原 `release.jks` 与 `keystore.properties`（仅存在于本次 runner，用完销毁）
3. 将 Gradle 分发包从国内镜像切到官方源（境外 runner 拉取更稳）
4. **`./gradlew test`**：单元测试不全绿即中止，绝不产出/发布半成品
5. `./gradlew assembleRelease`
6. **产物校验**：文件存在 → `apksigner verify` 签名校验（未签名直接中止发布）→ 确认包内含 `assets/extract.js`
7. 生成 `douyin-index-tool-<tag>-release.apk` 与同名 `.sha256`
8. 发布 Release 并附带两个资产

### 签名配置约定

- **绝不入库**：`release.jks` 与 `keystore.properties` 均被 `.gitignore` 排除。私钥一旦泄露，他人可伪造出被系统当作「正版升级」接受的 APK
- CI 通过仓库 Secrets 提供签名信息：`SIGNING_KEYSTORE_BASE64`（keystore 的 base64）、`SIGNING_STORE_PASSWORD`、`SIGNING_KEY_ALIAS`、`SIGNING_KEY_PASSWORD`
- 本地缺少签名配置时 `assembleRelease` 会直接失败并给出提示；如需本地验证签名产物，需自行从安全位置恢复这两个文件
- 同类工程若换 keystore，务必沿用同一份密钥，否则无法覆盖升级
