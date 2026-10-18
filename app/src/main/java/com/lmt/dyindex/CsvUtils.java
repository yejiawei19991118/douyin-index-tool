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

    /**
     * 导出文件名：按关键词固定命名（不带时间戳），同名覆盖，
     * 反复抓取只会保留「每个关键词一份最新结果」，不会在下载目录堆重复文件。
     */
    public static String fileNameFor(String keyword) {
        return "抖音指数_" + sanitizeFileName(keyword) + "_人群分析.csv";
    }
}
