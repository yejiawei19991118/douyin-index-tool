# 功能组件清单

抖音指数「人群分析」自动抓取工具 —— 各功能组件与其在代码中的位置。
运行时**零第三方依赖**（仅 Android 框架 API），构建期仅 AGP + Gradle wrapper。

同一个仓库还派生了一个 **PWA 网页版**（由 `tools/build-pwa.js` 从 `assets/ranking.html` 转换生成，GitHub Pages 托管），供 iPhone Safari「添加到主屏幕」后离线使用；网页版不具备自动抓取能力，数据通过导入 CSV 获取（见「七、PWA 网页版」）。

### 仓库文件清单（与下文各章一一对应）

| 分组 | 文件 | 说明章节 |
| --- | --- | --- |
| Android 源码（9） | `MainActivity.java`、`RankingActivity.java`、`ActivationActivity.java`、`LicenseManager.java`、`Updater.java`、`ApkFileProvider.java`、`AppUrls.java`、`CsvUtils.java`、`VersionUtils.java` | 一、二、三、五、八 |
| 前端资产（3） | `assets/extract.js`、`assets/ranking.html`、`assets/scoring.js` | 四、五 |
| 资源与清单（7） | `AndroidManifest.xml`、`res/values/strings.xml`、`colors.xml`、`themes.xml`、`res/drawable/ic_launcher_foreground.xml`、`res/mipmap-anydpi-v26/ic_launcher.xml`、`ic_launcher_round.xml` | 三、六 |
| 单元测试（3） | `AppUrlsTest.java`、`CsvUtilsTest.java`、`VersionUtilsTest.java` | 二 |
| PWA 与构建（6） | `pwa-src/web-boot.js`、`web.css`、`sw.js`、`manifest.webmanifest`、`userscript-controller.js`、`tools/build-pwa.js` | 六、七 |
| 评测脚本（1） | `tools/scoring.test.js` | 六 |
| 工程与 CI（11） | `build.gradle`、`app/build.gradle`、`settings.gradle`、`gradle.properties`、`gradle/wrapper/gradle-wrapper.properties`、`gradlew`、`gradlew.bat`、`app/proguard-rules.pro`、`.gitignore`、`.github/workflows/release.yml`、`.github/workflows/pages.yml` | 六 |

---

## 一、应用外壳层 `app/src/main/java/com/lmt/dyindex/MainActivity.java`

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 配置常量 | `DEFAULT_KEYWORD`、`DESKTOP_UA` | 默认关键词「穿搭」；桌面版 Chrome UA（各分析页为桌面端页面，需桌面 UA 才能拿到全部区块）。目标地址构造见 `AppUrls` |
| 启动期兼容注入 | `SVG_CLASSNAME_POLYFILL`、`STUCK_PAGE_RECOVERY`、`POSTROBOT_READY_SEED` | 均在 `onPageStarted` 注入、早于页面自身 JS：①修正 `SVGElement.className` 返回 `SVGAnimatedString` 导致渲染管线抛错卡在「加载中」；②监听 `ChunkLoadError` / `loadable-components` 失败与「body 长期只含加载中」三类信号触发 `reload()`，用 `sessionStorage` 做 45s 去重防死循环；③把 post-robot 父窗口 `readyPromise` 预热为 resolved，修复顶层 WebView 点开视频卡片后永久「加载中」 |
| 布局骨架 | `onCreate` | 纵向四段：模式切换 chips / 顶部输入栏 / WebView / 底部控制区；**进入前先过卡密闸门**（见「八、卡密授权」） |
| 模式切换组件 | `MODE_*`、`MODE_LABELS`、`MODE_HINTS`、`modeChips`、`setMode()` | 输入框上方一行单选 chips：关键词（默认）/ 达人 / 视频 / 话题；选中态主色实心，未选描边；切换只更新选中态与输入框 hint，不自动跳转 |
| 关键词输入组件 | `keywordInput`、`openBtn`、`openKeyword()` | EditText（预填 + 圆角底 + 按模式换 hint）+「打开」按钮，支持软键盘回车触发；按模式跳对应页面：关键词→分析页，达人→`/daren/search`、视频→`/videosearch`、话题→`/topicsearch`；四种模式统一为**手动抓取**，进入页面后由用户点底部「开始抓取」触发（达人/视频/话题还需手动进详情切分析页签） |
| 更新入口 | `updateBtn` | 顶栏「更新」按钮 → 手动检查新版本（每次回到前台另有静默自动检查，见「内置版本更新」） |
| 网页承载组件 | `webView` + `WebSettings` | JS / DOM 存储 / 数据库 / 宽视口 / 概览模式 / 桌面 UA / 混合内容兼容 |
| 登录态组件 | `CookieManager`、`onResume`、`onPause`、`onPageFinished` | 接受第三方 Cookie；在页面加载完成、回前台、切后台三处 `flush()` 落盘，实现免重复扫码 |
| 导航开始回调 | `WebViewClient.onPageStarted` | 每次开始加载（含登录重定向）重置超时、显示当前主机，并按顺序注入上面三支兼容/自愈脚本 |
| 页面完成回调 | `WebViewClient.onPageFinished` | 落盘 Cookie → 补注入预热 seed → `injectExtractor()`；登录页不启动卡死检测（等用户扫码），其它页面启动 20s 看门狗；400ms 后把状态栏切到「页面已就绪 / 请扫码登录」 |
| 进度与错误提示 | `onProgressChanged`、`onConsoleMessage`、`onReceivedError`、`onReceivedHttpError` | 加载百分比可视化；页面 JS 报错转 logcat（tag `DyIndexJS`，便于 `adb logcat -s DyIndexJS` 定位注入脚本问题）；主框架网络错误 / HTTP ≥400 才提示，子资源（埋点/广告）失败不打扰用户 |
| 加载超时 | `LOAD_TIMEOUT_MS`（30s）、`loadTimeoutRunnable` | `onPageStarted` 起计时，`onPageFinished` / 主框架错误时取消；超时只提示「可能需要登录或网络较慢」，不强制中断，避免误杀慢网 |
| 卡死看门狗 | `STUCK_DETECT_DELAY_MS`（20s）、`stuckWatchdog`、`stuckReloadDone` | `onPageFinished` 后 20s 用一次 `evaluateJavascript` 检查「仍在加载中且无分析内容」，命中则提示并 `reload()`；单次导航只重试一次，用户手动「打开」时重置计数，避免死循环 |
| 状态栏组件 | `statusView`、`setStatus()` | 单行 + 省略号，汇报加载进度 / 空数据 / 抓取结果；所有更新均切主线程 |
| 操作按钮组 | `runBtn`、`rankingBtn` | 开始抓取 / **综合排名**，两个按钮等宽；抓取成功后自动启用「综合排名」（失败则保留上一份成功结果，可点开旧数据）；CSV / xlsx 导出统一在排名页内完成，外壳层不再写系统下载目录 |
| 页面跳转与提示 | `openRanking()`、`toast()`、`onEditorAction` | `openRanking` 把缓存的 CSV 通过 `RankingActivity.stageCsv()` 同进程静态暂存交接（CSV 动辄数百 KB，走 Intent extra 会撞 Binder 约 1MB 上限），Intent 只带页名 / 页型（无成功数据时提示先抓取）；`toast` 统一切主线程短提示；`onEditorAction` 处理输入法「搜索 / 完成」键，等价于点「打开」 |
| 注入与保活 | `injectExtractor()`、`pollReinject` | 注入 assets 脚本；每 2.5s 轮询补注入，应对 SPA 路由重置导致脚本丢失；`POSTROBOT_READY_SEED` 预热与注入检查**合并为一次 `evaluateJavascript`**（预热脚本自带幂等守卫），省掉一半跨进程调用；**仅前台轮询**（`onPause` 停止、`onResume` 恢复），切后台（如打开排名页）时停止以省电省 CPU |
| 前后台调度 | `onResume` / `onPause`、`ready` | 回前台：Cookie 落盘 → `Updater.resumePendingInstall()` 补装 → `Updater.maybeShowChangelog()` 弹「更新内容」（刚升级完首次打开，同一版本仅一次）→ `Updater.checkAndPrompt(..., false)` 静默查更新 → 重启注入轮询；切后台：Cookie 落盘，停止轮询并移除加载超时 / 卡死看门狗（后台 evaluateJavascript 与 reload 只会白耗电）；`ready` 在 `setContentView` 之后置位，未激活（`onCreate` 已 `finish` 并跳激活页）时两个回调直接返回，不再发起更新检查与轮询 |
| 抓取结果缓存 | `lastCsv`、`pageNameCache`、`pageTypeCache`、`keywordCache`（均 `volatile`）、`destroyed` | 供「综合排名」与导出使用；`pageNameCache` 存抓取侧识别出的页名（达人昵称 / 话题名 / 视频标题），`pageTypeCache` 存 keyword/topic/daren/video，`keywordCache` 为输入兜底；`destroyed` 在 `onDestroy` 先置位，`onPageStarted` / `onPageFinished` 据此直接返回，避免销毁过程中再投递超时与看门狗任务 |
| UI 样式工具 | `bg()`、`actionButton()`、`hDivider()`、`addWeighted()`、`dp()` | 圆角背景 / 主次按钮样式 / 分割线 / 等宽排布 / dp 换算 |
| 资源与生命周期 | `readAsset()`、`onKeyDown`、`onDestroy` | 读取 assets；返回键回溯历史；销毁时先置 `destroyed`（后续 WebView 回调直接返回）、`Updater.stopWatch()` 摘掉下载监听，再 `ui.removeCallbacksAndMessages(null)` 一次清空全部 Handler 回调（含轮询、超时、看门狗与 400ms 状态延迟任务），`about:blank` → `stopLoading` → 摘除 `DyBridge` → `removeAllViews` → `destroy()`，避免 WebView 与静态接收器泄漏 |

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
| 目标地址构造 | `AppUrls.BASE_URL`、`ANALYSIS_URL`、`DAREN_SEARCH_URL`、`VIDEO_SEARCH_URL`、`TOPIC_SEARCH_URL`、`targetUrl(kw)`、`darenSearchUrl(kw)`、`videoSearchUrl(kw)`、`topicSearchUrl(kw)`、`enc()` | 关键词→`/analysis?keyword=<kw>&tab=crowd&appName=aweme&source=creator`；达人→`/daren/search?keyword=`；视频→`/videosearch?query=`；话题→`/topicsearch?topic=`；统一 `enc()` 做 URL 编码（中文 / 空格 / 特殊字符），编码失败兜底原串 |
| 导出文件名 | `CsvUtils.sanitizeFileName(kw)` | 清洗文件名非法字符、空值兜底「关键词」（文件名由 `RankingActivity` 直接拼装） |
| 版本号比较 | `VersionUtils.normalize / parseSegments / leadingInt / compare / isNewer` | 解析 `v1.2.3` 形态 tag（剥离前导 v 与 `-`/`+` 后缀），`leadingInt` 取每个分段的数字前缀（非数字段按 0），逐段数值比较，段数不一致按 0 补 |
| 测试依赖 | `app/build.gradle` 的 `testImplementation 'junit:junit:4.13.2'` | JUnit 只进测试编译期，不打进 APK，运行时零第三方依赖的约定不变 |

