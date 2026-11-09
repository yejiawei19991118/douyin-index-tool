package com.lmt.dyindex;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * 抖音指数「人群分析」自动抓取工具。
 *
 * 形态：WebView 承载 creator.douyin.com 页面（登录沿用网页自身的扫码登录），
 * 页面就绪后自动注入 assets/extract.js，脚本自动悬停 canvas 图表把「占比 / TGI」采集出来，
 * 再经 JavascriptInterface 回传，由原生侧落盘为 CSV 到系统「下载」目录。
 *
 * 运行时零第三方依赖（org.json 由 Android 框架提供）。
 */
public class MainActivity extends Activity {

    // 默认关键词：预填到输入框，直接点「打开」即可抓取。
    private static final String DEFAULT_KEYWORD = "穿搭";

    // 抓取模式（输入框上方的 chips 单选）：决定「打开」跳转的页面与状态提示。
    // 四种模式统一为手动触发：全部由用户点「开始抓取」按钮执行提取。
    private static final int MODE_KEYWORD = 0;
    private static final int MODE_DAREN = 1;
    private static final int MODE_VIDEO = 2;
    private static final int MODE_TOPIC = 3;
    private static final String[] MODE_LABELS = {"关键词", "达人", "视频", "话题"};
    private static final String[] MODE_HINTS = {
            "输入关键词，如：穿搭",
            "输入抖音号，如：64672646637",
            "输入视频关键词，如：穿搭",
            "输入话题，如：穿搭"};

    // 桌面版 Chrome UA：各分析页都是桌面端页面，用桌面 UA 才能拿到与网页版一致的全部区块。
    private static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    private WebView webView;
    private EditText keywordInput;
    private TextView statusView;
    private Button runBtn;
    private Button rankingBtn;

