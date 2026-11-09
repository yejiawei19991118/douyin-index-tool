package com.lmt.dyindex;

/**
 * CSV 导出文件名规则。
 *
 * 纯逻辑、不依赖 Android 框架，便于在 JVM 上做单元测试（见 app/src/test）。
 */
public final class CsvUtils {

    /** 关键词为空时的占位名。 */
    public static final String FALLBACK = "关键词";

    /** 文件名中的非法字符（Windows/Android 通用）：\ / : * ? " &lt; &gt; | 。 */
    private static final String ILLEGAL = "[\\\\/:*?\"<>|]";

    private CsvUtils() {
    }

    /**
     * 把关键词规整为可安全用作文件名的片段：去首尾空白、非法字符替换为下划线、空则兜底占位。
     */
    public static String sanitizeFileName(String keyword) {
        String kw = keyword == null ? "" : keyword.trim();
        if (kw.isEmpty()) return FALLBACK;
        return kw.replaceAll(ILLEGAL, "_");
    }
}
