package com.lmt.dyindex;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentUris;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 综合排名分析页：把抓取到的人群分析 CSV 直接灌入内置的排名工具页面。
 *
 * 数据来源：MainActivity 抓取完成后把 CSV（区块,分类,占比,TGI）通过 Intent 传入，
 * 页面加载完成后由 evaluateJavascript 调用 window.loadFromCsv(csv, keyword) 自动分析。
 * 页面侧不依赖任何 CDN（PapaParse/SheetJS 已移除），CSV 由 ranking.html 内置解析器处理。
 */
public class RankingActivity extends Activity {

    public static final String EXTRA_CSV = "csv";
    public static final String EXTRA_KEYWORD = "keyword";
    public static final String EXTRA_PAGE_TYPE = "pageType";

    // 同进程一次性交接：CSV 动辄数百 KB，走 Intent extra 会撞 Binder 事务上限（约 1MB）
    // 并抛 TransactionTooLargeException；静态字段只在本进程内有效，进程被杀时 Activity 也一并消失。
    private static volatile String sStagedCsv;

    static void stageCsv(String value) {
        sStagedCsv = value;
    }

    private static String takeStagedCsv() {
        String v = sStagedCsv;
        sStagedCsv = null;
        return v;
    }

    private WebView webView;
    private String csv;
    private String keyword;
    private String pageType;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        csv = takeStagedCsv();
        // 兼容旧入口（或将来从外部带 extra 启动）：暂存为空时才读 Intent。
        if (csv == null) csv = getIntent().getStringExtra(EXTRA_CSV);
        keyword = getIntent().getStringExtra(EXTRA_KEYWORD);
        pageType = getIntent().getStringExtra(EXTRA_PAGE_TYPE);
        if (csv == null) csv = "";
        if (keyword == null) keyword = "";
        if (pageType == null) pageType = "";

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);

        webView.addJavascriptInterface(new DyRankingBridge(), "DyRankingBridge");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                // 页面就绪后注入抓取结果，自动开始分析（无需用户手动上传文件）。
                injectCsv();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                // 把页面 console 输出转进 logcat，方便排查分析/导出问题
                Log.i("DyRankJS", cm.message());
                return true;
            }
        });
        webView.loadUrl("file:///android_asset/ranking.html");
    }

    private void injectCsv() {
        // onDestroy 之后仍可能收到 onPageFinished 回调，webView 已置空，不能再调用。
        if (csv == null || csv.isEmpty() || webView == null) return;
        try {
            // JSONObject.quote 生成合法 JS 字符串字面量，CSV 里的引号/换行/反斜杠均被正确转义。
            String js = "window.loadFromCsv(" + JSONObject.quote(csv)
                    + "," + JSONObject.quote(keyword)
                    + "," + JSONObject.quote(pageType) + ");";
            webView.evaluateJavascript(js, null);
        } catch (Throwable t) {
            toast("数据注入失败：" + t.getMessage());
        }
    }

    @Override
    protected void onPause() {
        // 排名页里没有需要持续运行的动画，切后台时暂停 WebView 的 JS 计时器与渲染。
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        // WebView 必须先从视图树摘除再 destroy，否则会泄漏 Activity 与渲染进程资源。
        if (webView != null) {
            webView.stopLoading();
            webView.removeJavascriptInterface("DyRankingBridge");
            ViewParent parent = webView.getParent();
            if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // ===== 页面 -> 原生 的回传桥（页面里的 window.DyRankingBridge）=====
    private class DyRankingBridge {

        // 页面「导出结果」：WebView 内 <a download> 不会真正落盘，交由原生写入系统下载目录。
        // .xlsx 为二进制 ZIP，页面侧用 base64 传入，这里解码后写入；.csv/.xml 为文本，直接 UTF-8 编码。
        @JavascriptInterface
        public void exportCsv(String text, String name) {
            if (text == null) text = "";
            String fileName = (name == null || name.isEmpty()) ? "keyword-ranking.csv" : CsvUtils.sanitizeFileName(name);
            String lower = fileName.toLowerCase(java.util.Locale.ROOT);
            boolean isXlsx = lower.endsWith(".xlsx");
            String mime = isXlsx
                    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    : (lower.endsWith(".xls") ? "application/vnd.ms-excel" : "text/csv");
            try {
                byte[] data = isXlsx
                        ? Base64.decode(text, Base64.DEFAULT)
                        : text.getBytes(StandardCharsets.UTF_8);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    // 先落临时文件：只有数据完整写成功后才去动下载目录里的同名文件，
                    // 避免写到一半（空间不足等）把上一份完整结果截断成半截文件。
                    File tmp = File.createTempFile("export", ".part", getCacheDir());
                    try {
                        try (FileOutputStream fos = new FileOutputStream(tmp)) {
                            fos.write(data);
                            fos.flush();
                        }
                        Uri target = findDownloadsFile(fileName);
                        boolean reused = target != null;
                        ContentValues pending = new ContentValues();
                        pending.put(MediaStore.MediaColumns.IS_PENDING, 1);
                        if (!reused) {
                            ContentValues values = new ContentValues();
                            values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                            values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                            target = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                            if (target == null) throw new Exception("无法在下载目录创建文件");
                        } else {
                            // 覆盖已有文件时先标回 pending，避免用户看到写了一半的文件。
                            getContentResolver().update(target, pending, null, null);
                        }
                        try (InputStream in = new FileInputStream(tmp);
                             OutputStream os = getContentResolver().openOutputStream(target, "wt")) {
                            if (os == null) throw new Exception("无法写入目标文件");
                            byte[] buf = new byte[8192];
                            int n;
                            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                            os.flush();
                        } catch (Exception e) {
                            // 已经写坏的半截文件直接删掉，而不是留一个「看起来完整」的坏文件。
                            getContentResolver().delete(target, null, null);
                            throw e;
                        }
                        getContentResolver().update(target, doneValues(), null, null);
                        toast("已导出到系统下载目录：" + fileName);
                    } finally {
                        //noinspection ResultOfMethodCallIgnored
                        tmp.delete();
                    }
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) throw new Exception("外部存储不可用");
                    if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建目录");
                    try (OutputStream os = new FileOutputStream(new File(dir, fileName))) {
                        os.write(data);
                        os.flush();
                    }
                    toast("已导出到应用下载目录：" + fileName);
                }
            } catch (Throwable t) {
                Log.e("DyRank", "导出失败：" + t.getMessage(), t);
                toast("导出失败：" + t.getMessage());
            }
        }

        // 页面「返回抓取」按钮：关闭本 Activity，回到抓取页。
        @JavascriptInterface
        public void close() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() { finish(); }
            });
        }
    }

    private static ContentValues doneValues() {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        return v;
    }

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
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(RankingActivity.this, msg, Toast.LENGTH_LONG).show();
            }
        });
    }

}