### 单元测试

| 测试类 | 覆盖点 |
| --- | --- |
| `AppUrlsTest` | 中文百分号编码、空格→加号、`&`/`=` 转义、固定查询参数保留、空关键词与 null；达人/视频/话题三个搜索地址的前缀、参数名（`keyword`/`query`/`topic`）、中文编码与空值兜底 |
| `CsvUtilsTest` | 非法字符全替换、首尾空白、空/null 兜底 |
| `VersionUtilsTest` | 前导 v / 后缀剥离、段数不一致视为相等、1.10 &gt; 1.9、主版本优先、空版本最低 |

---

## 三、内置版本更新

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 更新检查 | `Updater.checkAndPrompt(activity, manual)` | 免登录请求 `releases/latest`（GitHub API，需 User-Agent）；`manual=false` 每次重新打开/回到前台都静默查（仅 60s 进程内冷却、失败静默）、`manual=true` 用户点「更新」（无视冷却并回提示）；发现新版即后台下载并调起系统安装器（同版本已有下载在途时跳过）；**并把该版本的 `body`（发布时的提交信息）写入 `KEY_NOTES_VERSION` / `KEY_NOTES_BODY`，供装完首次打开离线弹窗**；私有仓库 404 给可读提示而非崩溃 |
| 检查节流与并发 | `AUTO_COOLDOWN_MS`（60s）、`sLastAutoCheckAt`、`sChecking`（`AtomicBoolean`） | 自动检查冷却；`compareAndSet` 保证同一时刻只有一次检查线程，手动重复点击提示「正在检查更新」 |
| Release 解析 | `fetchLatest()`、`parseRelease(String)`、`Release`、`downloadable()`、`currentVersionName(context)` | `currentVersionName` 读 `PackageInfo.versionName`（空/异常返回空串）作为比较基准；取 `tag_name` 规整后与当前 `versionName` 比较；从 `assets` 挑 `.apk`（优先带 `release` 字样）与 `.apk.sha256`；`downloadable()` 判断是否找齐可下载项 |
| 下载 | `Updater.startDownload()` + DownloadManager | 先查「安装未知应用」授权（未授权则引导去设置，但仍继续下载）；下载到应用私有 `updates/` 目录（`dyindex-update-<版本>.apk`）；下载前 `cleanUpdatesDir(app, 待装文件名, 正在安装的文件名)` 清理遗留安装包（后两者都保留）；把下载 id / 文件名 / sha 地址写入 `SharedPreferences` 以供接续 |
| 下载完成监听 | `watchDownload()`、`stopWatch()`、`sReceiver` | 动态注册 `ACTION_DOWNLOAD_COMPLETE`，只处理本次下载 id；Android 13+ 用三参重载显式 `RECEIVER_EXPORTED`，低版本走两参重载；重复挂载前先注销旧接收器；`stopWatch` 在 `MainActivity.onDestroy` 与 `ActivationActivity.onDestroy` 调用，避免静态接收器长期持有已销毁的 Activity（下载不受影响，回前台由 `resumePendingInstall` 接续） |
| 下载状态查询 | `queryStatus(app, id)`、`STATUS_UNKNOWN` | 查询 DownloadManager 状态；记录已不存在返回 `STATUS_UNKNOWN`，由调用方按「已终结」处理 |
| 校验与安装 | `Updater.handleIfFinished()` | 下载完成广播 / onResume 补装两路；状态未终结返回 false 继续等待；SHA-256 摘要校验 → 签名兼容性比对 → 调起系统安装器；摘要与签名校验整段放后台线程（`dyindex-update-verify`）；签名不一致时引导卸载重装，**Activity 已销毁时改用应用上下文 Toast 提示，不再静默丢弃更新**；**所有 UI 回调（runOnUiThread / 弹对话框）均先判 `isFinishing() || isDestroyed()`** |
| 摘要资产 | `fetchSha256(urlStr)` | 拉取 `.apk.sha256` 文本，取第一段并校验 64 位十六进制；取不到返回空串（此时不否决下载，交给签名校验与安装器兜底） |
| 待装记录 | `clearPending(context)`、`cleanUpdatesDir(context, keepName, keepName2)`、`PREFS` / `KEY_PENDING_*` / `KEY_INSTALLING_*` | 清除 `pending_download_id` / `pending_file_name` / `pending_sha_url`；清理共享目录里遗留的 `.apk`，但**跳过待下载与已调起安装器（版本号未变）的两份**（删掉正在被安装器读取的包会导致安装解析失败）；调起安装器前记录 `installing_file_name` / `installing_version`，升级完成后版本号变化即不再保留旧包 |
| 签名比较 | `signatureMatches()`、`signaturesOf()`、`signaturesFrom()`、`fingerprintsOf()`、`SIGNATURE_FLAG` | 读已装应用与待装 APK 的签名集合（API 26–27 用 `signatures`，API 28+ 用 `signingInfo` 的 `getApkContentsSigners` / `getSigningCertificateHistory`）；按「APK 的每个签名者都在已装应用签名集合内」比较，**与枚举顺序无关**（不用 `List.equals`）；任一方读不出签名时放行给系统安装器 |
| 签名不一致处理 | `showSignatureMismatchDialog()`、`openUninstall()`、`copyText()`、`RELEASES_PAGE` | 「无法覆盖安装」对话框：去卸载 / 复制下载地址 / 稍后（删除待装包）；卸载调 `ACTION_DELETE`，复制用系统剪贴板 |
| 安装权限引导 | `openInstallPermissionSettings()` | 跳 `ACTION_MANAGE_UNKNOWN_APP_SOURCES`（带 package），失败退回应用列表页 |
| 安装器调用 | `installApk(context, file)` | 用 `ApkFileProvider` 的 content:// URI + `APK_MIME` + `FLAG_GRANT_READ_URI_PERMISSION` 调 `ACTION_VIEW`；失败提示安装包路径 |
| 安装包共享 | `ApkFileProvider`（authority `${applicationId}.apk`，路径 `updates/`） | 自建极简 ContentProvider：`onCreate()` 直接返回 true（无初始化副作用）；`buildUri()` 拼 `content://<authority>/updates/<文件名>`；`updatesDir()` 取应用私有外部目录、不可用时退回内部私有目录；`openFile` 仅允许只读访问 `updates/<单层文件名>`（拒绝写模式、`/`、`\`、`..`），`getType` 固定 APK MIME；`query/insert/delete/update` 均为空实现（非协商接口） |
| 断点接续 | `Updater.resumePendingInstall()` + `SharedPreferences` | 进程若在下载期间被回收，onResume 依据持久化的下载 id 接续校验与安装；已终结则直接处理，否则重新挂广播；持久化记录残缺（有 id 无文件名）时清掉，避免永久卡在「下载在途」而不再发起新下载 |
| 更新内容弹窗 | `maybeShowChangelog()`、`showChangelog()`、`fetchReleaseBody()`、`wasUpgraded()`、`KEY_LAST_RUN_VERSION` | `MainActivity.onResume` 调用；当前 `versionName` 与 `last_run_version` 不同即视为刚升级（先落盘再弹，避免重复）：优先用升级前缓存的同版本说明**离线直接弹**，缓存缺失时后台请求 `releases/tags/v<当前版本>` 取 `body` 兜底（8s 超时、需 UA、失败静默）并回写缓存；`wasUpgraded()` 用 `lastUpdateTime`/`firstInstallTime` 区分覆盖安装与全新安装（全新安装不打扰）；弹窗标题「更新内容 v<版本>」，正文超 4000 字符截断提示看 Releases，显示前判 `isFinishing()`/`isDestroyed()` |
| 工具 | `sha256Of(File)`、`toast(Context, msg)` | 8KB 分块计算 SHA-256（小写 hex，失败返回空串）；所有 Toast 经复用的同一个主线程 Handler 投递 |
| 清单声明 | `AndroidManifest.xml` | `REQUEST_INSTALL_PACKAGES` 权限 + `<provider>` 声明 |

---

## 四、页面注入脚本层 `app/src/main/assets/extract.js`

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 配置 | `TITLES`、`REGION_TABS`、`lastGenderBoxText`、`lastBrowsingTabs` | 六个区块名（地域/年龄/性别/用户内容浏览/手机品牌/手机价格）；地域维度优先级 **城市 → 城市级别 → 省份**；后两者暂存性别容器原文与下钻概况，供诊断快照回传 |
| 页型识别 | `detectPage()`、`pageLabel()` | 按 URL 识别 keyword（`/analysis?keyword=`）/ topic（`/analysis?topic=`）/ daren（`/daren/detail`）/ video（`/videoanalysis`）；区块按页面实际存在探测，缺失自动跳过（达人页无内容浏览块，仅达人页有手机分布块） |
| 页名 | `pageName()`、`textOf()` | **状态栏 / 综合排名页标题 / 导出文件名的唯一来源（同源）**（导出表内不再单列关键词）。四种页面各自按真实渲染元素取值，不做坐标/黑名单排除：关键词页与话题页取页头筛选行的主题 chip（`.filterDate-*` 内的 `.tag-*`，优先取与 URL keyword 完全一致的那个，并排除日期类 chip（近7天 / 2024-01 等），取不到回退 URL 参数）；达人页取作者资料卡昵称（`.author-*` 卡片内的 `.nickname-*`，回退 `达人+uid`）；视频页取视频详情卡标题（`.videoAnalysis-* → .tabHead-* → span.title-*`，回退 `视频+id`）。类名为 CSS Modules（语义前缀 + 构建哈希），按前缀匹配；页名在切页签/下钻之前采集，避免标题元素被重渲染 |
| 基础工具 | `sleep()`、`bridge()`、`rectOf()`、`isVisible()` | 延时；统一封装 `window.DyBridge` 回传（桥不存在时静默，便于桌面浏览器调试）；安全取 `getBoundingClientRect`；按 display/visibility/opacity 与尺寸判定元素可见 |
| 区块定位 | `findTitleMarks()`、`sectionFor()`、`getCharts(marks)`、`findChartIn()`、`sectionRoot()`、`hasTitle()` | TreeWalker 扫纯文本节点定位标题；按垂直 + 水平距离判定图表归属（同高时取水平中心更近者）；收集图表容器与 tooltip 兄弟节点，标题定位不全时按出现顺序逐个补位；`getCharts` 可复用调用方已算出的标题位置，避免一次抓取里重复全文档遍历；`sectionRoot` 取含 canvas 的最低祖先；`hasTitle` 判断区块标题是否在场 |
| canvas 采集 | `parseTip()`、`scanCanvas()`、`scanSection()` | 解析 tooltip 的「占比 / TGI」：先剥空白与「点击查看兴趣详情」，去千分位后同时兼容负 TGI 与 `TGI--` 占位，只有占比没有 TGI 的形态（手机分布）也收；`scanCanvas` 按 4 行 y（0.12/0.3/0.5/0.72）× 56 列 x 步进派发合成 mousemove，并记住上一次 tooltip 文本，只有内容变化才解析，避免把残留 tooltip 当新柱；`scanSection(title)` 先按标题找图表，找不到再退回 `sectionRoot(title)` 内的 `.lightcharts-container` 兜底扫描 |
| 地域采集 | `parseRegionTable()`、`clickTab()`、`extractRegion()` | 解析 DOM 表格；切换子维度页签（限定在含「地域分布」的祖先容器内点击，避免误点页面其它同名 tab）；页签切换失败时跳过后续维度，避免同一份表格重复写入多个维度；全部维度都失败时把当前视图的数据归到「最后成功切换的维度」，而不是排名页不认识的「当前视图」（否则会被整段丢弃） |
| 通用区块采集 | `parseTableNear()`、`extractGeneric()` | 手机品牌/价格分布：优先 canvas 扫描，空则退「标题附近含 排名+TGI 表头容器」的 DOM 表格解析；标题不在场直接跳过 |
| 性别采集 | `nearestCommon()`、`extractGender()` | 取「男性 / 女性」标签的最小公共祖先容器隔离解析；紧邻正则避免命中介绍文案 |
| 兴趣下钻采集 | `browsingChart()`、`chartStale()`、`drillHost()`、`backButton()`、`clickChart()`、`sweepBars()`、`extractBrowsing()` | 「用户内容浏览分布」实为**柱状图**：单行扫 x 读出全部主标签 → 逐个点击柱体下钻（点击 y 取 0.80，落在柱体上）→ 扫子层 → 点「返回上一级」回主层；子标签名为「主标签_子标签」，并把主标签写入 `父类` 字段；输出 `时尚` / `时尚_穿搭` 平铺行 |
| 输出 | `csvEscape()`、`buildCsv()` | CSV 转义（逗号 / 双引号 / CR / LF / **制表符**）；按固定区块顺序 + 维度组装 CSV（表头 `区块,分类,占比,TGI,父类`）；固定顺序之外的新增区块追加在末尾，避免静默丢数据；`父类` 由下钻时的主标签显式写入，供排名侧判定二级类目，不再依赖 `_` 命名约定 |
| 流程编排 | `scrollThrough()`、`rowCount()`、`countRows()`、`extractAll()` | 整页滚动逼出懒加载图表后回顶；`rowCount` 兼容「平铺数组」与「页签对象」两种区块结构；`countRows` 汇总全部区块；采集顺序固定为「年龄 → 手机品牌/价格 → 兴趣下钻 → 性别 → 地域」（地域会切子页签重渲染，必须放最后），页名在切页签之前采集 |
| 诊断快照 | `dumpNearTitle()`、`probeCanvasTip()`、`debug`（随结果回传） | `dumpNearTitle` 从标题向上最多 4 层 dump 文本节点（标记 `[L]` 叶子 / `[C]` 容器）；`probeCanvasTip` 沿 canvas 单行派发 30 次 mousemove 采集 tooltip 文本；`debug` 含标题命中位置、图表归属、性别容器原文、兴趣下钻概况（主标签数 / 成功下钻数 / 行数）；**仅在 0 行时**追加 DOM dump 与 canvas 探针，正常抓取路径不再做这几轮全文档扫描 |
| 触发组件 | `window.__dyRun()`、`watch()` | 四种页面统一**手动触发**：`__dyRun` 由原生「开始抓取」按钮调用，带 `__dyRunning` 重入保护，结束后 `onResult` / `onError` 回传；`watch` 每 1s 探测「有 canvas 且命中区块标题」，就绪后不再每秒重扫整页，仅在 SPA 路由（`location.href`）变化时重新探测并提示；300 次（约 5 分钟）仍未就绪则提示检查页面；脚本本身从不自动抓取 |

---

## 五、综合排名分析页 `RankingActivity.java` + `assets/ranking.html` + `assets/scoring.js`

抓取成功后点底部「综合排名」进入本页，把人群分析 CSV 直接灌入内置排名工具，**无需手动导出/上传**。

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 页面承载 | `RankingActivity.onCreate` / `onPause` / `onResume` / `onDestroy` | 全屏 WebView 加载 `file:///android_asset/ranking.html`；页面就绪后 `evaluateJavascript` 调 `window.loadFromCsv(csv, keyword, pageType)` 自动分析（`JSONObject.quote` 生成合法 JS 字符串，CSV 内引号/换行/反斜杠均安全）；切后台 `webView.onPause()` 停 JS 计时器与渲染，回前台 `onResume()`；销毁时先 `stopLoading` → 摘除 `DyRankingBridge` → 从视图树移除 → `destroy()`，避免 WebView/Activity 泄漏 |
| 入参 | `EXTRA_CSV`、`EXTRA_KEYWORD`、`EXTRA_PAGE_TYPE`、`stageCsv()`、`takeStagedCsv()`、`injectCsv()` | CSV 走同进程静态暂存（`stageCsv` 写入、`onCreate` 用 `takeStagedCsv` 取走并清空），避免大 CSV 走 Intent extra 撞 Binder 上限；暂存为空时才回退读 `EXTRA_CSV`（兼容外部带 extra 启动）；`EXTRA_KEYWORD` / `EXTRA_PAGE_TYPE` 仍随 Intent 传递；`injectCsv` 对空 CSV / 已销毁 WebView 直接返回（`onPageFinished` 可能在 `onDestroy` 之后回调） |
| 页型标签 | `PAGE_TYPE_LABEL` / `tipsHTML()` | 控制区标题按页型显示「当前关键词 / 当前话题 / 当前达人 / 当前视频」；标签独占一行居中、`white-space:nowrap` 固定不收缩（不会被长标题压成竖排），正文**完整展示不截断**，仅在超长英文串处强制换行 |
| 数据入口 | `window.loadFromCsv()`、`parseCsv()`、`parseCsvText()` | 原生传入 CSV 文本 → 内置 RFC4180 解析器（无第三方依赖，返回**二维数组**）→ `buildTable` → `processTable`；自动完成清洗、打分、四象限、二级混合榜。两条入口共用同一解析器：原生走 `loadFromCsv → parseCsvText`，网页版走 `handleFile → parseCsv → parseCsvText`，后者只做「空结果判错」，不得再按 PapaParse 的 `{ rows }` 结构取数 |
| 预挂载入口 | `window.__rankingPayload`、`window.__autoLoadRanking()` | 原生可在注入前把 `{csv, keyword, pageType}` 挂到 `window`，`init()` 检测到即自动载入，省去 `evaluateJavascript` 的时序等待 |
| 原生回传桥 | `DyRankingBridge`（`window.DyRankingBridge`） | `exportCsv(text, name)`：页面「导出结果」交由原生写入系统下载目录；`.xlsx` 走 base64 解码后二进制写入，`.csv` 走 UTF-8 字节写入；**先把数据完整写进缓存临时文件，成功后才覆盖下载目录里的同名文件**，写入失败删掉半截文件（不再留下被截断的「假完整」文件）；文件名经 `CsvUtils.sanitizeFileName` 净化；成功/失败由原生 Toast 单条提示（WebView 内 `<a download>` 不落盘）；`close()`：「返回抓取」关闭本 Activity |
| 导出落盘细节 | `exportCsv()`、`findDownloadsFile()`、`doneValues()`、`toast()` | Android 10+ 走 MediaStore（`RELATIVE_PATH=Downloads`），先按 `DISPLAY_NAME + RELATIVE_PATH` 查同名文件，存在则复用 URI 并先标 pending；失败时删除半截文件；Android 9 及以下写 `getExternalFilesDir(DOWNLOADS)` |
| 页面日志 | `RankingActivity.onConsoleMessage` | 页面 console → logcat（tag `DyRankJS`），便于排查分析与导出问题 |
| 多 Sheet 导出 | `buildMultiSheetXlsx()`、`xlsxSheetXml()`、`zipStore()`、`crc32()` | 纯 JS OOXML 生成器（CRC32 查表 + zip STORED + 文本列 inline strings），一个区块一个 sheet；**数值列（TGI / S / P / 综合分 / 名次）写成真正的数字单元格**，Excel 里可直接排序、求和；区块 sheet 隐藏「R（相对父类占比）」「R 判定」两列（10 列），**二级混合总榜** sheet 保留全部 12 列；仅对有数据的区块生成 sheet，顺序固定为 `STANDARD_BLOCKS` + 二级混合总榜 |
| 导出命名 | `state.currentKeyword` | 文件名 `抖音指数_<页名>_综合排名.xlsx` 与页面标题都取自抓取侧的页名（`pageName`）；关键词/话题页=页头主题 chip、达人页=昵称、视频页=视频标题（不使用达人抖音号）。表内不再重复写 `关键词 / 榜单名称 / 分组名` 三列（文件名与 sheet 名已表达）。原生注入时 `loadFromCsv` 标记 `meta.nativeName`，`cleanData` 直接沿用该页名、不再按文件名规则二次截断，保证一致 |
| 排名算法 | `assets/scoring.js`（`DyScoring.scoreRows` / `compositeOf` / `robustZ`） | 占比→规模分 S、TGI→偏好分 P：两维先在 log 空间做稳健标准化（中位数 0、1 IQR=1，IQR 有 `ln(1.2)` 下限防窄分布放大），再用有界单调映射 `100/(1+e^(-ln3·z))` 转为分数（中位数 50 分、1 IQR 对应 75/25 分、值域 (0,100) 且不做硬截断）；composite = `S^wS · P^(1-wS)` 几何合成（主榜 wS=0.5，任一维为 0 则综合分为 0，避免 0% 占比被高 TGI 抬进中上游）；名次区间 = wS∈{0.3,0.5,0.7} 三种权重下的最好/最差名次；四象限以 S/P 是否 ≥50 判定（HH 重点机会 / HL / LH / LL），某维 IQR=0（全榜无差异）时不判定四象限并提示「该维无差异」；样本 n&lt;2 时返回 NaN 并标记 `flatS/flatP`。注意 `share` 入参是小数（0.09=9%），与展示口径一致 |
| 二级类目 R | `buildParentIndex()`、`isSecondaryRow()`、`computeR()` | R = 二级占比 ÷ 父类占比 ×100，**仅作说明列，不参与综合分与排名**；父类优先取抓取侧显式 `父类` 字段、旧文件回退 `_` 前缀；判定为「高于父类 / 未超父类 / 父类缺失 / 父类重复 / 父类占比为 0」的中性状态，R&gt;100 说明一/二级并非严格加和拆分，不做褒贬评价 |
| 榜单计算 | `buildList()`、`buildKeywordResult()`、`rowsOf()`、`interpretationOf()` | `rowsOf(block)` 从 `cleanData` 预建的分组索引（`grouped`）按「关键词 + 区块」取行，避免对全量 `kept` 反复 `filter`；按区块生成榜单（兴趣块只用一级类目、剔除 TGI 异常与父类重复行；手机价格按出现顺序打档位序号并去重，复制副本再写 `seq` 不污染原始记录）；排序键依次为综合分、占比、TGI、名称（`Intl.Collator` 中文排序）、原始行号，保证稳定可复现；`interpretationOf` 按四象限给一句话解读；二级子类另组「二级混合总榜」（只要有二级行就生成，1 条也保留） |
| 评分内部实现 | `VERSION`、`DEFAULT_EPS_SHARE`、`DEFAULT_EPS_TGI`、`DEFAULT_IQR_FLOOR`、`LINK_K`、`WEIGHT_SET`、`logSafe()`、`medianOfSorted()`、`quantileOfSorted()`、`robustZ()`、`scoreOfZ()`、`compositeOf()`、`orderBy()`、`scoreRows()`、`ascending()` | 纯函数、无 DOM 依赖：`logSafe` 规避 ln(0)；中位数/分位数在已排序数组上取值；`robustZ` 输出 log 空间稳健 z（IQR 下限 `DEFAULT_IQR_FLOOR`）；`scoreOfZ` 为有界映射；`compositeOf` 几何合成且任一分量为 0 即 0；`WEIGHT_SET = [0.3,0.5,0.7]` 依次算出区间名次；`scoreRows` 一次返回 `composite/s/sShare/p/pShare/rank/best/worst/q/flatS/flatP`，并由 UMD 包装同时支持浏览器全局与 Node `require` |
| 标准区块 | `STANDARD_BLOCKS` | 地域分布-城市/城市级别/省份、年龄分布、性别分布、用户内容浏览分布、手机价格分布、手机品牌分布；缺失区块在覆盖率中如实标注，且不生成空 sheet |
| 资产独立性 | `ranking.html` | HTML5 标准模式（`<!DOCTYPE html>`）；已剥离 PapaParse/SheetJS CDN 与文件上传 UI，仅保留分析逻辑与渲染，可离线运行；CSV 解析统一走内联 `parseCsvText`（不依赖 PapaParse），Excel 解析在 XLSX 未加载时给出明确提示而非崩溃（`CDN_OK = typeof XLSX !== 'undefined'`，当前恒为 false，即仅支持 CSV/JSON）。上传解析函数 `handleFile()` 仍保留，网页版由 `pwa-src/web-boot.js` 重新挂载导入入口后复用同一条解析链路（`handleFile → parseCsv → parseCsvText`）；新增 CSV 入口一律直接消费 `parseCsvText` 的二维数组返回值，避免出现第二套解析/取数约定 |

