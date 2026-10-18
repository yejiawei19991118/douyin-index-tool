package com.lmt.dyindex;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 内置版本更新：打开应用时静默查一次 GitHub Release → 有新版则弹窗 → 一键下载并调起系统安装器。
 *
 * 免登录读取公开仓库的 Releases API（私有仓库会返回 404，此时给出可读提示而非崩溃）。
 * 仅使用 Android 框架（含框架自带的 org.json），无任何第三方依赖。
 */
public final class Updater {

    // ===== 可配置常量 =====

    /** 发布仓库（owner/repo）。 */
    private static final String REPO = "yejiawei19991118/douyin-index-tool";

    /** 最新 Release 的 API（免登录；私有仓库会 404）。 */
    private static final String LATEST_API =
            "https://api.github.com/repos/" + REPO + "/releases/latest";

    /** 手动更新失败时的兜底入口（浏览器打开 Releases 页）。 */
    private static final String RELEASES_PAGE =
            "https://github.com/" + REPO + "/releases/latest";

    /** 单次网络请求超时。 */
    private static final int TIMEOUT_MS = 8000;

    /** 自动检查的最小间隔（冷启动频繁时不必反复请求）。 */
    private static final long AUTO_INTERVAL_MS = 6L * 60 * 60 * 1000;

    private static final String PREFS = "dyindex_update";
    private static final String KEY_LAST_CHECK = "last_check";
    /** 用户选择「稍后」的 tag，同一版本不再重复打扰。 */
    private static final String KEY_SKIPPED = "skipped_tag";
    /** 进行中的下载：进程若在下载期间被回收，onResume 靠这几个字段接续安装。 */
    private static final String KEY_PENDING_ID = "pending_download_id";
    private static final String KEY_PENDING_NAME = "pending_file_name";
    private static final String KEY_PENDING_SHA_URL = "pending_sha_url";

    /** 下载记录已不存在（被系统清理）时的状态值。 */
    private static final int STATUS_UNKNOWN = -1;

    /** 读签名的标志：API 28+ 用签名证书标志，更早版本读已废弃的 signatures 字段。 */
    private static final int SIGNATURE_FLAG = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;

    /** 是否已有一次检查在跑：避免自动检查与手动检查并发重复请求。 */
    private static final AtomicBoolean sChecking = new AtomicBoolean(false);

    /** 更新弹窗是否正在显示：避免重复叠加。 */
    private static boolean sDialogShowing;

    /** 下载完成广播接收器（仅在下载期间注册）。 */
    private static BroadcastReceiver sReceiver;

    private Updater() {
    }

    /** 一次 Release 里我们关心的信息。 */
    static final class Release {
        /** 原始 tag，如 v1.2。 */
        String tag = "";
        /** 规整后的版本号，如 1.2。 */
        String version = "";
        /** Release 说明。 */
        String notes = "";
        /** 安装包资产名。 */
        String apkName = "";
        /** 安装包直链。 */
        String apkUrl = "";
        /** 校验文件（<apk>.sha256）直链；无则留空，跳过校验。 */
        String shaUrl = "";

        /** 是否解析出了可下载的安装包。 */
        boolean downloadable() {
            return apkUrl.startsWith("https://") && !apkName.isEmpty();
        }
    }

    // ===== 对外入口 =====

