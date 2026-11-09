package com.lmt.dyindex;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** {@link CsvUtils} 的单测：文件名清洗规则。 */
public class CsvUtilsTest {

    @Test
    public void 合法关键词原样保留() {
        assertEquals("穿搭", CsvUtils.sanitizeFileName("穿搭"));
        assertEquals("beauty2024", CsvUtils.sanitizeFileName("beauty2024"));
    }

    @Test
    public void 非法字符全部替换为下划线() {
        assertEquals("a_b_c_d_e_f_g_h_i_j",
                CsvUtils.sanitizeFileName("a/b:c*d?e\"f<g>h|i\\j"));
    }

    @Test
    public void 首尾空白被去掉() {
        assertEquals("穿搭", CsvUtils.sanitizeFileName("  穿搭  "));
    }

    @Test
    public void 空关键词与null回退占位名() {
        assertEquals(CsvUtils.FALLBACK, CsvUtils.sanitizeFileName(""));
        assertEquals(CsvUtils.FALLBACK, CsvUtils.sanitizeFileName(null));
        assertEquals(CsvUtils.FALLBACK, CsvUtils.sanitizeFileName("   "));
    }
}