### 5.1 解析、清洗与状态

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 运行时状态 | `state` | `status`（idle/parsing/analyzing/success/error）、`file`、`hasKeywordField`、`keywords`、`currentKeyword`、`pageType`、`clean`、`keywordMeta`、`resultCache`（按关键词缓存榜单结果）、`sortState`（按表格缓存排序键/方向）、`generation`（异步任务代际令牌）、`collapsed`、`activeReader`（可中断的 FileReader）、`tableRegistry` / `domIdMap`（列表 id ↔ DOM 表 id）、`activeNavObserver`、`_stickyOffsetCache` |
| 代际令牌 | `state.generation`、`resetForNewData()`、`clearAll()`、`loadFromCsv()` | 每次换文件/清空/原生再注入都自增；所有异步步骤（读文件、解析、分析）回写前先比对 token，过期结果直接丢弃；`loadFromCsv` 进入时自增并 `abort()` 进行中的 FileReader，避免上一份表的异步回调覆盖刚注入的新数据 |
| 常量 | `MAX_UPLOAD_MB`(50)、`ENCODING_FFFD_MAX`(20)、`ENCODING_RATIO_MAX`(0.005)、`RANK_DISPLAY_LIMIT`(100)、`LIST_TRUNCATE`(20)、`ANOMALY_SAMPLE_MAX`(20)、`KEYWORD_NULL_RATIO_ALERT`(0.3)、`SEP`、`CONTENT_BLOCK`、`UNLABELED_KW`、`SINGLE_KW`、`SAMPLE_SOURCE`、`STANDARD_BLOCKS`、`QUADRANT_TEXT/CLASS` | 上传上限与提示、UTF-8 坏字判定、展示条数上限、异常明细截断、关键词空值率告警、内部键分隔符、内容浏览块名、未标注/单关键词占位名、内置示例名、区块白名单、四象限文案与样式 |
| 文本归一 | `toHalfWidth()`、`stripBOM()`、`trimAll()`、`normHeaderCell()`、`normCell()`、`blankText()`、`isBlankRow()`、`cellToText()`、`isoDate()`、`deriveKeywordFromName()` | 全角转半角、去 BOM、去首尾空白、表头/单元格归一（全角空格、零宽字符）、空白行判定、单元格转文本（含日期格式化与告警计数）、由文件名推导关键词（匹配「抖音指数 / 人群分析」等前后缀） |
| 数字解析 | `parseNumericString()`、`ascending()` | 去空白/千分位 → 全角转半角 → 识别并剥离 `%` → 严格正则校验；返回 `{ok, value, hadPct, raw}`，非法值不参与计算 |
| 通用工具 | `err()`、`el()`、`fmt()`、`esc()`、`isFiniteNumber()`、`collator()`、`note()` | `err` 构造 `{code,message,detail}` 错误对象；`el` 取元素；`fmt` 统一数值展示（非数字显示「—」）；`esc` 做 HTML 实体转义（所有拼接进 innerHTML 的外部文本必须先过它）；`collator` 懒加载中文 `Intl.Collator`（多级 locale 回退）；`note` 按截断上限收集异常样例 |
| 文件读取 | `readArrayBuffer()`、`decodeUtf8()`、`checkEncoding()` | FileReader 包装为 Promise（记录 `activeReader` 以支持中断）；UTF-8 解码并逐字符统计 U+FFFD；坏字数量或比例超阈值即报「请另存为 UTF-8」 |
| 格式解析 | `parseCsvText()`、`parseCsv()`、`parseExcel()`、`jsonToRows()`、`objectArrayField()` | 内置 RFC4180 解析器（BOM、`\r\n`/`\n`、双引号转义、仅字段起始处的 `"` 进入引用态）；`parseCsv` 只判空；Excel 依赖 XLSX（未加载时明确报错，当前仅支持 CSV/JSON）；JSON 支持对象数组或「包含对象数组字段的对象」，并取所有对象键的并集作为表头 |
| 表结构 | `buildTable()`、`matchFields()`、`FIELD_SPEC`、`keywordOptionLabel()` | 取首行表头、丢弃空行、超长行截断并统计多余单元格、短行补空；按「区块/分类/占比/TGI 必需，父类/关键词可选」匹配字段（字段名重复取第一列并提示）；关键词下拉文案对「未标注关键词」加核查提示 |
| 数据清洗 | `cleanData()` + `stats` / `anomalies` / `samples` / `blocksPresent` / `blocksMissing` | 固定 9 步：①字段与值规范化（关键词空值归「未标注关键词」并计数）→②区块/分类空值行剔除→③占比解析（带 `%` 则除以 100 并校验 0–1；不带 `%` 时 ≤1 视为小数、&gt;1 且 ≤100 自动除以 100、&gt;100 判非法）→④TGI 解析（带 `%` 仅记异常、负数剔除）→⑤非标准区块剔除→⑥占比与 TGI 双 0 行剔除→⑦TGI=0 且占比&gt;0 标记异常（保留）→⑧重复检测（普通行按「关键词+区块+分类」去重，**跳过 TGI 异常行**，避免它抢先占键挤掉同组正常行；兴趣一级类目重复单独标记 `_parentDup`，不删除）→⑨产出 `kept` / `grouped` / `countByKeyword` / `parentInfo` 索引；同时统计多余单元格、日期格式化与关键词空值率超 30% 的软提示 |
| 示例数据 | `makeSampleTable()`、`loadSample()` | 程序内置一份可直接演示的表头与数据行，覆盖主要区块；加载前若已有文件需确认覆盖，并走与真实文件相同的 `buildTable → processTable` 链路 |

