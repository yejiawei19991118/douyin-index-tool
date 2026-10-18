package com.lmt.dyindex;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * {@link VersionUtils} 的单测：覆盖 GitHub tag 形态、段数不一致、主/次版本优先等边界。
 */
public class VersionUtilsTest {

    @Test
    public void normalize去掉前导v与后缀() {
        assertEquals("1.2", VersionUtils.normalize("v1.2"));
        assertEquals("1.2", VersionUtils.normalize("V1.2"));
        assertEquals("1.2.3", VersionUtils.normalize("1.2.3"));
        assertEquals("1.2.3", VersionUtils.normalize("v1.2.3-beta"));
        assertEquals("1.2", VersionUtils.normalize("1.2+build9"));
        assertEquals("1.2", VersionUtils.normalize("  1.2  "));
        assertEquals("", VersionUtils.normalize(null));
        assertEquals("", VersionUtils.normalize(""));
    }

    @Test
    public void parseSegments按点切分取整数() {
        assertArrayEquals(new int[]{1, 2, 3}, VersionUtils.parseSegments("v1.2.3"));
        assertArrayEquals(new int[]{1, 2}, VersionUtils.parseSegments("1.2"));
        assertArrayEquals(new int[]{}, VersionUtils.parseSegments(null));
        // 非数字段按 0 处理
        assertArrayEquals(new int[]{1, 0}, VersionUtils.parseSegments("1.x"));
    }

    @Test
    public void 相同版本返回0() {
        assertEquals(0, VersionUtils.compare("1.2", "1.2"));
        assertEquals(0, VersionUtils.compare("v1.2", "1.2"));
        // 段数不同但数值相等
        assertEquals(0, VersionUtils.compare("1.2", "1.2.0"));
        assertEquals(0, VersionUtils.compare("1.2.0.0", "1.2"));
    }

    @Test
    public void 逐段按数值比较而非字符串() {
        assertTrue(VersionUtils.compare("1.10", "1.9") > 0);
        assertTrue(VersionUtils.compare("1.9", "1.10") < 0);
    }

    @Test
    public void 主版本优先于次版本() {
        assertTrue(VersionUtils.compare("2.0", "1.9") > 0);
        assertTrue(VersionUtils.compare("1.9", "2.0") < 0);
    }

    @Test
    public void 末段新增即更新() {
        assertTrue(VersionUtils.compare("1.2.3", "1.2") > 0);
        assertTrue(VersionUtils.compare("1.2", "1.2.1") < 0);
    }

    @Test
    public void 空版本视为最低() {
        assertTrue(VersionUtils.compare("", "1.0") < 0);
        assertTrue(VersionUtils.compare("1.0", "") > 0);
        assertEquals(0, VersionUtils.compare("", null));
    }

    @Test
    public void isNewer严格大于才为真() {
        assertTrue(VersionUtils.isNewer("1.2", "1.1"));
        assertTrue(VersionUtils.isNewer("v1.3", "1.2.9"));
        assertFalse(VersionUtils.isNewer("1.1", "1.1"));
        assertFalse(VersionUtils.isNewer("v1.2", "1.2"));
        assertFalse(VersionUtils.isNewer("1.0", "1.1"));
    }
}
