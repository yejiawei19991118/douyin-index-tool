package com.lmt.dyindex;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 卡密授权（一卡一机）：与「卡密生成器」（github.com/yejiawei19991118/lmt-cards）同一套清单制式。
 *
 * 安全模型：
 *  - 客户端只内置 Ed25519 公钥，清单 cards.json 由作者用私钥签发（字段 sig2）；验签失败一律不采纳。
 *  - 机器码取本机稳定标识派生（ANDROID_ID + CPU 核心数），卡密在清单里通过 cards[].mc 与本机绑定。
 *  - 离线凭证：验签通过的清单连同拉取时间缓存本地，断网时仍可判定，但超过 TTL 天必须联网刷新。
 *
 * 运行时零第三方依赖：Ed25519 验签、SHA-512、Base32 全部自带实现（org.json 由框架提供）。
 */
public final class LicenseManager {

    // ===== 清单契约（与生成器 / lmt-layout 完全一致，改动必须两侧同步）=====

    /** 客户端公钥（base32，52 字符）；私钥只存在于「卡密生成器」。 */
    private static final String PUBKEY_B32 = "M67HT17D19HYQS5CHWKRN05GVEFSTVVV01ADAXP579C66A09RFN0";

    /** 只接受 ver === 2 的清单。 */
    private static final int MANIFEST_VER = 2;

    /** 离线凭证有效期（天）。 */
    private static final int CRED_TTL_DAYS = 14;

    /** 清单超过该时长就顺手后台刷新一次（让在线吊销能尽快生效）。 */
    private static final long REFRESH_AFTER_MS = 24L * 3600 * 1000;

    /** 清单主源（GitHub raw）。 */
    private static final String MANIFEST_URL =
            "https://raw.githubusercontent.com/yejiawei19991118/lmt-cards/refs/heads/main/cards.json";

    /** 备用镜像（raw 在国内常被重置；jsDelivr 缓存约 12 小时，仅作兜底）。 */
    private static final String[] MANIFEST_MIRRORS = {
            "https://cdn.jsdelivr.net/gh/yejiawei19991118/lmt-cards@main/cards.json",
            "https://cdn.jsdelivr.net/gh/yejiawei19991118/lmt-cards/cards.json"
    };

    /** 自定义 base32 字母表：去掉易混淆的 I/L/O/U（与生成器一致）。 */
    private static final String ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    private static final int TIMEOUT_MS = 10000;

    private static final String PREFS = "dyindex_license";
    private static final String KEY_CARD = "card";
    private static final String KEY_MC = "mc";
    private static final String KEY_EXP = "exp";
    private static final String KEY_CACHE = "manifest_cache";

    private LicenseManager() {
    }

    /** 激活结果（msg 可直接展示给用户）。 */
    public static final class Result {
        public final boolean ok;
        public final String msg;
        public final String exp;

        Result(boolean ok, String msg, String exp) {
            this.ok = ok;
            this.msg = msg;
            this.exp = exp;
        }
    }

    /** 验签通过的清单。 */
    private static final class Manifest {
        String updated;
        String rev;
        final Map<String, Entry> cards = new HashMap<>();
        final Set<String> revoked = new HashSet<>();
        boolean verified;
    }

    private static final class Entry {
        String card;
        String mc;
        String note;
        String exp;
    }

    // ===== 对外入口 =====

    /** 本机机器码（形如 XXXX-XXXX-XXXX-XXXX），用于向作者换取一卡一机的卡密。 */
    public static String machineCode(Context ctx) {
        String androidId = "";
        try {
            androidId = Settings.Secure.getString(ctx.getContentResolver(), Settings.Secure.ANDROID_ID);
        } catch (Throwable ignored) {
        }
        if (androidId == null) androidId = "";
        if (androidId.isEmpty()) {
            // 极少数设备取不到 ANDROID_ID，退回机型标识（仍在同机型内稳定）。
            androidId = Build.MODEL + "|" + Build.DEVICE;
        }
        // 只取跨会话稳定的特征：ANDROID_ID 重装/清数据/系统升级都不变。
        // 语言、时区、屏幕尺寸、系统版本号会变，一律不参与，避免同一台机器的机器码漂移。
        String fp = androidId + "|dyindex";
        return group(base32Encode(hexToBytes(sha256Hex(fp)), 16), 4);
    }