### 5.2 渲染与交互

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 主流程 | `handleFile()`、`processTable()`、`analyzeKeyword()`、`resetForNewData()`、`clearAll()`、`setupKeywordUI()`、`scrollToResultsTop()` | `handleFile`：扩展名/大小校验 → 代际令牌 → 读文件 → 编码校验 → 解析 → `buildTable`；`processTable`：表头/数据行/必需字段校验 → `cleanData` → 关键词排序（未标注置底）→ 重置缓存 → 首个关键词分析；`analyzeKeyword` 命中 `resultCache` 则直接渲染，否则计算并带令牌回写；`setupKeywordUI` 按「有无关键词列」显示/隐藏下拉；`scrollToResultsTop` 按吸顶偏移滚到结果区；`clearAll` 中断读取、清空状态与 UI |
| 结果渲染 | `renderResults()`、`blockCardsHTML()`、`mixedHTML()`、`tableHTML()`、`buildBlockTableHTML()`、`buildMixedTableHTML()`、`blockNOf()`、`listById()` | 只渲染实际存在的区块卡片；每卡显示「榜单有效记录 n 条 / Top100」；无任何标准区块时给出兜底文案；混合总榜附算法口径说明；渲染前重建 `domIdMap` / `tableRegistry`；`listById` 由列表 id 反查 `blockLists` / `mixed`，`blockNOf` 取指定区块的有效条数 |
| 单元格渲染 | `formatShare()`、`numText()`、`quadrantCell()`、`rStatusTag()`、`kv` / `badge` | 占比按百分数展示、TGI 数值化、四象限标签着色、R 状态标签（高于父类/未超父类/父类缺失等） |
| 顶部提示 | `tipsHTML()`、`blockHint()`、`safeAnchor()` | 按页型生成「当前关键词/话题/达人/视频」与副标题；区块说明随区块变化；区块名转安全锚点 id |
| 排序 | `getSort()`、`sortValue()`、`bindSortHandlers()`、`bindSortHandlersOne()`、`refreshTable()`、`thSort()`、`displayRows()`、`doSort()` | 每个表格独立记录排序键与方向（默认 `rank` 升序）；`sortValue` 支持综合分、占比、TGI、名称、`rank`、`rankLo`（名次区间，缺值退 `rank`）、`R`；`doSort` 同一列再次点击翻转方向、换列则重置为升序，只重排该表并保留其它表状态；通过 `tableRegistry` 从 DOM 表 id 反查列表 id；`displayRows` 按 `RANK_DISPLAY_LIMIT` 截断展示 |
| 导航与吸顶 | `stickyOffset()`、`refreshSticky()`、`setupNav()`、`setActiveNav()`、`teardownNav()` | 动态生成区块目录；`IntersectionObserver` 同步高亮；滚动点击按「topbar + 控制区 + nav」偏移精确定位；窗口 resize / 控制区折叠后重算 CSS 变量 `--sticky-h`、`--nav-h` |
| 反馈与错误 | `showLoading()`、`showError()`、`clearError()`、`clearLoadingArea()`、`setStatus()`、`showToast()` | 加载态（保留旧结果或清空两种模式）、错误条（可关闭，关闭后按当前状态恢复）、状态机切换、轻提示 |
| UI 状态同步 | `syncUI()`、`hasValidRecords()`、`currentResult()` | 按 `state.status` 统一启停「示例 / 重新分析 / 导出 / 清空 / 折叠」等按钮并同步顶部摘要；`hasValidRecords` 汇总混合榜与各区块有效条数（全 0 禁止导出）；`currentResult` 取当前关键词缓存结果 |
| 交互绑定与启动 | `bindEvents()`、`init()`、`setCollapsed()` | 绑定示例/重新分析/导出/清空/折叠/关键词切换/目录点击/resize；`init` 默认折叠控制区、绑定「返回抓取」（优先原生桥 `close()`，浏览器退回 history）、刷新吸顶偏移、有预挂载数据则自动载入 |

