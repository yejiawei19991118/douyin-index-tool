package com.lmt.dyindex;

import java.net.URLEncoder;

/**
 * 目标页面地址构造。
 *
 * 纯逻辑、不依赖 Android 框架，便于在 JVM 上做单元测试（见 app/src/test）。
 */
public final class AppUrls {

    /** 指数页根地址：分析页与三类搜索页都挂在它下面。 */
    public static final String BASE_URL =
            "https://creator.douyin.com/creator-micro/creator-count/arithmetic-index";

    /** 人群分析页基础地址。 */
    public static final String ANALYSIS_URL = BASE_URL + "/analysis";

    /** 达人搜索页（输入抖音号 / 昵称，手动进入「达人详情」切粉丝分析）。 */
    public static final String DAREN_SEARCH_URL = BASE_URL + "/daren/search";

    /** 视频搜索页（手动进入一个视频切观众分析）。 */
    public static final String VIDEO_SEARCH_URL = BASE_URL + "/videosearch";

    /** 话题搜索页（手动进入「话题分析」切人群分析）。 */
    public static final String TOPIC_SEARCH_URL = BASE_URL + "/topicsearch";

    private AppUrls() {
    }

    /**
     * 由关键词拼出人群分析页地址；关键词做 URL 编码，中文 / 空格 / 特殊字符都能安全带上。
     *
     * @param keyword 关键词，可为 null（按空串处理）
     */
    public static String targetUrl(String keyword) {
        return ANALYSIS_URL
                + "?keyword=" + enc(keyword) + "&tab=crowd&appName=aweme&source=creator";
    }

    /** 达人搜索页地址，参数名 keyword。 */
    public static String darenSearchUrl(String keyword) {
        return DAREN_SEARCH_URL + "?keyword=" + enc(keyword);
    }

    /** 视频搜索页地址，参数名 query。 */
    public static String videoSearchUrl(String keyword) {
        return VIDEO_SEARCH_URL + "?query=" + enc(keyword);
    }

    /** 话题搜索页地址，参数名 topic。 */
    public static String topicSearchUrl(String keyword) {
        return TOPIC_SEARCH_URL + "?topic=" + enc(keyword);
    }

    /** URL 编码；UTF-8 是 JVM 必备字符集，失败兜底为原串以免页面打不开。 */
    private static String enc(String keyword) {
        String kw = keyword == null ? "" : keyword;
        try {
            return URLEncoder.encode(kw, "UTF-8");
        } catch (Exception e) {
            return kw;
        }
    }
}
