package com.lmt.dyindex;

import java.net.URLEncoder;

/**
 * 目标页面地址构造。
 *
 * 纯逻辑、不依赖 Android 框架，便于在 JVM 上做单元测试（见 app/src/test）。
 */
public final class AppUrls {

    /** 人群分析页基础地址。 */
    public static final String ANALYSIS_URL =
            "https://creator.douyin.com/creator-micro/creator-count/arithmetic-index/analysis";

    private AppUrls() {
    }

    /**
     * 由关键词拼出人群分析页地址；关键词做 URL 编码，中文 / 空格 / 特殊字符都能安全带上。
     *
     * @param keyword 关键词，可为 null（按空串处理）
     */
    public static String targetUrl(String keyword) {
        String kw = keyword == null ? "" : keyword;
        String enc;
        try {
            enc = URLEncoder.encode(kw, "UTF-8");
        } catch (Exception e) {
            // UTF-8 是 JVM 必备字符集，理论上不会走到这里；兜底为原串以免页面打不开。
            enc = kw;
        }
        return ANALYSIS_URL
                + "?keyword=" + enc + "&tab=crowd&appName=aweme&source=creator";
    }
}