### 5.3 导出

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 记录与行组装 | `buildExportRecords()`、`exportCells()`、`numCell()`、`rankRangeText()`、`pickCols()` | 只导出实际存在区块的行；区块行留空 R / R 判定，混合榜填入 R 值；名次区间两端相同只显示一个名次；空解读转空字符串；`numCell` 把 TGI / S / P / 综合分 / 名次保留位数但返回 `number`，供 xlsx 写成数字单元格；`pickCols` 按区块 sheet 的列索引裁剪单元格（隐藏 R 两列） |
| 进度节点 | `exportProgressNode()` | 在结果区顶部插入/更新导出进度卡片，完成后移除 |
| 导出入口 | `exportCSV()` | 校验结果与令牌 → 生成 xlsx 字节 → 优先 `window.DyRankingBridge.exportCsv(base64, 文件名)` 交原生落盘；无桥时退回 Blob `<a download>`（1.5s 后释放 URL） |
| xlsx 底层 | `utf8Bytes()`、`xmlEsc()`、`colLetter()`、`CRC_TABLE`、`crc32()`、`putU16()`、`putU32()`、`zipStore()`、`bytesToBase64()` | UTF-8 编码与 XML 转义（剔除 XML 1.0 非法控制字符）；列号转字母；CRC32 查表（一次建表，比逐位运算快约 8 倍）与 ZIP 本地头/中央目录（STORED 不压缩）；base64 分块转换（8KB）避免大表字符串拼接卡顿 |

