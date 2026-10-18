package com.lmt.dyindex;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.List;

/**
 * 极简「安装包共享」ContentProvider：只负责把下载好的 APK 以 content:// 形式交给系统安装器。
 *
 * 为什么不用 androidx.core.content.FileProvider：本工程约定零第三方依赖，引入 androidx 会破坏该约定；
 * 而 Uri.fromFile() 在 API 24+ 跨应用传递会抛 FileUriExposedException。
 * 安装 APK 真正需要的只有两件事：告知 MIME 类型、按 URI 打开只读文件描述符，故自建最小实现。
 *
 * authority 在清单里以 ${applicationId}.apk 声明。
 */
public class ApkFileProvider extends ContentProvider {

    /** 安装包 MIME。 */
    public static final String APK_MIME = "application/vnd.android.package-archive";

    /** authority 后缀，配合清单里的 ${applicationId} 使用。 */
    private static final String AUTHORITY_SUFFIX = ".apk";

    /** 共享子目录名（位于应用私有外部目录下，全 API 均无需存储权限）。 */
    public static final String PATH = "updates";

    /** 取共享目录（不存在则创建）。 */
    public static File updatesDir(Context ctx) {
        // 外部存储不可用时 getExternalFilesDir 会返回 null，退回内部私有目录，避免拼出 null 路径。
        File base = ctx.getExternalFilesDir(null);
        if (base == null) base = ctx.getFilesDir();
        File dir = new File(base, PATH);
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /** 构造「content://<applicationId>.apk/updates/<fileName>」。 */
    public static Uri buildUri(Context ctx, String fileName) {
        return new Uri.Builder()
                .scheme("content")
                .authority(ctx.getPackageName() + AUTHORITY_SUFFIX)
                .appendPath(PATH)
                .appendPath(fileName)
                .build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        return APK_MIME;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        // 安装器只需要读；收紧为只读，避免拿到 URI 的调用方改写安装包。
        if (mode != null && (mode.indexOf('w') >= 0 || mode.indexOf('t') >= 0)) {
            throw new FileNotFoundException("只支持只读访问：" + uri);
        }
        List<String> segs = uri.getPathSegments();
        if (segs == null || segs.size() != 2 || !PATH.equals(segs.get(0))) {
            throw new FileNotFoundException("非法路径：" + uri);
        }
        String name = segs.get(1);
        // 只允许读取共享目录下的直接子文件，杜绝 ../ 之类越权
        if (name.isEmpty() || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.contains("..")) {
            throw new FileNotFoundException("非法文件名：" + name);
        }
        Context ctx = getContext();
        if (ctx == null) throw new FileNotFoundException("Provider 未就绪");
        File f = new File(updatesDir(ctx), name);
        if (!f.exists()) throw new FileNotFoundException("文件不存在：" + f);
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
