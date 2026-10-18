# 功能组件清单

抖音指数「人群分析」自动抓取工具 —— 各功能组件与其在代码中的位置。
运行时**零第三方依赖**（仅 Android 框架 API），构建期仅 AGP + Gradle wrapper。

---

## 一、应用外壳层 `app/src/main/java/com/lmt/dyindex/MainActivity.java`

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 配置常量 | `DEFAULT_KEYWORD`、`ANALYSIS_URL`、`targetUrl(kw)`、`DESKTOP_UA` | 默认关键词「穿搭」；按关键词动态拼址并做 URL 编码；桌面版 Chrome UA（人群分析为桌面端页面，需桌面 UA 才能拿到四个区块） |
| 布局骨架 | `onCreate` | 纵向三段：顶部输入栏 / WebView / 底部控制区 |
| 关键词输入组件 | `keywordInput`、`openBtn` | EditText（预填 + 圆角底）+「打开」按钮，支持软键盘回车触发 |
| 网页承载组件 | `webView` + `WebSettings` | JS / DOM 存储 / 数据库 / 宽视口 / 概览模式 / 桌面 UA / 混合内容兼容 |
| 登录态组件 | `CookieManager`、`onResume`、`onPause`、`onPageFinished` | 接受第三方 Cookie；在页面加载完成、回前台、切后台三处 `flush()` 落盘，实现免重复扫码 |
| 导航与进度 | `WebViewClient.onPageFinished`、`onProgressChanged`、`onConsoleMessage` | 页面完成即注入脚本；加载百分比可视化；页面 JS 报错转 logcat（tag `DyIndexJS`） |
| 状态栏组件 | `statusView`、`setStatus()` | 单行 + 省略号，汇报加载进度 / 空数据 / 抓取结果 |
| 操作按钮组 | `runBtn`、`copyBtn`、`exportBtn`、`debugBtn` | 重新抓取 / 复制 / 导出 CSV / 诊断，四个按钮等宽排布 |
| 注入与保活 | `injectExtractor()`、`pollReinject` | 注入 assets 脚本；每 2.5s 轮询补注入，应对 SPA 路由重置导致脚本丢失 |
| 数据导出 | `exportCsv()`、`writeToDownloads()`、`findDownloadsFile()` | MediaStore 写入系统「下载」目录，带 UTF-8 BOM；同名文件复用 Uri 覆盖写入，不产生重复文件 |
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

## 二、页面注入脚本层 `app/src/main/assets/extract.js`

| 组件 | 符号 / 位置 | 职责 |
| --- | --- | --- |
| 配置 | `TITLES`、`REGION_TABS` | 四个区块名；地域维度优先级 **城市 → 城市级别 → 省份** |
| 基础工具 | `sleep()`、`bridge()` | 延时；统一封装 `window.DyBridge` 回传 |
| 区块定位 | `findTitleMarks()`、`sectionFor()`、`getCharts()`、`findChartIn()` | TreeWalker 扫纯文本节点定位标题；按垂直 + 水平距离判定图表归属；收集图表容器与 tooltip 兄弟节点 |
| canvas 采集 | `parseTip()`、`scanCanvas()` | 解析 tooltip 的「占比 / TGI」；多行 y × x 步进派发合成 mousemove 逼出 tooltip |
| 地域采集 | `parseRegionTable()`、`clickTab()`、`extractRegion()` | 解析 DOM 表格；切换子维度页签；按维度优先级编排采集 |
| 性别采集 | `nearestCommon()`、`extractGender()` | 取「男性 / 女性」标签的最小公共祖先容器隔离解析；紧邻正则避免命中介绍文案 |
| 输出 | `keyword()`、`csvEscape()`、`buildCsv()` | 读取地址栏关键词；CSV 转义；按区块 + 维度组装 CSV |
| 流程编排 | `scrollThrough()`、`countRows()`、`extractAll()` | 整页滚动逼出懒加载图表；统计行数；按「年龄 → 兴趣 → 性别 → 地域」顺序采集（地域放最后，避免切页签重渲染影响其它图表） |
| 诊断快照 | `debug`（随结果回传） | 标题命中位置、图表归属、性别容器原文，供「诊断」按钮排查 |
| 触发组件 | `window.__dyRun()`、`watch()` | 手动触发；页面就绪后 1.5s 自动触发一次 |

---

## 三、构建与交付链

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| 模块构建脚本 | `app/build.gradle` | release 签名绑定、版本号、compileSdk 34 / minSdk 26 / targetSdk 34 |
| 工程构建脚本 | `build.gradle`、`settings.gradle` | AGP 8.13.0、镜像仓库、模块声明 |
| 密钥隔离 | `.gitignore` | 排除 `release.jks`、`keystore.properties`、`local.properties`、构建产物 |

### 版本发布流程

```
改代码 → gradlew assembleRelease → git commit → git tag vX.Y → gh release create vX.Y <apk>
```

- 版本交付**只走本仓库**，不再交付本机文件
- APK 以 GitHub Releases 资产分发，资产名统一 ASCII（中文名上传会被截断）
- `release.jks` 与 `keystore.properties` **绝不入库**：私钥一旦泄露，他人可伪造出被系统当作「正版升级」接受的 APK