    /**
     * 检查是否有新版本。
     *
     * @param manual true=用户点「更新」触发（无视节流，且无论结果都给出提示）；
     *               false=启动时自动触发（6 小时内只查一次，失败静默）
     */
    public static void checkAndPrompt(final Activity activity, final boolean manual) {
        if (activity == null) return;
        final Context app = activity.getApplicationContext();
        final SharedPreferences sp = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        final long now = System.currentTimeMillis();

        if (!manual && now - sp.getLong(KEY_LAST_CHECK, 0L) < AUTO_INTERVAL_MS) return;

        if (!sChecking.compareAndSet(false, true)) {
            if (manual) toast(app, "正在检查更新，请稍候…");
            return;
        }
        if (manual) toast(app, "正在检查更新…");

        final String currentName = currentVersionName(app);
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    // 无论成功与否都记录时间：否则离线时每次冷启动都会重发请求。
                    sp.edit().putLong(KEY_LAST_CHECK, now).apply();
                    final Release r = fetchLatest();
                    if (r == null) {
                        if (manual) {
                            toast(app, "检查更新失败：拿不到发布信息。若仓库仍为私有，请先设为公开后再试");
                        }
                        return;
                    }
                    if (!VersionUtils.isNewer(r.version, currentName)) {
                        if (manual) toast(app, "已是最新版本 " + currentName);
                        return;
                    }
                    if (r.tag.equals(sp.getString(KEY_SKIPPED, ""))) return;
                    if (!r.downloadable()) {
                        if (manual) toast(app, "发现新版本 " + r.version + "，但未找到可下载的安装包");
                        return;
                    }
                    activity.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (activity.isFinishing() || sDialogShowing) return;
                            showUpdateDialog(activity, r, currentName);
                        }
                    });
                } finally {
                    sChecking.set(false);
                }
            }
        }, "dyindex-update-check").start();
    }

    /**
     * onResume 时调用：上一次下载若已终结则直接校验并调起安装，仍在进行则重新挂上广播。
     * 动态注册的完成广播只在进程存活期间收得到，进程被系统回收后就断了，这里做补装兜底。
     */
    public static void resumePendingInstall(final Activity activity) {
        if (activity == null) return;
        final Context app = activity.getApplicationContext();
        final SharedPreferences sp = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        final long id = sp.getLong(KEY_PENDING_ID, -1L);
        final String fileName = sp.getString(KEY_PENDING_NAME, "");
        if (id < 0 || fileName == null || fileName.isEmpty()) return;
        final String shaUrl = sp.getString(KEY_PENDING_SHA_URL, "");
        if (handleIfFinished(activity, id, fileName, shaUrl)) return;
        watchDownload(activity, id, fileName, shaUrl);
    }

    // ===== 检查 =====

    /** 拉取最新 Release；网络异常 / 非 200（含私有仓库 404） / 解析失败一律返回 null。 */
    private static Release fetchLatest() {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(LATEST_API).openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            // GitHub API 强制要求 User-Agent，缺失会直接 403。
            conn.setRequestProperty("User-Agent", "dyindex-android");
            conn.setRequestProperty("Accept", "application/vnd.github+json");
            if (conn.getResponseCode() != 200) return null;
            InputStream in = conn.getInputStream();
            try {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                return parseRelease(bos.toString("UTF-8"));
            } finally {
                in.close();
            }
        } catch (Throwable t) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 解析 Releases API 的 JSON；缺 tag 或缺 .apk 资产时返回 null。 */
    static Release parseRelease(String text) {
        if (text == null) return null;
        try {
            JSONObject o = new JSONObject(text);
            String tag = o.optString("tag_name", "");
            if (tag.isEmpty()) return null;
            Release r = new Release();
            r.tag = tag;
            r.version = VersionUtils.normalize(tag);
            r.notes = o.optString("body", "");
            JSONArray assets = o.optJSONArray("assets");
            if (assets != null) {
                for (int i = 0; i < assets.length(); i++) {
                    JSONObject a = assets.optJSONObject(i);
                    if (a == null) continue;
                    String name = a.optString("name", "");
                    String url = a.optString("browser_download_url", "");
                    if (!url.startsWith("https://")) continue;
                    if (name.toLowerCase().endsWith(".apk")) {
                        // 多个 apk 时优先带 release 字样的那个（CI 产物名如此）。
                        if (r.apkUrl.isEmpty() || name.contains("release")) {
                            r.apkName = name;
                            r.apkUrl = url;
                        }
                    } else if (name.toLowerCase().endsWith(".apk.sha256")) {
                        r.shaUrl = url;
                    }
                }
            }
            return r;
        } catch (Throwable t) {
            return null;
        }
    }

    private static String currentVersionName(Context ctx) {
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return pi.versionName == null ? "" : pi.versionName;
        } catch (Throwable t) {
            return "";
        }
    }

    // ===== 提示 =====

    private static void showUpdateDialog(final Activity activity, final Release r, String currentName) {
        StringBuilder msg = new StringBuilder();
        msg.append("当前版本 ").append(currentName)
                .append("　→　最新版本 ").append(r.version);
        String notes = cleanNotes(r.notes);
        if (!notes.isEmpty()) msg.append("\n\n").append(notes);

        sDialogShowing = true;
        new AlertDialog.Builder(activity)
                .setTitle("发现新版本 " + r.tag)
                .setMessage(msg.toString())
                .setPositiveButton("立即更新", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        startDownload(activity, r);
                    }
                })
                .setNegativeButton("稍后", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                                .edit().putString(KEY_SKIPPED, r.tag).apply();
                    }
                })
                .setOnDismissListener(new DialogInterface.OnDismissListener() {
                    @Override
                    public void onDismiss(DialogInterface dialog) {
                        sDialogShowing = false;
                    }
                })
                .show();
    }

    /** 说明文案过长时截断，避免弹窗被撑满屏。 */
    private static String cleanNotes(String notes) {
        if (notes == null) return "";
        String s = notes.trim();
        if (s.length() > 500) s = s.substring(0, 500) + "…";
        return s;
    }

    // ===== 下载与安装 =====

    private static void startDownload(final Activity activity, final Release r) {
        // Android 8+ 从应用内安装必须获得「安装未知应用」授权
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(activity, "请先允许本应用「安装未知应用」，返回后再点一次「立即更新」",
                    Toast.LENGTH_LONG).show();
            openInstallPermissionSettings(activity);
            return;
        }
        Context app = activity.getApplicationContext();
        // 应用私有外部目录：全 API 无需存储权限，且与 ApkFileProvider 的共享目录一致
        String fileName = "dyindex-update-" + r.version + ".apk";
        try {
            DownloadManager dm = (DownloadManager) app.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                Toast.makeText(activity, "无法启动下载", Toast.LENGTH_LONG).show();
                return;
            }
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(r.apkUrl));
            req.setTitle("正在下载新版本 " + r.tag);
            req.setDescription("下载完成后将自动进入安装");
            req.setMimeType(ApkFileProvider.APK_MIME);
            req.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalFilesDir(app, null, ApkFileProvider.PATH + "/" + fileName);
            // 安装器读完文件前不能删，所以统一在下一次下载前清理遗留安装包，避免长期堆积
            cleanUpdatesDir(app);
            long id = dm.enqueue(req);
            // 记住本次下载：进程若在下载期间被回收，onResume 可据此接续安装
            app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putLong(KEY_PENDING_ID, id)
                    .putString(KEY_PENDING_NAME, fileName)
                    .putString(KEY_PENDING_SHA_URL, r.shaUrl)
                    .apply();
            watchDownload(activity, id, fileName, r.shaUrl);
            Toast.makeText(activity, "已开始后台下载，完成后会自动进入安装", Toast.LENGTH_LONG).show();
        } catch (Throwable t) {
            Toast.makeText(activity, "下载启动失败：" + t.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /** 下载完成由系统广播通知；这里只处理本次下载对应的那条。 */
    // 下方已按 SDK_INT 分支：API 33+ 用三参重载显式声明 RECEIVER_EXPORTED，低版本才走两参重载，
    // lint 无法跨分支判断，故在此抑制该检查。
    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    private static void watchDownload(final Activity activity, final long id,
                                      final String fileName, final String shaUrl) {
        if (activity == null) return;
        final Context app = activity.getApplicationContext();
        if (sReceiver != null) {
            try {
                app.unregisterReceiver(sReceiver);
            } catch (Throwable ignored) {
            }
            sReceiver = null;
        }
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L) != id) return;
                try {
                    app.unregisterReceiver(this);
                } catch (Throwable ignored) {
                }
                sReceiver = null;
                handleIfFinished(activity, id, fileName, shaUrl);
            }
        };
        sReceiver = receiver;
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Android 13+ 动态注册必须显式声明导出标志；系统广播只能用 RECEIVER_EXPORTED
            app.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            app.registerReceiver(receiver, filter);
        }
    }

    /** 查询下载状态；记录已不存在时返回 STATUS_UNKNOWN。 */
    private static int queryStatus(Context app, long id) {
        try {
            DownloadManager dm = (DownloadManager) app.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return STATUS_UNKNOWN;
            Cursor c = dm.query(new DownloadManager.Query().setFilterById(id));
            if (c == null) return STATUS_UNKNOWN;
            try {
                if (!c.moveToFirst()) return STATUS_UNKNOWN;
                return c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            } finally {
                c.close();
            }
        } catch (Throwable t) {
            return STATUS_UNKNOWN;
        }
    }

    /**
     * 下载已终结则处理并返回 true：成功 → 摘要校验后调起安装；失败 / 记录消失 → 清理并提示。
     * 仍在进行（排队中、下载中、暂停）返回 false，调用方继续等待完成广播。
     */
    private static boolean handleIfFinished(final Activity activity, final long id,
                                            final String fileName, final String shaUrl) {
        if (activity == null) return true;
        final Context app = activity.getApplicationContext();
        int status = queryStatus(app, id);
        if (status != DownloadManager.STATUS_SUCCESSFUL
                && status != DownloadManager.STATUS_FAILED
                && status != STATUS_UNKNOWN) {
            return false;
        }
        clearPending(app);

        final File file = new File(ApkFileProvider.updatesDir(app), fileName);
        final boolean downloaded = status == DownloadManager.STATUS_SUCCESSFUL;
        // 摘要校验要整包读盘、签名比对要解析整个 APK，都会耗时，整段放后台线程，避免卡 UI。
        new Thread(new Runnable() {
            @Override
            public void run() {
                boolean ok = downloaded;
                if (ok && shaUrl != null && !shaUrl.isEmpty()) {
                    String expected = fetchSha256(shaUrl);
                    // 取不到期望值时不否决，交给签名校验与安装器兜底。
                    if (!expected.isEmpty()) ok = expected.equalsIgnoreCase(sha256Of(file));
                }
                if (!ok || !file.exists()) {
                    file.delete();
                    toast(app, "安装包下载或校验失败，请稍后重试");
                    return;
                }
                if (!signatureMatches(app, file)) {
                    activity.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            showSignatureMismatchDialog(activity, file);
                        }
                    });
                    return;
                }
                installApk(app, file);
            }
        }, "dyindex-update-verify").start();
        return true;
    }

    /** 拉取 .sha256 资产内容并解析出第一个十六进制串；失败返回空串。 */
    private static String fetchSha256(String urlStr) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", "dyindex-android");
            if (conn.getResponseCode() != 200) return "";
            InputStream in = conn.getInputStream();
            try {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[1024];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                String text = bos.toString("UTF-8").trim();
                // sha256sum 输出形如「<64位hex>  <文件名>」，取第一段。
                int sp = text.indexOf(' ');
                String hex = sp > 0 ? text.substring(0, sp) : text;
                hex = hex.trim().toLowerCase();
                return hex.matches("[0-9a-f]{64}") ? hex : "";
            } finally {
                in.close();
            }
        } catch (Throwable t) {
            return "";
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 清除「进行中的下载」记录。 */
    private static void clearPending(Context app) {
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_PENDING_ID).remove(KEY_PENDING_NAME)
                .remove(KEY_PENDING_SHA_URL).apply();
    }

    /** 清掉共享目录里遗留的安装包。 */
    private static void cleanUpdatesDir(Context app) {
        try {
            File[] files = ApkFileProvider.updatesDir(app).listFiles();
            if (files == null) return;
            for (File f : files) {
                if (f.isFile()) f.delete();
            }
        } catch (Throwable ignored) {
        }
    }

    private static void installApk(Context app, File file) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(ApkFileProvider.buildUri(app, file.getName()),
                ApkFileProvider.APK_MIME);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            app.startActivity(intent);
        } catch (Throwable t) {
            toast(app, "无法调起安装器，安装包已保存到：" + file.getAbsolutePath());
        }
    }

    /**
     * 待装 APK 的签名是否与已装应用兼容（与枚举顺序无关）；任一方读不出签名时返回 true，交给系统安装器兜底。
     *
     * 不能用 List.equals：它是顺序敏感的，而密钥轮换后已装应用读的是「签名证书历史」（可能含旧证书、
     * 顺序也不保证），APK 侧读的是当前签名，误判会让本可正常覆盖安装的包弹「无法覆盖安装」并引导用户卸载。
     * 这里改判「APK 的每个签名者都在已装应用的签名集合内」。
     */
    private static boolean signatureMatches(Context app, File apk) {
        List<Signature> installed = signaturesOf(app, null);
        List<Signature> incoming = signaturesOf(app, apk.getAbsolutePath());
        if (installed.isEmpty() || incoming.isEmpty()) return true;
        Set<String> known = new HashSet<>(fingerprintsOf(installed));
        for (String f : fingerprintsOf(incoming)) {
            if (!known.contains(f)) return false;
        }
        return true;
    }

    /** 取签名指纹集合，用于与枚举顺序无关的比较。 */
    private static List<String> fingerprintsOf(List<Signature> list) {
        List<String> out = new ArrayList<>(list.size());
        for (Signature s : list) out.add(s.toCharsString());
        return out;
    }

    /** 读取签名集合：apkPath 为 null 时读已安装应用，否则读 APK 文件。 */
    private static List<Signature> signaturesOf(Context app, String apkPath) {
        try {
            PackageManager pm = app.getPackageManager();
            PackageInfo pi;
            if (apkPath == null) {
                pi = pm.getPackageInfo(app.getPackageName(), SIGNATURE_FLAG);
            } else {
                pi = pm.getPackageArchiveInfo(apkPath, SIGNATURE_FLAG);
                // 从 APK 文件读签名需补上这两个路径，否则部分 ROM 会返回空签名
                if (pi != null && pi.applicationInfo != null) {
                    pi.applicationInfo.sourceDir = apkPath;
                    pi.applicationInfo.publicSourceDir = apkPath;
                }
            }
            return signaturesFrom(pi);
        } catch (Throwable t) {
            return new ArrayList<>();
        }
    }

    /** 兼容 API 26–27 的 signatures 与 API 28+ 的 signingInfo 两种读取方式。 */
    private static List<Signature> signaturesFrom(PackageInfo pi) {
        List<Signature> list = new ArrayList<>();
        if (pi == null) return list;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            SigningInfo si = pi.signingInfo;
            if (si == null) return list;
            Signature[] array = si.hasMultipleSigners()
                    ? si.getApkContentsSigners()
                    : si.getSigningCertificateHistory();
            if (array != null) {
                for (Signature s : array) list.add(s);
            }
        } else if (pi.signatures != null) {
            for (Signature s : pi.signatures) list.add(s);
        }
        return list;
    }

    /** 签名不一致（换了签名密钥）时不再直接调安装器，避免用户对着失败提示不知所措。 */
    private static void showSignatureMismatchDialog(final Activity activity, final File file) {
        if (activity == null) return;
        if (activity.isFinishing()) {
            toast(activity, "新旧安装包签名不一致，请卸载后重新下载安装：" + RELEASES_PAGE);
            return;
        }
        String msg = "检测到新旧安装包签名不一致，系统不允许覆盖安装。\n\n"
                + "请先卸载当前版本（应用内的本地数据会被清除），再访问下面地址重新下载安装：\n"
                + RELEASES_PAGE;
        new AlertDialog.Builder(activity)
                .setTitle("无法覆盖安装")
                .setMessage(msg)
                .setPositiveButton("去卸载", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        openUninstall(activity);
                    }
                })
                .setNeutralButton("复制下载地址", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        copyText(activity, RELEASES_PAGE);
                    }
                })
                .setNegativeButton("稍后", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        file.delete();
                    }
                })
                .show();
    }

    /** 打开系统卸载界面（卸载必须由用户确认，无法静默执行）。 */
    private static void openUninstall(Activity activity) {
        try {
            Intent intent = new Intent(Intent.ACTION_DELETE);
            intent.setData(Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(intent);
        } catch (Throwable t) {
            toast(activity, "请到系统设置里手动卸载本应用");
        }
    }

    private static void copyText(Context ctx, String text) {
        try {
            ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) return;
            cm.setPrimaryClip(ClipData.newPlainText("下载地址", text));
            toast(ctx, "下载地址已复制");
        } catch (Throwable ignored) {
        }
    }

    private static void openInstallPermissionSettings(Activity activity) {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(intent);
        } catch (Throwable t) {
            try {
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES));
            } catch (Throwable ignored) {
            }
        }
    }

    // ===== 工具 =====

    private static void toast(final Context ctx, final String msg) {
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(ctx, msg, Toast.LENGTH_LONG).show();
            }
        });
    }

    /** 计算文件 SHA-256（小写 hex）；失败返回空串。 */
    static String sha256Of(File file) {
        if (file == null || !file.exists()) return "";
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (Throwable t) {
            return "";
        }
        try {
            InputStream in = new FileInputStream(file);
            try {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            } finally {
                in.close();
            }
        } catch (Throwable t) {
            return "";
        }
        byte[] digest = md.digest();
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }
}