---

## 六、构建与交付链

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| 模块构建脚本 | `app/build.gradle` | release 签名绑定、**版本号自动派生**、compileSdk 34 / minSdk 26 / targetSdk 34 |
| 版本号派生 | `app/build.gradle` 的 `VERSION_NAME_BASE` + `dyBuildNumber` + `VERSION_NAME_FULL` | `versionName = 基础版本 + '.' + git 提交数`、`versionCode = 25 + 提交数`；CI 可用 `DYINDEX_BUILD_NUMBER` 覆盖（浅克隆时保证与 PWA / 用户脚本一致） |
| 签名前置校验 | `app/build.gradle` 的 `gradle.taskGraph` 检查 | 请求 release 产物但 `keystore.properties`／字段／keystore 文件缺失时**立即失败并给出提示**，不静默产出未签名包；debug 构建不受影响 |
| 混淆 keep 规则 | `app/proguard-rules.pro` | 保留 `@JavascriptInterface` 注解与方法、注入桥 `DyBridge` 全部成员，防日后开启混淆导致桥失效（当前 `minifyEnabled false`，规则为前置保险） |
| 工程构建脚本 | `build.gradle`、`settings.gradle`、`gradle.properties` | AGP 8.13.0 + 镜像仓库 + 模块声明；Gradle 侧固定 UTF-8、并行构建、AndroidX、非传递 R 类；依赖连接/读取超时放宽到 120s，JDK 由 `JAVA_HOME` 决定（CI 用 setup-java 提供 Java 17） |
| Gradle Wrapper | `gradle/wrapper/gradle-wrapper.properties`、`gradlew`、`gradlew.bat` | Gradle 8.14.5（腾讯镜像下载），保证本机与 CI 使用同一版本 |
| 构建依赖 | `app/build.gradle` | 无第三方运行时依赖；仅 `testImplementation junit:4.13.2`；Java 17 源/目标兼容 |
| 应用清单 | `app/src/main/AndroidManifest.xml` | 权限：`INTERNET`、`REQUEST_INSTALL_PACKAGES`；`MainActivity` 为 launcher（`exported=true`，`windowSoftInputMode=adjustResize`，`configChanges` 含 orientation/screenSize/smallestScreenSize/screenLayout/keyboardHidden/uiMode，旋转不重建 WebView、不丢抓取状态）；`RankingActivity` 不导出；`ApkFileProvider` 以 `${applicationId}.apk` 声明 `exported=false` + `grantUriPermissions=true`（只经临时 URI 授权开放读取）；`allowBackup` / 硬件加速开启，应用主题无 ActionBar |
| 应用资源 | `app/src/main/res/` | `strings.xml` 应用名「指数人群抓取」；`colors.xml` 品牌色 `#2F6DF6`；`themes.xml` 基于 Material Light 的无 ActionBar 主题；`mipmap-anydpi-v26/ic_launcher*.xml` 自适应图标 + `drawable/ic_launcher_foreground.xml` 前景矢量图（界面全部代码绘制，无 XML 布局文件） |
| 密钥隔离 | `.gitignore` | 排除 `release.jks`、`keystore.properties`、`local.properties`、构建产物、`pwa-dist/` |
| Java 单元测试闸门 | `.github/workflows/release.yml`「单元测试」步骤 | `assembleRelease` 之前先跑 `./gradlew test`，测试不过直接 fail，不产出也不发布 APK |
| 评分模块单测 | `tools/scoring.test.js` | Node 内置 `node:test`（零依赖，直接 `require` 资产里的 `scoring.js`，靠其 UMD 包装的 CommonJS 分支导出），覆盖：头部不同分不饱和、0% 占比+高 TGI 沉底、名次区间单调且为 1..n 排列、宽分布下分值严格可区分且恒正、单维相同记 50 分并标 `flat`、n=1 返回 NaN、结果可复现、综合分与名次单调一致、负数/非法输入不产生 NaN。本地与 `pages.yml` 都会执行（`node --test tools/scoring.test.js`） |
| Release 发布 | `.github/workflows/release.yml` | **任何推送 main（.md 除外）即触发**，也支持推送 `v*` 标签 / 手动触发：校验 Secrets → 计算版本号 → **标签占用检查**（同一提交重复触发时版本号不变，直接发布会把新 APK 挂到旧 Release）→ 还原签名文件 → 切 Gradle 官方源 → **单元测试** → `assembleRelease` → 产物校验（存在性 / `apksigner verify` / 包内含 `assets/extract.js`）→ 生成带版本号资产与 SHA256 → **生成 Release 说明**（`git log -1 --pretty=%B` 取触发提交的完整信息，含多行正文）→ 以 `v<版本>` 建标签、用该说明作 `body` 发布 Release |
| PWA 构建脚本 | `tools/build-pwa.js` | 版本派生（`buildNumber()` / `appVersionBase()` / `fullVersion()`，与 Gradle 同算法）；`buildIndexHtml()` 只追加 head 元数据与 `web-boot.js`；`readPageUrlTemplates()` 从 `AppUrls.java` 正则解析四条 URL 模板；`buildUserscript()` 拼装头部与 `userscript-controller.js + extract.js`；纯 Node 生成三档 PNG 图标（块 CRC 覆盖「类型 + 数据」，符合 PNG 规范）；输出文件清单与总大小 |
| PWA 部署流水线 | `.github/workflows/pages.yml` | 推送 `main`（`**.md` 除外）即触发：`node tools/build-pwa.js` → **语法检查 + 评分单测**（`node --check` 四个脚本、`node --test tools/scoring.test.js`）→ **产物自检** → 上传 Pages 产物 → 部署 GitHub Pages；`workflow_dispatch` 可手动重发 |
| PWA 产物自检 | `.github/workflows/pages.yml`「产物自检」步骤 | 10 个关键文件非空；三档图标必须被 `file` 识别为对应尺寸的 PNG（防止 CRC/编码错误悄悄发布）；`index.html` 含 `rel="manifest"` 与 `src="web-boot.js"`；用户脚本含 `@match creator.douyin.com`、`window.__dyRun`、`@version`；`sw.js` 缓存名已注入 `dyrank-pwa-<版本>`；页面含 `name="dyrank-version"`；任一不满足即不发布 |

### 版本发布流程

```
改代码 → 提交并推送 main → CI 自动构建、自动递增版本并发布 Release + 更新 PWA
       → Release 正文 = 本次提交信息 → APK 升级后首次打开弹「更新内容」
```

**无需手动改版本号、无需手动打标签、无需本机执行构建命令**。版本号由「基础版本 + git 提交数」自动派生，每次提交必然递增。

推送 `main` 后由 CI 自动完成：

1. 校验签名 Secrets 是否齐全（缺失即失败，不白跑构建）
2. 计算版本号：`N = git rev-list --count HEAD`，`tag = v<基础版本>.<N>`，并以 `DYINDEX_BUILD_NUMBER` 传给 Gradle（推 `v*` 标签时直接沿用该标签）
3. 由 Secrets 还原 `release.jks` 与 `keystore.properties`（仅存在于本次 runner，用完销毁）
4. 将 Gradle 分发包从国内镜像切到官方源（境外 runner 拉取更稳）
5. **`./gradlew test`**：Java 单元测试不全绿即中止，绝不产出/发布半成品（评分模块的 Node 单测需本地另行执行）
6. `./gradlew assembleRelease`
7. **产物校验**：文件存在 → `apksigner verify --print-certs` 退出码判定（未签名/签名无效直接中止）→ 确认包内含 `assets/extract.js`（其余 assets 随打包天然包含）
8. 生成 `douyin-index-tool-v<版本>-release.apk` 与同名 `.sha256`
9. `git log -1 --pretty=%B > release-notes.md`：Release 正文直接取**触发本次构建的提交信息（含多行正文）**，APK 升级后首次打开的「更新内容」弹窗即展示它，无需人工补文案
10. 发布 Release（同一次推送内创建同名标签，`target_commitish` 指向本次提交，`body_path` 用上一步的提交信息），App 内 `Updater` 据此提示升级

### 签名配置约定

