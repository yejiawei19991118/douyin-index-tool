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
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
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

    private WebView webView;
    private String csv;
    private String keyword;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        csv = getIntent().getStringExtra(EXTRA_CSV);
        keyword = getIntent().getStringExtra(EXTRA_KEYWORD);
        if (csv == null) csv = "";
        if (keyword == null) keyword = "";

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
        if (csv == null || csv.isEmpty()) return;
        try {
            // JSONObject.quote 生成合法 JS 字符串字面量，CSV 里的引号/换行/反斜杠均被正确转义。
            String js = "window.loadFromCsv(" + JSONObject.quote(csv)
                    + "," + JSONObject.quote(keyword) + ");";
            webView.evaluateJavascript(js, null);
        } catch (Throwable t) {
            toast("数据注入失败：" + t.getMessage());
        }
    }

    // ===== 页面 -> 原生 的回传桥（页面里的 window.DyRankingBridge）=====
    private class DyRankingBridge {

        // 页面「导出结果」：WebView 内 <a download> 不会真正落盘，交由原生写入系统下载目录。
        // .xlsx 为二进制 ZIP，页面侧用 base64 传入，这里解码后写入；.csv/.xml 为文本，直接 UTF-8 编码。
        @JavascriptInterface
        public void exportCsv(String text, String name) {
            if (text == null) text = "";
            String fileName = (name == null || name.isEmpty()) ? "keyword-ranking.csv" : name;
            String lower = fileName.toLowerCase();
            boolean isXlsx = lower.endsWith(".xlsx");
            String mime = isXlsx
                    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    : (lower.endsWith(".xls") ? "application/vnd.ms-excel" : "text/csv");
            try {
                byte[] data = isXlsx
                        ? Base64.decode(text, Base64.DEFAULT)
                        : text.getBytes(StandardCharsets.UTF_8);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    Uri target = findDownloadsFile(fileName);
                    if (target == null) {
                        ContentValues values = new ContentValues();
                        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                        target = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                        if (target == null) throw new Exception("无法在下载目录创建文件");
                    }
                    try (OutputStream os = getContentResolver().openOutputStream(target, "wt")) {
                        if (os == null) throw new Exception("无法写入目标文件");
                        os.write(data);
                        os.flush();
                    } catch (Exception e) {
                        getContentResolver().delete(target, null, null);
                        throw e;
                    }
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    getContentResolver().update(target, done, null, null);
                    toast("已导出到系统下载目录：" + fileName);
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

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