    private String extractJs;
    private volatile String lastCsv;
    private volatile int lastRowCount;
    // 当前抓取模式（默认关键词）。
    private int mode = MODE_KEYWORD;
    private final Button[] modeChips = new Button[MODE_LABELS.length];
    // 页面加载超时（30s 仍未 onPageFinished 则提示，避免「一直加载中」无反馈）。
    private static final long LOAD_TIMEOUT_MS = 30000L;
    // 兼容补丁：抖音页面代码对 SVG 元素调用 e.className.includes()，但 SVGElement.className
    // 返回的是 SVGAnimatedString（无 .includes），在桌面 UA + 触屏 WebView 的组合下会触发，
    // 导致页面渲染管线抛错、卡在「加载中」。此 polyfill 让 className 返回字符串，需在页面 JS
    // 之前注入（onPageStarted 阶段）。
    private static final String SVG_CLASSNAME_POLYFILL =
            "(function(){try{var p=SVGElement.prototype;" +
            "Object.defineProperty(p,'className',{configurable:true," +
            "get:function(){return this.getAttribute('class')||'';}," +
            "set:function(v){this.setAttribute('class',v==null?'':String(v));}});" +
            "}catch(e){}})();";
    // 抖音创作者中心是 SPA，入口 chunk 加载失败（如 ChunkLoadError: Loading chunk xxxx failed）
    // 时，页面自身的错误边界会把路由跳走，导致一直停在「加载中」。实测这类失败是偶发的
    // （CDN 抖动），刷新一次通常就能恢复。此脚本在页面 JS 之前注入：
    //   1) 监听 error / unhandledrejection，命中 ChunkLoadError 立即 reload；
    //   2) 拦截 console.error：loadable-components 失败时会 console.error 输出
    //      "loadable-components: failed to asynchronously load component"，React 错误边界
    //      会吞掉异常导致 window.onerror 收不到，这里从 console 侧兜底捕获；
    //   3) 兜底看门狗：body 长时间只含「加载中」短文本时也 reload；
    //   4) 用 sessionStorage 记录上次 reload 时间戳，45s 内不重复 reload，避免死循环。
    private static final String STUCK_PAGE_RECOVERY =
            "(function(){if(window.__dyRec)return;window.__dyRec=true;" +
            "console.log('[DyRecovery] injected');" +
            "var K='__dy_last_reload';" +
            "function r(n){try{var t=Date.now(),l=parseInt(sessionStorage.getItem(K)||'0',10);" +
            "if(t-l<45000)return;sessionStorage.setItem(K,String(t));" +
            "console.log('[DyRecovery] '+n+', reloading');location.reload();}catch(e){}}" +
            "var _ce=console.error;console.error=function(){" +
            "try{var a=Array.prototype.slice.call(arguments)," +
            "m=a.map(function(x){return typeof x==='string'?x:(x&&(x.message||x.name))||String(x);}).join(' ');" +
            "if(/loadable-components|ChunkLoadError|Loading chunk/i.test(m))r('chunk-console');}" +
            "catch(e){}return _ce.apply(console,arguments);};" +
            "window.addEventListener('error',function(e){var m=(e&&e.message)||'';" +
            "if(/ChunkLoadError|Loading chunk|loadable/i.test(m))r('chunk-error');},true);" +
            "window.addEventListener('unhandledrejection',function(e){" +
            "var x=e&&e.reason,m=(x&&(x.message||String(x)))||'';" +
            "if(/ChunkLoadError|Loading chunk|loadable/i.test(m))r('chunk-rejection');},true);" +
            "var s=0;setInterval(function(){try{" +
            "var b=(document.body&&document.body.innerText)||'';" +
            "if(b.indexOf('加载中')>=0&&b.length<300){s+=2;if(s>=16)r('stuck-loading');}" +
            "else{s=0;}}catch(e){}},2000);" +
            "})();";
    // 修复「点开视频卡片后永久显示加载中...」。
    // 抖音创作者中心壳层（shell）加载用户信息时会用 post-robot 向 window.parent 发
    // 「getShareScene」请求。App 用 WebView 直接承载页面，页面本身就在顶层
    // （window.parent === window），没有父窗口应答；该版本 post-robot 的 RES_TIMEOUT 为 -1，
    // 且 send() 在目标窗口 readyPromise 未就绪时会先等它（只由收到 hello 才 resolve），
    // 于是该 Promise 永久 pending → loginType 永远不落地 → 顶层只渲染「加载中...」。
    // 早于页面 JS 把父窗口的 readyPromise 预热成 resolved，send 便会立即发出并走正常兜底，
    // 页面可正常渲染。仅顶层窗口需要，脚本幂等且轮询到 post-robot 出现为止。
    private static final String POSTROBOT_READY_SEED =
            "(function(){try{" +
            "if(window.__dyReadySeed)return;window.__dyReadySeed=1;" +
            "if(window.top!==window||window.parent!==window)return;" +
            "var done=false,n=0,iv=setInterval(function(){try{" +
            "if(done)return;" +
            "var pr=window.__postRobot__;" +
            "if(!pr||!pr.readyPromises){if(++n>200){clearInterval(iv);}return;}" +
            "done=true;clearInterval(iv);" +
            "pr.readyPromises.set(window.parent,Promise.resolve({origin:location.origin}));" +
            "console.log('[DyReady] seeded parent ready promise');" +
            "}catch(e){console.log('[DyReady] err '+(e&&e.message));}},25);" +
            "}catch(e){}})();";
    private final Runnable loadTimeoutRunnable = new Runnable() {
        @Override
        public void run() {
            setStatus("加载超时（30s 未完成）：可能需要登录或网络较慢，请检查页面显示");
        }
    };
    // 页面卡死看门狗：onPageFinished 后 20s 仍停在「加载中」且无分析内容，则自动 reload 一次。
    // 抖音 SPA 偶发 chunk 加载失败，页面自身卡在 loading 态且错误边界会吞掉异常，
    // 原生侧定时检查 DOM 是最可靠的兜底。单次导航只 reload 一次，避免死循环；
    // 用户手动点「打开」切换关键词时重置计数，允许下一次导航再触发。
    private static final long STUCK_DETECT_DELAY_MS = 20000L;
    private boolean stuckReloadDone = false;
    private final Runnable stuckWatchdog = new Runnable() {
        @Override
        public void run() {
            if (webView == null) return;
            webView.evaluateJavascript(
                    "(function(){try{var b=document.body?document.body.innerText:'';" +
                            "var l=b.indexOf('加载中')>=0;" +
                            "var c=b.indexOf('人群分析')>=0||b.indexOf('地域分布')>=0||" +
                            "b.indexOf('关键词指数')>=0||b.indexOf('关联分析')>=0||" +
                            "b.indexOf('视频搜索结果')>=0||b.indexOf('粉丝分析')>=0||" +
                            "b.indexOf('话题分析')>=0;" +
                            "return {loading:l,hasContent:c,len:b.length};}" +
                            "catch(e){return {err:String(e)};}})()",
                    value -> {
                        if (value == null) return;
                        try {
                            JSONObject o = new JSONObject(value);
                            boolean loading = o.optBoolean("loading", false);
                            boolean hasContent = o.optBoolean("hasContent", false);
                            int len = o.optInt("len", 0);
                            android.util.Log.w("DyRecovery",
                                    "stuck-check loading=" + loading + " hasContent=" + hasContent
                                            + " len=" + len);
                            if (loading && !hasContent && !stuckReloadDone) {
                                stuckReloadDone = true;
                                setStatus("检测到页面卡在加载中，自动重试…");
                                webView.reload();
                            }
                        } catch (Exception e) {
                            android.util.Log.w("DyRecovery", "stuck-check parse failed: " + e.getMessage());
                        }
                    });
        }
    };
    private final Handler ui = new Handler(Looper.getMainLooper());

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 卡密未激活 / 激活已失效：先进入登录激活页，验证通过后再回主界面。
        if (!LicenseManager.isActivated(this)) {
            startActivity(new Intent(this, ActivationActivity.class));
            finish();
            return;
        }
        // 清单缓存较久时后台静默刷新，让在线吊销与有效期变更尽快生效。
        LicenseManager.refreshIfStaleAsync(this);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFFFFFFFF);

        final int gutter = dp(14);   // 左右统一留白
        final int barPad = dp(10);
        final int fieldH = dp(46);   // 输入框与主按钮的统一高度，保证触控面积

        // ===== 模式切换 chips：关键词 / 达人 / 视频 / 话题（单选，默认关键词）=====
        LinearLayout modes = new LinearLayout(this);
        modes.setOrientation(LinearLayout.HORIZONTAL);
        modes.setBackgroundColor(0xFFFFFFFF);
        modes.setPadding(gutter, barPad, gutter, 0);
        for (int i = 0; i < MODE_LABELS.length; i++) {
            final int m = i;
            Button chip = actionButton(MODE_LABELS[i], i == mode, new View.OnClickListener() {
                @Override
                public void onClick(View v) { setMode(m); }
            });
            chip.setTextSize(13);
            modeChips[i] = chip;
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0, dp(34), 1f);
            if (i > 0) clp.leftMargin = dp(8);
            modes.addView(chip, clp);
        }
        root.addView(modes, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // ===== 顶部：关键词输入栏（白底 + 圆角输入框 + 主色「打开」按钮）=====
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setBackgroundColor(0xFFFFFFFF);
        top.setPadding(gutter, barPad, gutter, barPad);

        keywordInput = new EditText(this);
        keywordInput.setSingleLine(true);
        keywordInput.setHint("输入关键词，如：穿搭");
        keywordInput.setText(DEFAULT_KEYWORD);
        keywordInput.setTextSize(16);
        keywordInput.setTextColor(0xFF1A1A1A);
        keywordInput.setHintTextColor(0xFF9AA0A6);
        keywordInput.setImeOptions(EditorInfo.IME_ACTION_GO);
        keywordInput.setPadding(dp(14), 0, dp(14), 0);
        // 自绘圆角底：覆盖主题默认的下划线，避免旧版那条横贯全宽、还压到「打开」按钮的线条。
        keywordInput.setBackground(bg(0xFFF1F3F6, 0, 10));
        LinearLayout.LayoutParams klp = new LinearLayout.LayoutParams(0, fieldH, 1f);
        klp.rightMargin = dp(10);
        top.addView(keywordInput, klp);

        Button openBtn = actionButton("打开", true, new View.OnClickListener() {
            @Override
            public void onClick(View v) { openKeyword(); }
        });
        top.addView(openBtn, new LinearLayout.LayoutParams(dp(82), fieldH));

        keywordInput.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override
            public boolean onEditorAction(TextView v, int actionId, android.view.KeyEvent e) {
                if (actionId == EditorInfo.IME_ACTION_GO
                        || (e != null && e.getKeyCode() == android.view.KeyEvent.KEYCODE_ENTER)) {
                    openKeyword();
                    return true;
                }
                return false;
            }
        });

        root.addView(top, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(hDivider(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));

        webView = new WebView(this);
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // ===== 底部：状态独占一行 + 四个等宽操作按钮 =====
        // 旧版把状态文本和 4 个按钮挤在同一行，状态文本宽度被压成 0 → 文字逐字换行，
        // 把底栏撑到 684px 高、状态还完全看不见。改为纵向两行即可根治。
        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setBackgroundColor(0xFFFFFFFF);
        // 底部多留一点空间，避免按钮压在手势导航条上。
        bottom.setPadding(gutter, barPad, gutter, dp(18));

        statusView = new TextView(this);
        statusView.setText("请选择模式并输入内容后点「打开」");
        statusView.setTextSize(12);
        statusView.setTextColor(0xFF666666);
        statusView.setSingleLine(true);
        statusView.setEllipsize(TextUtils.TruncateAt.END);
        bottom.addView(statusView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rlp.topMargin = barPad;
        bottom.addView(row, rlp);

        runBtn = actionButton("开始抓取", true, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                setStatus("手动触发抓取…");
                webView.evaluateJavascript("window.__dyRun && window.__dyRun()", null);
            }
        });
        // 综合排名：把本次抓取结果直接送入内置排名分析页（自动载入，无需手动导出/上传）。
        rankingBtn = actionButton("综合排名", false, new View.OnClickListener() {
            @Override
            public void onClick(View v) { openRanking(); }
        });

        // 两个按钮等宽排布，点击区域整齐且互不挤压。
        addWeighted(row, runBtn, 0);
        addWeighted(row, rankingBtn, dp(8));
        rankingBtn.setEnabled(false);
        rankingBtn.setAlpha(0.4f);

        root.addView(hDivider(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));
        root.addView(bottom, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        setContentView(root);

        extractJs = readAsset("extract.js");

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setUserAgentString(DESKTOP_UA);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }

        // 登录态依赖第三方 Cookie（抖音登录后跳回创作者中心）。
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        // 远程页面 + 扫码登录：放行一切导航，不做顶层跳转拦截。
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (destroyed) return;
                // 每次开始加载（含登录重定向）都重置超时并显示当前主机，方便定位卡在哪个页面。
                ui.removeCallbacks(loadTimeoutRunnable);
                ui.removeCallbacks(stuckWatchdog);
                ui.postDelayed(loadTimeoutRunnable, LOAD_TIMEOUT_MS);
                String host = "";
                try { host = new java.net.URI(url).getHost(); } catch (Exception e) { /* 忽略 */ }
                setStatus("正在加载" + (host.isEmpty() ? "" : " " + host) + "…");
                // 在页面 JS 执行前注入兼容补丁，修复 SVGElement.className 导致的渲染卡死。
                view.evaluateJavascript(SVG_CLASSNAME_POLYFILL, null);
                // 注入「chunk 加载失败 / 卡死自动 reload」恢复脚本，同样需早于页面自身 JS。
                view.evaluateJavascript(STUCK_PAGE_RECOVERY, null);
                // 预热 post-robot 的父窗口 readyPromise，修复点开视频卡片后卡在「加载中」。
                view.evaluateJavascript(POSTROBOT_READY_SEED, null);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (destroyed) return;
                ui.removeCallbacks(loadTimeoutRunnable);
                // 登录跳回后会写入新的登录 Cookie；立即 flush 落盘，避免本次进程被回收后登录态丢失。
                CookieManager.getInstance().flush();
                // 兜底再注入一次：SPA 路由切换不触发 onPageStarted，页面内导航下也需预热。
                view.evaluateJavascript(POSTROBOT_READY_SEED, null);
                injectExtractor();
                // 登录页无需卡死检测（等用户扫码即可），其它页面启动 20s 看门狗。
                final boolean isLogin = url != null
                        && (url.contains("passport") || url.contains("login") || url.contains("sso"));
                if (!isLogin) {
                    ui.postDelayed(stuckWatchdog, STUCK_DETECT_DELAY_MS);
                }
                ui.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        setStatus(isLogin ? "请扫码登录抖音后继续（登录完成会自动跳回）"
                                : "页面已就绪，等待人群分析区块…");
                    }
                }, 400);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // 主框架加载失败才提示，子资源（埋点/广告）失败不打扰用户。
                if (request == null || !request.isForMainFrame()) return;
                ui.removeCallbacks(loadTimeoutRunnable);
                String desc = "";
                int code = -1;
                try { desc = String.valueOf(error.getDescription()); } catch (Exception e) { /* 忽略 */ }
                try { code = error.getErrorCode(); } catch (Exception e) { /* 忽略 */ }
                setStatus("页面加载失败（" + code + "）：" + desc + "，请检查网络或稍后重试");
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            android.webkit.WebResourceResponse errorResponse) {
                if (request == null || !request.isForMainFrame() || errorResponse == null) return;
                int status = errorResponse.getStatusCode();
                if (status >= 400) {
                    ui.removeCallbacks(loadTimeoutRunnable);
                    setStatus("HTTP 错误 " + status + "：页面无法访问，请检查网络或登录状态");
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            // 加载进度可见化：未完成时给出百分比，完成后交给「页面已就绪/抓取完成」状态。
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress < 100) setStatus("加载中 " + newProgress + "%…");
            }

            // 页面里的 JS 报错转进 logcat：adb logcat -s DyIndexJS 可直接看到注入脚本的真实错误。
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage cm) {
                android.util.Log.w("DyIndexJS", cm.message()
                        + " @" + cm.sourceId() + ":" + cm.lineNumber());
                return true;
            }
        });

        webView.addJavascriptInterface(new DyBridge(), "DyBridge");
        // 打开 APK 后不自动跳转、不自动抓取，全部由用户手动发起。
        keywordCache = DEFAULT_KEYWORD;
    }

    // 切换抓取模式：更新 chips 选中态与输入框提示；不自动跳转，仍由「打开」触发。
    private void setMode(int m) {
        mode = m;
        for (int i = 0; i < modeChips.length; i++) {
            Button chip = modeChips[i];
            if (chip == null) continue;
            boolean on = (i == m);
            chip.setBackground(bg(on ? 0xFF2F6DF6 : 0xFFFFFFFF, on ? 0 : 0xFFD6DBE1, 10));
            chip.setTextColor(on ? 0xFFFFFFFF : 0xFF2F6DF6);
        }
        keywordInput.setHint(MODE_HINTS[m]);
    }

    // 按当前模式与输入内容加载页面；清空上一轮结果，避免误导出旧数据。
    // 四种模式全部统一为手动：关键词直达分析页，达人/视频/话题到搜索页，
    // 页面就绪后均由用户点底部「开始抓取」按钮触发提取。
    private void openKeyword() {
        String kw = keywordInput.getText().toString().trim();
        if (kw.isEmpty()) {
            toast(mode == MODE_DAREN ? "请先输入抖音号" : "请先输入关键词");
            return;
        }
        keywordCache = kw;
        pageNameCache = "";
        pageTypeCache = "";
        lastCsv = null;
        lastRowCount = 0;
        if (rankingBtn != null) {
            rankingBtn.setEnabled(false);
            rankingBtn.setAlpha(0.4f);
        }
        // 用户手动发起新导航：允许卡死看门狗再次触发自动 reload。
        stuckReloadDone = false;
        String url;
        String hint;
        switch (mode) {
            case MODE_DAREN:
                url = AppUrls.darenSearchUrl(kw);
                hint = "已打开达人搜索：请进入「达人详情」并切到粉丝分析，再点「开始抓取」";
                break;
            case MODE_VIDEO:
                url = AppUrls.videoSearchUrl(kw);
                hint = "已打开视频搜索：请进入一个视频并切到观众分析，再点「开始抓取」";
                break;
            case MODE_TOPIC:
                url = AppUrls.topicSearchUrl(kw);
                hint = "已打开话题搜索：请进入「话题分析」并切到人群分析，再点「开始抓取」";
                break;
            default:
                url = AppUrls.targetUrl(kw);
                hint = "正在加载「" + kw + "」的人群分析页，请在页面就绪后点「开始抓取」";
                break;
        }
        setStatus(hint);
        webView.loadUrl(url);
    }

    // 圆角纯色背景（stroke 为 0 表示不描边）；用于替换主题默认的方框/下划线外观。
    private GradientDrawable bg(int fill, int stroke, int radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(dp(radiusDp));
        if (stroke != 0) d.setStroke(dp(1), stroke);
        return d;
    }

    // 操作按钮：primary = 主色实心白字；否则描边次级样式。
    private Button actionButton(String text, boolean primary, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(14);
        // 清掉 Material 默认的 minWidth/minHeight 与阴影，让自定义圆角背景不被撑变形。
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setPadding(dp(8), 0, dp(8), 0);
        b.setElevation(0);
        b.setStateListAnimator(null);
        if (primary) {
            b.setBackground(bg(0xFF2F6DF6, 0, 10));
            b.setTextColor(0xFFFFFFFF);
        } else {
            b.setBackground(bg(0xFFFFFFFF, 0xFFD6DBE1, 10));
            b.setTextColor(0xFF2F6DF6);
        }
        b.setOnClickListener(l);
        return b;
    }

    // 细分割线：把顶栏 / 网页 / 底栏在视觉上分开。
    private View hDivider() {
        View v = new View(this);
        v.setBackgroundColor(0xFFEDEFF2);
        return v;
    }

    // 底栏内等宽排布按钮，startMarginPx 为与左侧相邻元素的间距。
    private void addWeighted(LinearLayout row, View child, int startMarginPx) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(44), 1f);
        lp.leftMargin = startMarginPx;
        row.addView(child, lp);
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    private void setStatus(final String text) {
        ui.post(new Runnable() {
            @Override
            public void run() { statusView.setText(text); }
        });
    }

    // 每 2.5s 检查注入标记；页面整页刷新或 SPA 重置后自动补注入。
    private final Runnable pollReinject = new Runnable() {
        @Override
        public void run() {
            if (webView != null) {
                // SPA 路由切换不会触发 onPageStarted/onPageFinished，轮询兜底预热 readyPromise；
                // 预热脚本自带幂等守卫，把它和注入检查合并成一次跨进程调用，省掉一半 IPC。
                webView.evaluateJavascript(POSTROBOT_READY_SEED + "\n;!!window.__dyInjected", value -> {
                    if (value == null || value.contains("false")) injectExtractor();
                });
            }
            ui.postDelayed(this, 2500);
        }
    };

    private void injectExtractor() {
        if (webView == null || extractJs == null || extractJs.isEmpty()) return;
        webView.evaluateJavascript(extractJs, null);
    }

    private volatile String keywordCache = "";
    // 页面抓到的名称，按页型各自取标识：达人页=昵称，话题页=话题名，视频页=视频标题，关键词页=关键词名。
    // 状态栏展示与综合排名页导出都用它；抓取脚本猜不到名称时回退用户输入。
    private volatile String pageNameCache = "";
    // 页型（keyword/topic/daren/video）：排名页据此把「当前关键词」显示成当前话题/达人/视频。
    private volatile String pageTypeCache = "";
    // onDestroy 之后 WebView 仍可能回调 onPageStarted/onPageFinished；
    // 置位后这些回调直接返回，避免销毁流程里再 postDelayed 出新的定时任务。
    private boolean destroyed = false;

    // 打开综合排名分析页：把最近一次抓取的 CSV 直接传入，页面侧自动载入分析。
    private void openRanking() {
        String csv = lastCsv;
        if (csv == null || csv.isEmpty()) { toast("还没有可分析的结果"); return; }
        // 排名页的标题 / 导出文件名 / CSV 首列按页面类型取各自标识（pageNameCache），
        // 抓取侧没识别出名称时用用户输入兜底。
        String rankName = pageNameCache.isEmpty() ? keywordCache : pageNameCache;
        // CSV 可能上千行（数百 KB），走 Intent extra 会撞 Binder 事务上限（约 1MB）；
        // 同进程内改用静态暂存交接，Intent 只传轻量参数。
        RankingActivity.stageCsv(csv);
        Intent intent = new Intent(this, RankingActivity.class);
        intent.putExtra(RankingActivity.EXTRA_KEYWORD, rankName);
        intent.putExtra(RankingActivity.EXTRA_PAGE_TYPE, pageTypeCache);
        startActivity(intent);
    }

    private void toast(final String msg) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
            }
        });
    }

    private String readAsset(String path) {
        try (InputStream is = getAssets().open(path);
             ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return "";
        }
    }

    // ===== 注入脚本 -> 原生 的回传桥（页面里的 window.DyBridge）=====
    private class DyBridge {
        @JavascriptInterface
        public void onLog(String msg) {
            setStatus(msg);
        }

        @JavascriptInterface
        public void onResult(String json) {
            try {
                JSONObject o = new JSONObject(json);
                final String csv = o.optString("csv", "");
                final int rows = o.optInt("rowCount", 0);
                String kw = o.optString("keyword", "");
                // 页面识别到的名称按页型各自取标识：达人=昵称、话题=话题名、视频=视频标题、
                // 关键词=关键词名；状态展示与综合排名页导出都以它为准，识别不到时回退用户输入。
                // 只有本次确实抓到数据才覆盖缓存：失败时保留上一份成功结果，避免旧 CSV 配新页名。
                if (csv.isEmpty() || rows == 0) {
                    // 失败时才输出完整快照（含 DOM dump / canvas probe），正常结果不再刷大段日志。
                    android.util.Log.i("DyIndexJS", "RESULT_SNAPSHOT: " + json);
                    setStatus("未采集到数据，请确认已登录且处于人群分析页");
                    toast("未采集到数据：请确认已登录处于人群分析页");
                    return;
                }
                pageNameCache = kw;
                pageTypeCache = o.optString("pageType", "");
                lastCsv = csv;
                lastRowCount = rows;
                final String displayName = pageNameCache.isEmpty() ? keywordCache : pageNameCache;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        if (rankingBtn != null) {
                            rankingBtn.setEnabled(true);
                            rankingBtn.setAlpha(1f);
                        }
                        // 内置提示词：总览 + 下一步指引；具体导出在「综合排名」页内完成。
                        statusView.setText("抓取完成：" + displayName + " 共 " + rows + " 条，点「综合排名」分析/导出");
                    }
                });
            } catch (Throwable t) {
                toast("结果解析失败：" + t.getMessage());
            }
        }

        @JavascriptInterface
        public void onError(String msg) {
            setStatus("抓取出错：" + msg);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 回到前台时刷新 Cookie 库，保证启动/恢复时读到的登录态是最新的。
        CookieManager.getInstance().flush();
        // 上一次更新下载若已结束（进程曾被杀导致完成广播丢失），这里补上安装。
        Updater.resumePendingInstall(this);
        // 刚升级完首次打开时展示本次更新内容（文案取自发布时的提交信息），同一版本只弹一次。
        Updater.maybeShowChangelog(this);
        // 每次重新打开/回到前台都静默检查更新：有新版即后台下载并调起安装器。
        Updater.checkAndPrompt(this, false);
        // 仅在前台轮询注入脚本与预热 seed，切后台（如打开排名页）时停止以省电省 CPU。
        ui.removeCallbacks(pollReinject);
        ui.post(pollReinject);
    }

    @Override
    protected void onPause() {
        // 切后台前把内存中的登录 Cookie 落盘，进程被回收后仍能免登录。
        CookieManager.getInstance().flush();
        ui.removeCallbacks(pollReinject);
        // 超时提示与卡死看门狗只在页面可见时才有意义：否则切到后台/排名页 20s 后
        // 仍会 evaluateJavascript 甚至 reload，白白耗电并打断用户。
        ui.removeCallbacks(loadTimeoutRunnable);
        ui.removeCallbacks(stuckWatchdog);
        super.onPause();
    }

    @Override
    public boolean onKeyDown(int keyCode, android.view.KeyEvent event) {
        if (keyCode == android.view.KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        // 先置位再 loadUrl("about:blank")：否则 onPageStarted/onPageFinished 会在销毁过程中
        // 重新 postDelayed 超时与看门狗任务，持有已销毁的 Activity。
        destroyed = true;
        ui.removeCallbacks(pollReinject);
        ui.removeCallbacks(loadTimeoutRunnable);
        ui.removeCallbacks(stuckWatchdog);
        Updater.stopWatch(this);
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.removeJavascriptInterface("DyBridge");
            webView.removeAllViews();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
