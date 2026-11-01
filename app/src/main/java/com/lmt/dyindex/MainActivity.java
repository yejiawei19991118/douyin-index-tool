package com.lmt.dyindex;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.TextUtils;
import android.util.Base64;
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
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
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
    // 关键词直达分析页并自动抓取；达人/视频/话题先到搜索页，手动进详情切分析页签后再抓取。
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
    private Button copyBtn;
    private Button rankingBtn;

    private String extractJs;
    private volatile String lastCsv;
    private volatile int lastRowCount;
    // 最近一次抓取的诊断快照（脚本实际看到的标题/图表/性别文本），出错时供排查。
    private volatile String lastDebug;
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
                            "return JSON.stringify({loading:l,hasContent:c,len:b.length});}" +
                            "catch(e){return JSON.stringify({err:String(e)});}})()",
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

        // 手动检查新版本（启动时也会静默查一次，这里用于「更新」入口常驻可点）。
        Button updateBtn = actionButton("更新", false, new View.OnClickListener() {
            @Override
            public void onClick(View v) { Updater.checkAndPrompt(MainActivity.this, true); }
        });
        LinearLayout.LayoutParams ulp = new LinearLayout.LayoutParams(dp(64), fieldH);
        ulp.leftMargin = dp(8);
        top.addView(updateBtn, ulp);

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
        statusView.setText("正在加载页面…");
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
        copyBtn = actionButton("复制", false, new View.OnClickListener() {
            @Override
            public void onClick(View v) { copyCsv(); }
        });
        Button exportBtn = actionButton("导出CSV", false, new View.OnClickListener() {
            @Override
            public void onClick(View v) { exportCsv(); }
        });
        // 综合排名：把本次抓取结果直接送入内置排名分析页（自动载入，无需手动导出/上传）。
        rankingBtn = actionButton("综合排名", false, new View.OnClickListener() {
            @Override
            public void onClick(View v) { openRanking(); }
        });
        // 诊断：把最近一次抓取脚本「实际看到的内容」复制到剪贴板，便于定位采集失败原因。
        Button debugBtn = actionButton("诊断", false, new View.OnClickListener() {
            @Override
            public void onClick(View v) { copyDebug(); }
        });

        // 五个按钮等宽排布，点击区域整齐且互不挤压。
        addWeighted(row, runBtn, 0);
        addWeighted(row, copyBtn, dp(8));
        addWeighted(row, exportBtn, dp(8));
        addWeighted(row, rankingBtn, dp(8));
        addWeighted(row, debugBtn, dp(8));
        setCopyEnabled(false);

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
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                ui.removeCallbacks(loadTimeoutRunnable);
                // 登录跳回后会写入新的登录 Cookie；立即 flush 落盘，避免本次进程被回收后登录态丢失。
                CookieManager.getInstance().flush();
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
        keywordCache = DEFAULT_KEYWORD;
        webView.loadUrl(AppUrls.targetUrl(DEFAULT_KEYWORD));

        // 页面为 SPA，路由切换不触发 onPageFinished；轮询兜底：脚本丢失则重新注入。
        ui.post(pollReinject);

        // 启动时静默检查一次新版本（有更新才弹窗，失败不打扰）。
        Updater.checkAndPrompt(this, false);
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
    // 关键词直达分析页（watcher 自动抓取）；达人/视频/话题到搜索页，状态栏引导手动步骤。
    private void openKeyword() {
        String kw = keywordInput.getText().toString().trim();
        if (kw.isEmpty()) {
            toast(mode == MODE_DAREN ? "请先输入抖音号" : "请先输入关键词");
            return;
        }
        keywordCache = kw;
        lastCsv = null;
        lastRowCount = 0;
        setCopyEnabled(false);
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
                hint = "正在加载「" + kw + "」的人群分析…";
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

    // 复制/排名按钮可用态：禁用时置灰，明确「还没有结果」。
    private void setCopyEnabled(boolean on) {
        if (copyBtn != null) {
            copyBtn.setEnabled(on);
            copyBtn.setAlpha(on ? 1f : 0.4f);
        }
        if (rankingBtn != null) {
            rankingBtn.setEnabled(on);
            rankingBtn.setAlpha(on ? 1f : 0.4f);
        }
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
                webView.evaluateJavascript("!!window.__dyInjected", value -> {
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

    private void copyCsv() {
        String csv = lastCsv;
        if (csv == null || csv.isEmpty()) { toast("还没有可复制的结果"); return; }
        ClipboardManager cb = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        cb.setPrimaryClip(ClipData.newPlainText("人群分析CSV", csv));
        toast("CSV 已复制到剪贴板");
    }

    private void copyDebug() {
        String d = lastDebug;
        if (d == null || d.isEmpty()) { toast("暂无诊断信息，请先抓取一次"); return; }
        ClipboardManager cb = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        cb.setPrimaryClip(ClipData.newPlainText("抓取诊断", d));
        toast("诊断信息已复制到剪贴板");
    }

    private void exportCsv() {
        String csv = lastCsv;
        if (csv == null || csv.isEmpty()) { toast("还没有可导出的结果"); return; }
        // 文件名按关键词固定、不带时间戳：同名覆盖，反复抓取（含每次启动的自动抓取）
        // 只会保留「每个关键词一份最新结果」，不会在下载目录里堆一串重复文件。
        String name = CsvUtils.fileNameFor(keywordCache);
        try {
            String desc = writeToDownloads(name, csv);
            toast("已导出到" + desc + "：" + name);
        } catch (Throwable t) {
            toast("导出失败：" + t.getMessage());
        }
    }

    private String keywordCache = "";

    // 打开综合排名分析页：把最近一次抓取的 CSV 直接传入，页面侧自动载入分析。
    private void openRanking() {
        String csv = lastCsv;
        if (csv == null || csv.isEmpty()) { toast("还没有可分析的结果"); return; }
        Intent intent = new Intent(this, RankingActivity.class);
        intent.putExtra(RankingActivity.EXTRA_CSV, csv);
        intent.putExtra(RankingActivity.EXTRA_KEYWORD, keywordCache);
        startActivity(intent);
    }

    // Android 10(Q) 起走 MediaStore（免运行时权限，落在系统「下载」目录）；
    // 更低版本退回应用专属目录（同样免权限）。
    private String writeToDownloads(String fileName, String content) throws IOException {
        byte[] data = content.getBytes(StandardCharsets.UTF_8);
        // 加 UTF-8 BOM，Excel 打开中文才不乱码。
        byte[] withBom = new byte[data.length + 3];
        withBom[0] = (byte) 0xEF; withBom[1] = (byte) 0xBB; withBom[2] = (byte) 0xBF;
        System.arraycopy(data, 0, withBom, 3, data.length);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 已存在同名文件就复用它的 Uri 覆盖写入，避免每次抓取新建一个副本。
            Uri target = findDownloadsFile(fileName);
            if (target == null) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, "text/csv");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                target = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (target == null) throw new IOException("无法在下载目录创建文件");
            }
            try {
                // "wt" 表示截断重写，保证同名文件里是最新一次的结果。
                OutputStream os = getContentResolver().openOutputStream(target, "wt");
                if (os == null) throw new IOException("无法写入目标文件");
                try { os.write(withBom); os.flush(); } finally { os.close(); }
            } catch (IOException e) {
                getContentResolver().delete(target, null, null);
                throw e;
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContentResolver().update(target, done, null, null);
            return "系统「下载」目录";
        }
        File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) throw new IOException("外部存储不可用");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建目录");
        File out = new File(dir, fileName);
        OutputStream os = new FileOutputStream(out);
        try { os.write(withBom); os.flush(); } finally { os.close(); }
        return "本应用专属目录（系统「下载」里看不到，路径 Android/data/"
                + getPackageName() + "/files/Download）";
    }

    // 在系统「下载」目录中查找同名文件；命中则返回其 Uri，用于覆盖写入。
    private Uri findDownloadsFile(String fileName) {
        String[] proj = { MediaStore.MediaColumns._ID };
        String sel = MediaStore.MediaColumns.DISPLAY_NAME + "=? AND "
                + MediaStore.MediaColumns.RELATIVE_PATH + "=?";
        String[] args = { fileName, Environment.DIRECTORY_DOWNLOADS + "/" };
        try (android.database.Cursor c = getContentResolver().query(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI, proj, sel, args, null)) {
            if (c != null && c.moveToFirst()) {
                return ContentUris.withAppendedId(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0));
            }
        } catch (Throwable ignore) {
            // 查询失败就当作不存在，走新建流程
        }
        return null;
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
                if (!kw.isEmpty()) keywordCache = kw;
                // 诊断快照先存下来：即使这次没采到数据，也能通过「诊断」按钮看到脚本实际所见。
                String dbg = o.optString("debug", "");
                if (!dbg.isEmpty()) lastDebug = dbg;
                if (csv.isEmpty() || rows == 0) {
                    setStatus("未采集到数据，请点「诊断」查看脚本实际所见");
                    toast("未采集到数据：请确认已登录处于人群分析页，并点「诊断」排查");
                    return;
                }
                lastCsv = csv;
                lastRowCount = rows;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        setCopyEnabled(true);
                        statusView.setText("抓取完成：共 " + rows + " 条，已自动导出");
                        exportCsv();
                        // 抓取成功后自动进入综合排名分析页（无需手动点按钮）。
                        openRanking();
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
    }

    @Override
    protected void onPause() {
        // 切后台前把内存中的登录 Cookie 落盘，进程被回收后仍能免登录。
        CookieManager.getInstance().flush();
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
        ui.removeCallbacks(pollReinject);
        ui.removeCallbacks(loadTimeoutRunnable);
        ui.removeCallbacks(stuckWatchdog);
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
