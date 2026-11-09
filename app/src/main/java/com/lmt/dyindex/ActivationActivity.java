package com.lmt.dyindex;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputFilter;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 登录激活页：展示本机机器码并校验卡密。
 *
 * 卡密由作者用「卡密生成器」按本机机器码签发，清单经 Ed25519 验签后本地判定（一卡一机），
 * 激活成功后进入主界面；未激活/激活失效时 MainActivity 会跳回本页。
 */
public class ActivationActivity extends Activity {

    private static final int ACCENT = 0xFF2F6DF6;
    private static final int TEXT_MAIN = 0xFF1F2430;
    private static final int TEXT_SUB = 0xFF5B6472;

    private EditText cardInput;
    private Button activateBtn;
    private TextView statusView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xFFFFFFFF);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(22);
        root.setPadding(pad, dp(34), pad, dp(34));
        scroll.addView(root, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = new TextView(this);
        title.setText("激活使用");
        title.setTextSize(24);
        title.setTextColor(TEXT_MAIN);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText("本工具需要卡密授权 · 一卡一机");
        sub.setTextSize(13);
        sub.setTextColor(TEXT_SUB);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        subLp.topMargin = dp(6);
        subLp.bottomMargin = dp(22);
        root.addView(sub, subLp);

        // ===== 本机机器码 =====
        LinearLayout mcBox = new LinearLayout(this);
        mcBox.setOrientation(LinearLayout.VERTICAL);
        mcBox.setBackground(bg(0xFFF7F9FC, 14, 0xFFDBE1EA));
        mcBox.setPadding(dp(16), dp(14), dp(16), dp(14));

        TextView mcLabel = new TextView(this);
        mcLabel.setText("本机机器码");
        mcLabel.setTextSize(12.5f);
        mcLabel.setTextColor(TEXT_SUB);
        mcLabel.setTypeface(null, android.graphics.Typeface.BOLD);
        mcBox.addView(mcLabel);

        final String mc = LicenseManager.machineCode(this);
        TextView mcValue = new TextView(this);
        mcValue.setText(mc);
        mcValue.setTextSize(18);
        mcValue.setTextColor(TEXT_MAIN);
        mcValue.setLetterSpacing(0.08f);
        mcValue.setGravity(Gravity.CENTER_HORIZONTAL);
        mcValue.setTextIsSelectable(true);
        LinearLayout.LayoutParams mcValueLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mcValueLp.topMargin = dp(8);
        mcBox.addView(mcValue, mcValueLp);

        Button copyMc = new Button(this);
        copyMc.setText("复制机器码");
        copyMc.setAllCaps(false);
        copyMc.setTextSize(14);
        copyMc.setTextColor(ACCENT);
        copyMc.setBackground(bg(0xFFFFFFFF, 10, 0xFFDBE1EA));
        LinearLayout.LayoutParams copyLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(42));
        copyLp.topMargin = dp(12);
        mcBox.addView(copyMc, copyLp);
        copyMc.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View v) {
                copy(mc);
            }
        });

        root.addView(mcBox);

        TextView tip = new TextView(this);
        tip.setText("把上面的机器码发给作者换取卡密；换设备或重置系统后机器码会变化，需要重新取号。");
        tip.setTextSize(12.5f);
        tip.setTextColor(TEXT_SUB);
        tip.setLineSpacing(0, 1.4f);
        LinearLayout.LayoutParams tipLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tipLp.topMargin = dp(10);
        tipLp.bottomMargin = dp(22);
        root.addView(tip, tipLp);

        // ===== 卡密输入 =====
        cardInput = new EditText(this);
        cardInput.setHint("XXXX-XXXX-XXXX-XXXX-XXXX");
        cardInput.setTextSize(16);
        cardInput.setTextColor(TEXT_MAIN);
        cardInput.setHintTextColor(0xFF9AA4B2);
        cardInput.setSingleLine(true);
        cardInput.setGravity(Gravity.CENTER_VERTICAL);
        cardInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS);
        cardInput.setFilters(new InputFilter[]{new InputFilter.LengthFilter(40)});
        cardInput.setPadding(dp(14), 0, dp(14), 0);
        cardInput.setBackground(bg(0xFFFBFCFE, 12, 0xFFDBE1EA));
        root.addView(cardInput, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(50)));

        activateBtn = new Button(this);
        activateBtn.setText("激活");
        activateBtn.setAllCaps(false);
        activateBtn.setTextSize(16);
        activateBtn.setTextColor(0xFFFFFFFF);
        activateBtn.setBackground(bg(ACCENT, 12, 0));
        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(50));
        btnLp.topMargin = dp(14);
        root.addView(activateBtn, btnLp);

        statusView = new TextView(this);
        statusView.setTextSize(13);
        statusView.setTextColor(TEXT_SUB);
        statusView.setLineSpacing(0, 1.4f);
        LinearLayout.LayoutParams stLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        stLp.topMargin = dp(12);
        root.addView(statusView, stLp);

        activateBtn.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View v) {
                doActivate();
            }
        });

        setContentView(scroll);

        // 还没激活的用户也要能拿到修复版：沿用主界面那套后台静默更新（有新版则下载并调起安装器）。
        Updater.resumePendingInstall(this);
        Updater.checkAndPrompt(this, false);
    }

    private void doActivate() {
        final String card = cardInput.getText().toString();
        if (LicenseManager.normalize(card).isEmpty()) {
            setStatus("请输入卡密");
            return;
        }
        activateBtn.setEnabled(false);
        setStatus("正在联网校验卡密…");
        new Thread(new Runnable() {
            @Override
            public void run() {
                final LicenseManager.Result r =
                        LicenseManager.activate(getApplicationContext(), card);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (isFinishing() || isDestroyed()) return;
                        if (r.ok) {
                            Toast.makeText(ActivationActivity.this, r.msg, Toast.LENGTH_SHORT).show();
                            startActivity(new Intent(ActivationActivity.this, MainActivity.class));
                            finish();
                            return;
                        }
                        activateBtn.setEnabled(true);
                        setStatus(r.msg);
                    }
                });
            }
        }, "dyindex-activate").start();
    }

    private void setStatus(String text) {
        statusView.setText(text);
    }

    private void copy(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) return;
            cm.setPrimaryClip(ClipData.newPlainText("本机机器码", text));
            Toast.makeText(this, "机器码已复制", Toast.LENGTH_SHORT).show();
        } catch (Throwable ignored) {
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private GradientDrawable bg(int color, int radiusDp, int strokeColor) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(radiusDp));
        if (strokeColor != 0) d.setStroke(dp(1), strokeColor);
        return d;
    }
}
