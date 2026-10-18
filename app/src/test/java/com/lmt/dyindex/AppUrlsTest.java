package com.lmt.dyindex;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** {@link AppUrls} 的单测：关键词必须被正确 URL 编码并拼进目标地址。 */
public class AppUrlsTest {

    @Test
    public void 中文关键词被百分号编码() {
        String url = AppUrls.targetUrl("穿搭");
        assertTrue(url.startsWith(AppUrls.ANALYSIS_URL));
        assertTrue(url.contains("keyword=%E7%A9%BF%E6%90%AD"));
    }

    @Test
    public void 空格编码为加号() {
        assertTrue(AppUrls.targetUrl("a b").contains("keyword=a+b"));
    }

    @Test
    public void 特殊字符被转义() {
        // & 不转义会把参数截断，必须编成 %26
        assertTrue(AppUrls.targetUrl("a&b").contains("keyword=a%26b"));
        assertTrue(AppUrls.targetUrl("a=b").contains("keyword=a%3Db"));
    }

    @Test
    public void 固定查询参数完整保留() {
        String url = AppUrls.targetUrl("穿搭");
        assertTrue(url.contains("&tab=crowd"));
        assertTrue(url.contains("&appName=aweme"));
        assertTrue(url.contains("&source=creator"));
    }

    @Test
    public void 英文数字关键词原样保留() {
        assertEquals(AppUrls.ANALYSIS_URL
                        + "?keyword=beauty2024&tab=crowd&appName=aweme&source=creator",
                AppUrls.targetUrl("beauty2024"));
    }

    @Test
    public void 空关键词与null不抛异常() {
        assertTrue(AppUrls.targetUrl("").contains("keyword=&"));
        assertTrue(AppUrls.targetUrl(null).contains("keyword=&"));
    }
}