    /** 当前是否已激活（纯本地判定：记录 + 缓存清单，不联网）。 */
    public static boolean isActivated(Context ctx) {
        SharedPreferences sp = prefs(ctx);
        String card = sp.getString(KEY_CARD, "");
        String mc = sp.getString(KEY_MC, "");
        String exp = sp.getString(KEY_EXP, "");
        if (card.isEmpty() || mc.isEmpty()) return false;
        if (!mc.equals(machineCode(ctx))) return false;
        if (isExpired(exp)) return false;
        Manifest m = loadCachedManifest(ctx);
        if (m == null) return false;
        return decide(ctx, card, m).ok;
    }

    /**
     * 激活（会联网拉清单，必须在后台线程调用）。
     * 拉取失败时退回本地缓存清单（离线凭证），仍受 TTL 约束。
     */
    public static Result activate(Context ctx, String input) {
        String card = normalize(input);
        if (card.isEmpty()) return new Result(false, "请输入卡密", "");
        if (!cardFormatOk(card)) return new Result(false, "卡密格式不正确（应为 20 位字母数字）", "");

        Manifest m = fetchAndVerify(ctx);
        boolean online = m != null;
        if (m == null) m = loadCachedManifest(ctx);
        if (m == null) {
            return new Result(false, "无法获取卡密清单，请检查网络后重试", "");
        }
        Decision d = decide(ctx, card, m);
        if (!d.ok) return new Result(false, d.msg, d.exp);

        prefs(ctx).edit()
                .putString(KEY_CARD, card)
                .putString(KEY_MC, machineCode(ctx))
                .putString(KEY_EXP, d.exp == null ? "" : d.exp)
                .apply();
        return new Result(true, "激活成功" + (online ? "（在线校验）" : "（离线凭证）"), d.exp);
    }

    /** 退出激活（清掉本地记录，不清清单缓存）。 */
    public static void deactivate(Context ctx) {
        prefs(ctx).edit().remove(KEY_CARD).remove(KEY_MC).remove(KEY_EXP).apply();
    }

    /** 清单缓存超过 24 小时就后台静默刷新一次，让在线吊销与有效期变更尽快生效。 */
    public static void refreshIfStaleAsync(final Context ctx) {
        if (ageMs(ctx) < REFRESH_AFTER_MS) return;
        final Context app = ctx.getApplicationContext();
        new Thread(new Runnable() {
            @Override
            public void run() {
                fetchAndVerify(app);
            }
        }, "dyindex-license-sync").start();
    }

    // ===== 判定 =====

    private static final class Decision {
        boolean ok;
        String msg = "";
        String exp = "";
    }

    /**
     * 授权判定（在线 / 离线同一套）：
     * 吊销优先 → 清单未命中 → 一卡一机不匹配 → 已过期 → 离线凭证超期。
     */
    private static Decision decide(Context ctx, String card, Manifest m) {
        Decision d = new Decision();
        if (!m.verified) {
            d.msg = "清单校验失败（结构不符或签名错误），请联系作者更新清单";
            return d;
        }
        if (m.revoked.contains(card)) {
            d.msg = "该卡密已被吊销";
            return d;
        }
        Entry e = m.cards.get(card);
        if (e == null) {
            d.msg = "卡密不在有效清单中";
            return d;
        }
        if (!e.mc.isEmpty() && !e.mc.equals(machineCode(ctx))) {
            d.msg = "卡密与本机不匹配（一卡一机），请使用本机机器码对应的卡密";
            return d;
        }
        if (isExpired(e.exp)) {
            d.msg = "卡密已过期（有效期至 " + e.exp + "）";
            d.exp = e.exp;
            return d;
        }
        if (!credFresh(ctx)) {
            d.msg = "离线凭证已超过 " + CRED_TTL_DAYS + " 天未联网刷新，请联网后重试";
            d.exp = e.exp;
            return d;
        }
        d.ok = true;
        d.exp = e.exp;
        return d;
    }

    /** 只有 YYYY-MM-DD 且严格早于今天才算过期；空值 / 非法值视为长期有效。 */
    private static boolean isExpired(String exp) {
        String s = exp == null ? "" : exp.trim();
        if (!s.matches("\\d{4}-\\d{2}-\\d{2}")) return false;
        java.util.Calendar c = java.util.Calendar.getInstance();
        String today = String.format(Locale.US, "%04d-%02d-%02d",
                c.get(java.util.Calendar.YEAR),
                c.get(java.util.Calendar.MONTH) + 1,
                c.get(java.util.Calendar.DAY_OF_MONTH));
        return s.compareTo(today) < 0;
    }