- **绝不入库**：`release.jks` 与 `keystore.properties` 均被 `.gitignore` 排除。私钥一旦泄露，他人可伪造出被系统当作「正版升级」接受的 APK
- CI 通过仓库 Secrets 提供签名信息：`SIGNING_KEYSTORE_BASE64`（keystore 的 base64）、`SIGNING_STORE_PASSWORD`、`SIGNING_KEY_ALIAS`、`SIGNING_KEY_PASSWORD`
- 本地缺少签名配置时 `assembleRelease` 会直接失败并给出提示；如需本地验证签名产物，需自行从安全位置恢复这两个文件
- 同类工程若换 keystore，务必沿用同一份密钥，否则无法覆盖升级（`Updater` 会识别签名不一致并引导卸载重装）

---

## 七、PWA 网页版（iPhone Safari）

**定位**：同一仓库派生的网页端，只负责「导入 CSV → 综合排名 → 导出 xlsx」，**页面本身不做抓取**。浏览器既不能向 `creator.douyin.com` 注入脚本，也无法读取跨域 DOM；网页端要用数据，只能靠同仓库派生的用户脚本在抖音页面内同源采集（见下「网页端抓取脚本」）。

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| 转换构建 | `tools/build-pwa.js` | 读取 `app/src/main/assets/ranking.html`，仅在 `</head>` / `</body>` 前追加 PWA 元数据与启动脚本 → 输出 `pwa-dist/`（已 gitignore）。复制 `assets/scoring.js`（与 App 共用同一份算法，绝不另存副本）；注入 `sw.js` 缓存版本与用户脚本 `@version`；用 Node 内置 `zlib` 程序化生成图标（零依赖，CI 可复现）。源文件缺少 `</head>` / `</body>` / `scoring.js` 引用、模板缺少 `{kw}` 或 `__PAGE_URLS__` 注入点、`extract.js` 未导出 `window.__dyRun` 时直接失败 |
| 构建内部函数 | `main()`、`emit()`、`readUtf8()`、`writeFile()`、`fail()`、`buildNumber()`、`appVersionBase()`、`fullVersion()`、`crc32()`、`pngChunk()`、`pngEncode()`、`inRoundRect()`、`lerp()`、`renderIcon()` | `main` 清理并重建 `pwa-dist/`，`emit` 逐文件写入并累计体积；`readUtf8` 读源文件、`writeFile` 自动建目录；`fail` 打印原因并以非零码退出（CI 立即失败）；版本三函数与 Gradle 同算法；PNG 部分为 IHDR/IDAT/IEND 手写编码 + 圆角矩形逐像素渲染（`inRoundRect` 判边界、`lerp` 取底色渐变） |
| 页面 | `pwa-dist/index.html` | 与 Android 端同一份排名页，业务逻辑零改动；两端差异只有注入的标签（`dyrank-version`、theme-color、Apple standalone 系列 meta、manifest、apple-touch-icon、`web.css`）与底部 `web-boot.js` 启动脚本，改口径只需改 `ranking.html` 一处 |
| 应用清单 | `pwa-src/manifest.webmanifest` | `name/short_name`（抖音指数综合排名 / 抖音指数排名）、`lang: zh-CN`、`id: ./`（换地址时避免被识别成另一个应用）、`start_url: ./` + `scope: ./`（GitHub Pages 子路径部署同样可用）、`display: standalone`、`orientation: portrait`、`background_color: #f5f7fa`、`theme_color: #2563eb`、192/512 `purpose: any` 图标 |
| 离线缓存 | `pwa-src/sw.js` | `CACHE_NAME = dyrank-pwa-<版本>`（构建注入）；安装即预缓存 8 项：`index.html`、`scoring.js`、`web-boot.js`、`web.css`、`manifest.webmanifest`、三档图标（`./` 与 `index.html` 同文档，不再重复缓存）；预缓存逐项 `put`，单个资源 404 不会让整次安装失败；`install` 完成后 `skipWaiting()`，`activate` **只清 `dyrank-pwa-` 前缀的旧缓存**（同域可能还有其它 Pages 项目的缓存）并 `clients.claim()`；`fetch`：导航请求网络优先（**仅 `res.ok` 才回写 `index.html`**，`cache.put` 均包在 `waitUntil` 里避免 SW 提前终止丢更新；离线回退缓存，无缓存返回 504），同源静态资源缓存优先 + 后台更新（缓存未命中且断网返回 504，不再 `respondWith(undefined)`），跨域请求原样放行，非 GET 不接管 |
| 启动脚本 | `pwa-src/web-boot.js`（`byId`、`toast`、`formatSize`、`adaptNativeOnlyUI`、`hasLoadedData`、`mountImportCard`、`importFile`、`importFromClipboard`、`mountInstallHint`、`mountHelpButton`、`buildHelp`、`openHelp`、`closeHelp`、`registerServiceWorker`、`checkUpdate`） | ①`adaptNativeOnlyUI` 隐藏原生专属入口：「返回抓取」（依赖原生桥关闭 Activity）、「重新分析」（导入后无意义），放出「加载示例数据」；②`mountImportCard` 在控制区注入「选择 CSV 文件 / 粘贴 CSV」导入卡片，`importFile` 先做 **50MB 硬上限**（与页面 `MAX_UPLOAD_MB` 一致，超限直接拒绝，避免整个读进内存），再交给页面内置 `handleFile()`，复用同一条「编码校验 → `parseCsv`（内联 `parseCsvText`）→ 清洗 → 评分 → 渲染」链路，与原生注入使用同一个解析器，并以页面真实状态 `state.status === 'success'` 判定本次导入是否成功（不再用导出按钮的 disabled 状态误判）；`importFromClipboard` 把剪贴板内容包装成 `File` 走同一链路，旧浏览器不支持 `File` 构造器时退回 `loadFromCsv(text, '剪贴板导入', '')`；③`mountInstallHint` 首次访问显示「添加到主屏幕」提示，关闭后写入 localStorage（隐私模式下不可用则每次展示）；④`registerServiceWorker` 在 `load` 后注册 SW，并在 `visibilitychange` 回前台时 `checkUpdate()`（`reg.update()`）；⑤改写首页空状态文案为导入引导；⑥`mountHelpButton` 顶栏「iPhone 用法」按钮 → `buildHelp` 底部弹层教程（添加主屏 / 安装抓取脚本 / 抓取并导入 / 离线 / 常见问题），`openHelp`/`closeHelp` 支持遮罩点击与 Esc 关闭 |
| 补充样式 | `pwa-src/web.css` | 导入卡片、提示条、帮助弹层；并为 `#backBtn[hidden]` / `#reanalyzeBtn[hidden]` / `#sampleBtn[hidden]` 补显式 `display:none`——`.btn` 的 `inline-flex` 会盖掉浏览器对 `[hidden]` 的默认样式 |
| 图标 | 构建期生成 `icons/icon-192.png`、`icon-512.png`、`icon-180.png` | PNG 编码手写（IHDR/IDAT/IEND + CRC32），无需 canvas 或三方库；manifest 用透明圆角版（`renderIcon(size, true)`），apple-touch-icon 用满幅方形（`false`）交由 iOS 自行切圆角 |
| 用户脚本（网页端抓取） | `pwa-src/userscript-controller.js` → 构建产物 `pwa-dist/douyin-index-extract.user.js` | 网页端唯一的抓取形态：脚本注入 `creator.douyin.com` 页面内（同源），直接复用 `assets/extract.js` 的采集实现（由构建脚本原样拼接，不复制逻辑）；控制器提供 `window.DyBridge` 的网页版实现（`onLog` / `onResult` / `onError`）、右下角「抓取数据」悬浮按钮（Shadow DOM 隔离样式）、抓完后的「复制 CSV / 下载 CSV / 打开排名页」、以及「打开页面」四入口——输入关键词后一键直达关键词分析 / 达人搜索 / 视频搜索 / 话题搜索（URL 构造与 Android 端 `AppUrls` 一致）；`@match` 限定 creator 域、`@grant none`、`@run-at document-idle`、`@noframes`、`@updateURL` / `@downloadURL` 指向 Pages 上的同一文件 |
| 用户脚本 UI 生命周期 | `boot()`、`mountUI()`、`ensureUI()`、`toggleLauncher()`、`run()`、`start()`、`finish()`、`setStatus()`、`setLaunchTip()`、`showError()` | `boot` 挂载 Shadow DOM 面板并恢复上次关键词，之后每 1.5s 检查面板是否仍连接（创作者中心切路由可能整体替换 body，检测到丢失就重建）；`run` 校验未在抓取中 → `start` 置忙态 → 调用 `window.__dyRun()` → `finish` 恢复；3 分钟兜底定时器保存在 `runTimer`，新一轮开始或 `finish` 时清除，避免提前结束下一轮抓取；`setStatus` / `setLaunchTip` 同步面板状态行与错误色；`toggleLauncher` 折叠/展开面板；`showError` 展示失败原因并提示查看控制台 |
| 用户脚本头部 | `buildUserscript()` 生成 | `@name` 抖音指数人群分析抓取（网页版）、`@namespace`（仓库地址）、`@version` = 完整版本号（与 APK/PWA 同源）、`@description`、`@match https://creator.douyin.com/*`、`@run-at document-idle`、`@grant none`、`@noframes`、`@homepageURL` / `@downloadURL` / `@updateURL` |
| 四入口地址模板 | `readPageUrlTemplates()` + `PAGE_URLS` + `pageUrl(type, kw)` | 构建时从 `AppUrls.java` 解析 `BASE_URL`、四个路径常量与各 `return` 表达式，生成含 `{kw}` 占位符的模板注入用户脚本：keyword = `<BASE>/analysis?keyword={kw}&tab=crowd&appName=aweme&source=creator`、daren = `<BASE>/daren/search?keyword={kw}`、video = `<BASE>/videosearch?query={kw}`、topic = `<BASE>/topicsearch?topic={kw}`；`pageUrl()` 用 `encodeURIComponent` 替换占位符，`openPage()` 在当前标签页跳转（脚本随新页面再次注入）。改 APK 地址或参数后脚本自动跟随 |
| 复制 / 下载 CSV | `showResult()`、`doCopy()`、`doDownload()`、`copyText()`、`fallbackCopy()` | 抓完自动尝试复制一次（Safari 因非用户手势可能拒绝，则提示手动点按钮）；优先 `navigator.clipboard.writeText`，被拒时退回隐藏 textarea + `document.execCommand('copy')`；下载用 Blob（前置 BOM 保证 Excel 不乱码）+ `<a download>`，文件名 `抖音指数_<页名>_<页型>.csv`（非法字符替换、限 80 字），2s 后释放 URL |
| 部署 | `.github/workflows/pages.yml` | 推送 `main` 自动转换并发布到 GitHub Pages：构建 → `node --check` 四个脚本 + `node --test tools/scoring.test.js` → 产物自检（关键文件 / 图标尺寸 / 注入标记）不通过即失败；见「六、构建与交付链」 |
| 使用方式（iPhone） | Safari 打开线上地址 → 分享 → 添加到主屏幕 | 全屏无地址栏运行；首次联网后资源进缓存，断网仍可导入分析；数据只在本机处理 |
| 与 App 的边界 | — | 数据来源：只用「网页端抓取脚本」复制/下载 CSV 后导入；导出沿用页面既有逻辑，网页端走浏览器下载（不写系统下载目录）；Excel 解析依赖 XLSX，网页版未加载该库，故仅支持 CSV / JSON |

