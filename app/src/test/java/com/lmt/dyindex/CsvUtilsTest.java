package com.lmt.dyindex;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** {@link CsvUtils} 的单测：文件名清洗与固定命名规则。 */
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

    @Test
    public void 导出文件名按关键词固定且带完整后缀() {
        assertEquals("抖音指数_穿搭_人群分析.csv", CsvUtils.fileNameFor("穿搭"));
        assertEquals("抖音指数_a_b_人群分析.csv", CsvUtils.fileNameFor("a/b"));
    }

    @Test
    public void 缺少关键词时导出文件名仍合法() {
        assertEquals("抖音指数_关键词_人群分析.csv", CsvUtils.fileNameFor(null));
        assertEquals("抖音指数_关键词_人群分析.csv", CsvUtils.fileNameFor(""));
    }
}