    // ===== 清单拉取 / 缓存 =====

    /** 依次尝试主源与镜像；返回首个验签通过的清单，全失败返回 null。 */
    private static Manifest fetchAndVerify(Context ctx) {
        List<String> sources = new ArrayList<>();
        sources.add(MANIFEST_URL);
        for (String u : MANIFEST_MIRRORS) {
            if (u != null && !u.isEmpty() && !sources.contains(u)) sources.add(u);
        }
        for (String u : sources) {
            String raw = httpGet(u);
            if (raw == null) continue;
            Manifest m = parseManifest(raw);
            if (m == null) continue;      // 结构不可用（CDN 错误页等）→ 换下一个源
            if (!m.verified) continue;    // 验签失败 → 换下一个源
            saveCache(ctx, raw);
            return m;
        }
        return null;
    }

    private static String httpGet(String urlStr) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", "dyindex-android");
            conn.setRequestProperty("Cache-Control", "no-store");
            if (conn.getResponseCode() != 200) return null;
            InputStream in = conn.getInputStream();
            try {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                return bos.toString("UTF-8");
            } finally {
                in.close();
            }
        } catch (Throwable t) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 解析 + 公钥验签；结构不可用返回 null。 */
    static Manifest parseManifest(String raw) {
        if (raw == null) return null;
        try {
            JSONObject o = new JSONObject(raw);
            int ver = o.optInt("ver", -1);
            Manifest m = new Manifest();
            m.updated = o.optString("updated", "").trim();
            m.rev = o.optString("rev", "").trim();
            JSONArray cards = o.optJSONArray("cards");
            if (cards == null) return null;
            for (int i = 0; i < cards.length(); i++) {
                JSONObject c = cards.optJSONObject(i);
                if (c == null) continue;
                String card = normalize(c.optString("card", ""));
                if (card.isEmpty()) continue;
                Entry e = new Entry();
                e.card = card;
                e.mc = normalize(c.optString("mc", ""));
                e.note = c.optString("note", "").trim();
                e.exp = c.optString("exp", "").trim();
                m.cards.put(card, e);
            }
            JSONArray revoked = o.optJSONArray("revoked");
            if (revoked != null) {
                for (int i = 0; i < revoked.length(); i++) {
                    String r = normalize(revoked.optString(i, ""));
                    if (!r.isEmpty()) m.revoked.add(r);
                }
            }
            String sig = o.optString("sig2", "");
            if (ver != MANIFEST_VER || sig.isEmpty()) return m; // verified 保持 false
            String canonical = canonicalManifestString(ver, m.updated, m.rev, m.cards, m.revoked);
            byte[] pub = base32Decode(PUBKEY_B32, 32);
            byte[] sigBytes = base32Decode(sig, 64);
            m.verified = pub != null && sigBytes != null
                    && Ed25519.verify(pub, canonical.getBytes(StandardCharsets.UTF_8), sigBytes);
            return m;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 规范化串（与生成器逐字一致）。 */
    private static String canonicalManifestString(int ver, String updated, String rev,
                                                  Map<String, Entry> cards, Set<String> revoked) {
        // 排序键 = mc + \u0000 + card；每行 = card|mc|note|exp
        List<String> keys = new ArrayList<>();
        final Map<String, String> lineByKey = new HashMap<>();
        for (Entry e : cards.values()) {
            String key = e.mc + "\u0000" + e.card;
            keys.add(key);
            lineByKey.put(key, e.card + "|" + e.mc + "|" + e.note + "|" + e.exp);
        }
        Collections.sort(keys);
        List<String> lines = new ArrayList<>(keys.size());
        for (String k : keys) lines.add(lineByKey.get(k));
        List<String> rv = new ArrayList<>(revoked);
        Collections.sort(rv);
        return ver + "\n" + updated + "\n" + rev + "\n" + join(lines, "\n") + "\n" + join(rv, ",");
    }

    private static String join(List<String> list, String sep) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(sep);
            sb.append(list.get(i));
        }
        return sb.toString();
    }

    private static void saveCache(Context ctx, String raw) {
        try {
            JSONObject o = new JSONObject();
            o.put("fetchedAt", System.currentTimeMillis());
            o.put("data", raw);
            prefs(ctx).edit().putString(KEY_CACHE, o.toString()).apply();
        } catch (Throwable ignored) {
        }
    }

    private static long ageMs(Context ctx) {
        try {
            String raw = prefs(ctx).getString(KEY_CACHE, "");
            if (raw.isEmpty()) return Long.MAX_VALUE;
            long at = new JSONObject(raw).optLong("fetchedAt", 0L);
            if (at <= 0) return Long.MAX_VALUE;
            long age = System.currentTimeMillis() - at;
            return age < 0 ? Long.MAX_VALUE : age; // 系统时间回拨视为过期，强制联网刷新
        } catch (Throwable t) {
            return Long.MAX_VALUE;
        }
    }

    private static boolean credFresh(Context ctx) {
        return ageMs(ctx) <= CRED_TTL_DAYS * 86400000L;
    }

    /** 载入缓存清单并重新验签；验签不过返回 null。 */
    private static Manifest loadCachedManifest(Context ctx) {
        try {
            String raw = prefs(ctx).getString(KEY_CACHE, "");
            if (raw.isEmpty()) return null;
            String data = new JSONObject(raw).optString("data", "");
            if (data.isEmpty()) return null;
            Manifest m = parseManifest(data);
            if (m == null || !m.verified) return null;
            return m;
        } catch (Throwable t) {
            return null;
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ===== 编解码 / 派生工具 =====

    static String normalize(String code) {
        return code == null ? "" : code.toUpperCase(Locale.ROOT).replaceAll("[^0-9A-Z]", "");
    }

    /** 卡密格式：随机 20 字符字母数字。 */
    private static boolean cardFormatOk(String card) {
        return card.matches("[0-9A-Z]{20}");
    }

    private static String group(String s, int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i += n) {
            if (i > 0) sb.append('-');
            sb.append(s, i, Math.min(s.length(), i + n));
        }
        return sb.toString();
    }

    private static String sha256Hex(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return toHex(md.digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Throwable t) {
            return "";
        }
    }

    private static String toHex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format(Locale.US, "%02x", x & 0xff));
        return sb.toString();
    }

    private static byte[] hexToBytes(String hex) {
        int n = hex.length() / 2;
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    /** 与生成器一致的 base32：按目标字符数截断。 */
    private static String base32Encode(byte[] bytes, int len) {
        StringBuilder sb = new StringBuilder();
        long buffer = 0;
        int bits = 0;
        for (int i = 0; i < bytes.length && sb.length() < len; i++) {
            buffer = (buffer << 8) | (bytes[i] & 0xff);
            bits += 8;
            while (bits >= 5 && sb.length() < len) {
                bits -= 5;
                sb.append(ALPHABET.charAt((int) ((buffer >>> bits) & 31)));
            }
            buffer &= (1L << bits) - 1;
        }
        return sb.toString();
    }

    /** base32 解码（忽略分隔符 / 大小写），非法、长度不足或非规范补位返回 null。 */
    private static byte[] base32Decode(String str, int byteLen) {
        String s = normalize(str);
        byte[] out = new byte[byteLen];
        int buffer = 0, bits = 0, oi = 0, i = 0;
        for (; i < s.length() && oi < byteLen; i++) {
            int v = ALPHABET.indexOf(s.charAt(i));
            if (v < 0) return null;
            buffer = (buffer << 5) | v;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                out[oi++] = (byte) ((buffer >>> bits) & 0xff);
                buffer &= (1 << bits) - 1;
            }
        }
        if (oi < byteLen) return null;
        if (i < s.length()) return null;
        if (buffer != 0) return null;
        return out;
    }

    // ===== Ed25519 验签（RFC 8032，BigInteger 实现，仅验签） =====

    private static final class Ed25519 {
        private static final BigInteger P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19));
        private static final BigInteger L = BigInteger.ONE.shiftLeft(252)
                .add(new BigInteger("27742317777372353535851937790883648493"));
        private static final BigInteger SQRT_M1 = BigInteger.valueOf(2)
                .modPow(P.subtract(BigInteger.ONE).shiftRight(2), P);
        private static final BigInteger D;
        private static final BigInteger D2;
        private static final Point BASE;

        static {
            BigInteger inv = BigInteger.valueOf(121666).modInverse(P);
            D = BigInteger.valueOf(-121665).multiply(inv).mod(P);
            D2 = D.shiftLeft(1).mod(P);
            // 标准基点编码：小端 y = 4/5，最高位（x 奇偶）为 0
            byte[] b = new byte[32];
            Arrays.fill(b, (byte) 0x66);
            b[0] = 0x58;
            BASE = decode(b);
        }

        private static final class Point {
            final BigInteger x, y, z, t;

            Point(BigInteger x, BigInteger y, BigInteger z, BigInteger t) {
                this.x = x;
                this.y = y;
                this.z = z;
                this.t = t;
            }
        }

        static boolean verify(byte[] pub, byte[] msg, byte[] sig) {
            try {
                if (pub == null || pub.length != 32 || sig == null || sig.length != 64) return false;
                byte[] rBytes = Arrays.copyOfRange(sig, 0, 32);
                byte[] sBytes = Arrays.copyOfRange(sig, 32, 64);
                BigInteger s = leToBig(sBytes);
                if (s.compareTo(L) >= 0) return false;   // 防可塑性签名
                Point a = decode(pub);
                if (a == null) return false;

                MessageDigest md = MessageDigest.getInstance("SHA-512");
                md.update(rBytes);
                md.update(pub);
                md.update(msg);
                BigInteger h = leToBig(md.digest()).mod(L);

                Point r = add(scalarMult(BASE, s), negate(scalarMult(a, h)));
                return Arrays.equals(rBytes, encode(r));
            } catch (Throwable t) {
                return false;
            }
        }

        private static Point decode(byte[] b) {
            byte[] yb = Arrays.copyOf(b, 32);
            boolean sign = (yb[31] & 0x80) != 0;
            yb[31] &= 0x7f;
            BigInteger y = leToBig(yb);
            if (y.compareTo(P) >= 0) return null;
            BigInteger y2 = y.multiply(y).mod(P);
            BigInteger u = y2.subtract(BigInteger.ONE).mod(P);
            BigInteger v = D.multiply(y2).add(BigInteger.ONE).mod(P);
            BigInteger x2 = u.multiply(v.modInverse(P)).mod(P);
            BigInteger x = x2.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P);
            if (!x.multiply(x).mod(P).equals(x2)) {
                x = x.multiply(SQRT_M1).mod(P);
                if (!x.multiply(x).mod(P).equals(x2)) return null;
            }
            if (x.signum() == 0 && sign) return null;
            if (x.testBit(0) != sign) x = P.subtract(x).mod(P);
            return new Point(x, y, BigInteger.ONE, x.multiply(y).mod(P));
        }

        private static Point add(Point p, Point q) {
            BigInteger a = p.y.subtract(p.x).multiply(q.y.subtract(q.x)).mod(P);
            BigInteger b = p.y.add(p.x).multiply(q.y.add(q.x)).mod(P);
            BigInteger c = p.t.multiply(D2).multiply(q.t).mod(P);
            BigInteger d = p.z.multiply(q.z).shiftLeft(1).mod(P);
            BigInteger e = b.subtract(a).mod(P);
            BigInteger f = d.subtract(c).mod(P);
            BigInteger g = d.add(c).mod(P);
            BigInteger h = b.add(a).mod(P);
            return new Point(e.multiply(f).mod(P), g.multiply(h).mod(P),
                    f.multiply(g).mod(P), e.multiply(h).mod(P));
        }

        private static Point scalarMult(Point p, BigInteger n) {
            Point r = new Point(BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO);
            Point q = p;
            for (int i = 0; i < n.bitLength(); i++) {
                if (n.testBit(i)) r = add(r, q);
                q = add(q, q);
            }
            return r;
        }

        private static Point negate(Point p) {
            return new Point(P.subtract(p.x).mod(P), p.y, p.z, P.subtract(p.t).mod(P));
        }

        private static byte[] encode(Point p) {
            BigInteger zi = p.z.modInverse(P);
            BigInteger x = p.x.multiply(zi).mod(P);
            BigInteger y = p.y.multiply(zi).mod(P);
            byte[] out = bigToLe(y, 32);
            if (x.testBit(0)) out[31] |= (byte) 0x80;
            return out;
        }

        private static BigInteger leToBig(byte[] b) {
            BigInteger v = BigInteger.ZERO;
            for (int i = b.length - 1; i >= 0; i--) {
                v = v.shiftLeft(8).or(BigInteger.valueOf(b[i] & 0xff));
            }
            return v;
        }

        private static byte[] bigToLe(BigInteger v, int len) {
            byte[] out = new byte[len];
            BigInteger cur = v;
            for (int i = 0; i < len; i++) {
                out[i] = (byte) cur.and(BigInteger.valueOf(0xff)).intValue();
                cur = cur.shiftRight(8);
            }
            return out;
        }
    }
}
