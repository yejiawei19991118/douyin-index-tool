package com.lmt.dyindex;

/**
 * 版本号比较。
 *
 * 纯逻辑、不依赖 Android 框架，便于在 JVM 上做单元测试（见 app/src/test）。
 * 支持 GitHub Release 的 tag 形态（如 v1.2、V1.2.3、1.2.3-beta、1.2+build），
 * 也容忍段数不一致（1.2 与 1.2.0 视为相等）。
 */
public final class VersionUtils {

    private VersionUtils() {
    }

    /** 去掉前导 v/V、'-' 起的预发布后缀、'+' 起的构建元数据，返回纯点分数字串。 */
    public static String normalize(String version) {
        if (version == null) return "";
        String v = version.trim();
        if (v.isEmpty()) return "";
        char c0 = v.charAt(0);
        if (c0 == 'v' || c0 == 'V') v = v.substring(1);
        int plus = v.indexOf('+');
        if (plus >= 0) v = v.substring(0, plus);
        int dash = v.indexOf('-');
        if (dash >= 0) v = v.substring(0, dash);
        return v.trim();
    }

    /** 解析为整数段；某段无前导数字（或数值溢出）时该段按 0 处理。 */
    public static int[] parseSegments(String version) {
        String v = normalize(version);
        if (v.isEmpty()) return new int[0];
        String[] parts = v.split("\\.");
        int[] out = new int[parts.length];
        for (int i = 0; i < parts.length; i++) {
            out[i] = leadingInt(parts[i]);
        }
        return out;
    }

    /** 取字符串的前导数字并转 int；无数字或溢出返回 0。 */
    private static int leadingInt(String s) {
        int i = 0;
        while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
        if (i == 0) return 0;
        try {
            return Integer.parseInt(s.substring(0, i));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /**
     * 比较两个版本号：a 比 b 新返回正数，旧返回负数，相同返回 0。
     * 逐段按数值比较（1.10 &gt; 1.9），某一段缺失按 0 补（1.2 == 1.2.0）。
     */
    public static int compare(String a, String b) {
        int[] x = parseSegments(a);
        int[] y = parseSegments(b);
        int n = Math.max(x.length, y.length);
        for (int i = 0; i < n; i++) {
            int xi = i < x.length ? x[i] : 0;
            int yi = i < y.length ? y[i] : 0;
            if (xi != yi) return xi > yi ? 1 : -1;
        }
        return 0;
    }

    /** candidate 是否严格新于 current。 */
    public static boolean isNewer(String candidate, String current) {
        return compare(candidate, current) > 0;
    }
}
