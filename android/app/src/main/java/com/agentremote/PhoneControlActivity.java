package com.agentremote;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ServiceConnection;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class PhoneControlActivity extends Activity {
    private static final int SHARE_SCREEN = 57;
    static final String CONFIG = "phone_config";
    private PhoneProjectionService service;
    private String choosingFor;
    private TextView status;
    private Button setup, ready, accept, reject, stop;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (saved != null) choosingFor = saved.getString("choosingFor");
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        int inset = Math.round(24 * getResources().getDisplayMetrics().density);
        column.setPadding(inset, inset, inset, inset);
        TextView heading = new TextView(this);
        heading.setText("手机远控");
        heading.setTextSize(26);
        column.addView(heading);
        status = new TextView(this);
        status.setPadding(0, inset / 2, 0, inset / 2);
        status.setTextSize(16);
        column.addView(status);
        setup = button(column, "前往无障碍设置", () -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        ready = button(column, "设为可被控", () -> {
            if (service != null) service.waitForController(getIntent().getStringExtra(CONFIG));
        });
        accept = button(column, "允许看屏和操作", this::share);
        reject = button(column, "拒绝", () -> { if (service != null) service.reject(service.request()); });
        stop = button(column, "停止远控", () -> { if (service != null) service.finish("远控已停止。"); });
        setContentView(column);
        bindService(new Intent(this, PhoneProjectionService.class), binding, BIND_AUTO_CREATE);
        render();
    }

    private final ServiceConnection binding = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((PhoneProjectionService.LocalBinder) binder).service();
            service.onChange(PhoneControlActivity.this::render);
            render();
        }
        @Override public void onServiceDisconnected(ComponentName name) { service = null; render(); }
    };

    private Button button(LinearLayout container, String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setOnClickListener(view -> action.run());
        container.addView(button);
        return button;
    }

    @Override protected void onResume() { super.onResume(); render(); }

    private void render() {
        if (status == null) return;
        boolean accessible = PhoneAccessibilityService.current() != null;
        boolean online = service != null && service.connected();
        boolean pending = service != null && service.request() != null && !service.accepted();
        status.setText(!accessible && !online ? "启用 Remote Agent 无障碍操作后，电脑才可以点击、滚动和输入文字。" :
                service != null ? service.status() : "正在准备手机远控…");
        setup.setVisibility(accessible || online ? View.GONE : View.VISIBLE);
        ready.setVisibility(accessible && !online ? View.VISIBLE : View.GONE);
        ready.setEnabled(service != null);
        accept.setVisibility(pending ? View.VISIBLE : View.GONE);
        accept.setEnabled(choosingFor == null);
        reject.setVisibility(pending ? View.VISIBLE : View.GONE);
        stop.setVisibility(online ? View.VISIBLE : View.GONE);
    }

    private void share() {
        if (service == null || choosingFor != null || PhoneAccessibilityService.current() == null) return;
        choosingFor = service.request();
        if (choosingFor == null) return;
        MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
        Intent capture = Build.VERSION.SDK_INT >= 34
                ? manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                : manager.createScreenCaptureIntent();
        startActivityForResult(capture, SHARE_SCREEN);
        render();
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != SHARE_SCREEN) return;
        String id = choosingFor;
        choosingFor = null;
        if (service != null) {
            if (result == RESULT_OK && data != null) service.confirm(id, data);
            else service.reject(id);
        }
        render();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString("choosingFor", choosingFor);
    }

    @Override protected void onDestroy() {
        if (service != null) service.onChange(null);
        unbindService(binding);
        super.onDestroy();
    }
}