### APK 改动如何自动同步到脚本与 PWA

两端不维护第二份实现：APK 侧改动在构建期进入网页产物，推送 `main` 即自动重建并发布（纯 `.md` 除外）。

| APK 侧改动 | 同步方式 | 作用位置 |
| --- | --- | --- |
| `assets/ranking.html`（页面 / 交互 / 导出） | 构建时整页转换，只追加 PWA 标签与启动脚本 | PWA `index.html` |
| `assets/scoring.js`（评分口径） | 原样复制，不另存副本 | PWA `scoring.js` |
| `assets/extract.js`（抓取实现） | 原样拼接进用户脚本 | `.user.js` 的抓取逻辑 |
| `AppUrls.java`（页面地址 / 参数） | 构建时解析 `BASE_URL`、路径常量与 `return` 表达式 → 注入 `PAGE_URLS` | 脚本「打开页面」四入口 |
| `app/build.gradle` 的 `VERSION_NAME_BASE` + 构建号 | 生成用户脚本 `@version`、SW 缓存名、页面版本标记（与 APK `versionName` 完全同一算法、同一数值） | 扩展自动更新、PWA 自动换缓存 |

版本与升级链路：`versionName = VERSION_NAME_BASE + '.' + 提交数`（APK、PWA、用户脚本三者同版本），每次提交必然递增：APK 由 `release.yml` 在推送 `main` 时自动构建并以同版本 `v*` 标签发布，Release 正文即触发提交的完整信息，`Updater` 比对 `tag_name` 后提示升级，装完首次打开再弹「更新内容」；**激活页与主界面都会做后台静默检查更新**，未激活的用户也能拿到修复包；用户脚本按 `@updateURL` 定期检查并更新；PWA 的 `CACHE_NAME` 带同一版本，新 SW `skipWaiting` + `clients.claim` 立即接管，页面回到前台时还会主动 `reg.update()`，因此下次打开即为新内容。构建脚本解析 `AppUrls.java` / `VERSION_NAME_BASE` 失败会直接报错，杜绝两端悄悄分叉。

**本地自测**：`node tools/build-pwa.js` 后用任意静态服务器指向 `pwa-dist/`，浏览器打开即可验证导入、排名、导出；Service Worker 需要 `http://localhost` 或 https 环境才会注册。

### 网页端抓取脚本（可选，iPhone 上的另一条入口）

PWA 页面本身无法跨域抓取，但把脚本注入抖音页面内部（同源）就能抓。构建脚本会把 `pwa-src/userscript-controller.js` 与 `assets/extract.js` 拼成一个用户脚本，随 Pages 一起发布：

```
https://yejiawei19991118.github.io/douyin-index-tool/douyin-index-extract.user.js
```

安装与使用（iPhone）：

1. App Store 安装 **Userscripts**（Safari 扩展），在「设置 → Safari → 扩展」里启用，并允许其访问 `creator.douyin.com`
2. Safari 直接打开上面的 `.user.js` 地址 → 扩展会提示安装脚本
3. 打开抖音创作者中心的人群分析页，等图表渲染完成后点右下角「抓取数据」（页面会自动滚动、逐个下钻）；也可先在悬浮面板输入关键词，用四个入口直达对应页面
4. 抓完点「复制 CSV」→ 切到主屏的 PWA → 点「粘贴 CSV」；复制被拒时改用「下载 CSV」，再从「文件」App 导入

桌面 Chrome 也可用篡改猴（Tampermonkey）安装同一脚本。**风险**：采集依赖页面 CSS Modules 类名与 canvas tooltip 结构，抖音改版可能导致失效；高频抓取有账号风控风险，请控制频率并自行评估合规性。

---

## 八、卡密授权（登录激活）`LicenseManager.java` + `ActivationActivity.java`

与「卡密生成器」（`github.com/yejiawei19991118/lmt-cards`）同一套清单制式：清单 `cards.json` 由作者用私钥签发，App 只内置公钥验签，一卡一机、可吊销、可设有效期。

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 激活闸门 | `MainActivity.onCreate` | 未激活 / 激活失效时跳 `ActivationActivity` 并 `finish()`；通过后 `refreshIfStaleAsync()` 后台刷新清单 |
| 机器码 | `LicenseManager.machineCode(ctx)` / `machineCodeRaw(ctx)` | 展示/复制用 `XXXX-XXXX-XXXX-XXXX`；与清单 `cards[].mc` 比对必须用**无分隔符的 16 位原始值**（清单里的 mc 带 `-`，两侧统一 `normalize()` 后比较）。派生：`ANDROID_ID`（缺失退回 `MODEL\|DEVICE`）+ 固定盐 `\|dyindex` → SHA-256 → 自定义 base32 取 16 字符；重装 / 清数据 / 系统升级 / 换语言都不变 |
| 卡密格式 | `normalize()`、`cardFormatOk()` | 去分隔符并转大写；20 位 `[0-9A-Z]` |
| 清单拉取 | `fetchAndVerify()`、`MANIFEST_SOURCES` | 逐源尝试：raw.githubusercontent.com（内容最新）→ cdn.jsdelivr.net 镜像兜底；单源 5s 连接 / 8s 读取、整体 25s 预算；首个验签通过者生效并写缓存 |
| 清单验签 | `parseManifest()`、`canonicalManifestString()`、`Ed25519` | 只认 `ver=2`；规范化串 = `ver\nupdated\nrev\n<卡片行>\n<吊销列表>`（卡片行按 `mc + \0 + card` 排序，内容 `card\|mc\|note\|exp`）；内置公钥（base32 52 字符）做 RFC 8032 Ed25519 验签，失败一律不采纳 |
| 授权判定 | `decide()` | 顺序：已吊销 → 不在清单 → 一卡一机不匹配 → 已过期（`YYYY-MM-DD` 早于今天）→ 离线凭证超 14 天 |
| 离线凭证 | `KEY_CACHE`、`credFresh()`、`saveCache()`、`loadCachedManifest()` | 验签通过的清单 + 拉取时间缓存本地；超过 14 天必须联网刷新；系统时间回拨按过期处理；`loadCachedManifest` 在进程内缓存已验签对象（缓存串未变时直接复用），避免每次启动都在主线程重做 Ed25519 验签 |
| 激活 | `activate()` | 联网失败时退回缓存清单（离线凭证）；成功后写入卡密 / 机器码 / 有效期 |
| 后台刷新 | `refreshIfStaleAsync()` | 缓存超过 24h 时静默拉取一次，让在线吊销与有效期变更尽快生效 |
| 激活界面 | `ActivationActivity` | 展示并复制本机机器码、输入卡密、激活按钮、状态与提示文案；成功后进入主界面；未激活时也会走 `Updater` 后台静默更新，避免卡在旧版本无法拿到修复包；`AndroidManifest.xml` 中 `android:exported="false"` |

实现约束：清单与验签规则（自定义 base32 字母表、规范化串、Ed25519 公钥 / 签名）与卡密生成器逐字对齐，任一侧改动必须同步；App 运行时仍零第三方依赖，Ed25519 / SHA-512 / Base32 均为自带实现。
