package com.cursorremote.lite;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.util.Base64;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

// Keeps one event stream open to the relay and turns its events into notifications.
// Android WebView has no Web Push, and Google's push service is missing on Huawei phones, so the app listens itself.
public class NotifyService extends Service {
    static final String PREF = "notify";
    private static final String CH_EVENTS = "events";
    private static final String CH_LISTEN = "listen";
    private static final int LISTEN_ID = 1;

    private volatile boolean running;
    private volatile HttpURLConnection conn;
    private Thread worker;

    // Native text follows the phone's language; the web app has its own setting.
    static String tr(String zh, String en) {
        return "zh".equals(Locale.getDefault().getLanguage()) ? zh : en;
    }

    static boolean enabled(Context c) {
        return prefs(c).getString(PREF, null) != null;
    }

    static void start(Context c) {
        if (!enabled(c)) return;
        Intent i = new Intent(c, NotifyService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("cursor-remote", MODE_PRIVATE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannels();
        Notification listening = builder(CH_LISTEN)
                .setContentTitle(tr("Cursor Remote 正在等待 Agent 的消息", "Cursor Remote is listening for the Agent"))
                .setContentText(tr("Agent 完成或需要你确认时会提醒你", "You'll be alerted when the Agent finishes or needs your OK"))
                .setContentIntent(openApp(null, 0))
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(LISTEN_ID, listening, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        else startForeground(LISTEN_ID, listening);

        if (!enabled(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (worker == null || !worker.isAlive()) {
            running = true;
            worker = new Thread(this::loop, "cursor-remote-notify");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void loop() {
        long backoff = 2000;
        while (running) {
            try {
                JSONObject cfg = new JSONObject(prefs(this).getString(PREF, "{}"));
                listen(resolveRelay(cfg.getString("app"), cfg.optString("key")), cfg.getString("token"));
                backoff = 2000;
            } catch (Unauthorized e) {
                // Device was removed or needs 2FA again; the app turns this back on after re-pairing.
                prefs(this).edit().remove(PREF).apply();
                stopSelf();
                return;
            } catch (Exception e) {
                if (!running) return;
                try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
                backoff = Math.min(backoff * 2, 60000);
            }
        }
    }

    // Same lookup as the web app: url.json on GitHub Pages holds the relay address, AES-GCM encrypted with the paired key.
    private String resolveRelay(String app, String key) throws Exception {
        JSONObject info = new JSONObject(get(app + (app.endsWith("/") ? "" : "/") + "url.json?t=" + System.currentTimeMillis()));
        if (info.optBoolean("self")) {
            Uri u = Uri.parse(app);
            return u.getScheme() + "://" + u.getAuthority();
        }
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        byte[] k = Base64.decode(key, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(k, "AES"), new GCMParameterSpec(128, Base64.decode(info.getString("iv"), Base64.DEFAULT)));
        byte[] plain = c.doFinal(Base64.decode(info.getString("data"), Base64.DEFAULT));
        return new JSONObject(new String(plain, StandardCharsets.UTF_8)).getString("url");
    }

    private static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(15000);
        c.setUseCaches(false);
        try (InputStream in = c.getInputStream()) {
            return new String(readAll(in), StandardCharsets.UTF_8);
        } finally {
            c.disconnect();
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private void listen(String relay, String token) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(relay + "/api/events").openConnection();
        conn = c;
        c.setConnectTimeout(15000);
        // The relay pings every 25 s; silence longer than this means the connection is dead.
        c.setReadTimeout(70000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Accept", "text/event-stream");
        try {
            if (c.getResponseCode() == 401) throw new Unauthorized();
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            for (String line; running && (line = r.readLine()) != null; ) {
                if (line.startsWith("data:")) show(new JSONObject(line.substring(5).trim()));
            }
        } finally {
            c.disconnect();
            conn = null;
        }
    }

    private void show(JSONObject e) {
        String win = e.optString("win", "");
        // One notification per window: a newer event replaces the older one.
        int id = win.isEmpty() ? 2 : 3 + (win.hashCode() & 0x7fffffff) % 100000;
        Notification n = builder(CH_EVENTS)
                .setContentTitle(e.optString("title", "Cursor Remote"))
                .setContentText(e.optString("body", ""))
                .setStyle(new Notification.BigTextStyle().bigText(e.optString("body", "")))
                .setContentIntent(openApp(win, id))
                .setAutoCancel(true)
                .build();
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(id, n);
    }

    private PendingIntent openApp(String win, int requestCode) {
        Intent i = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (win != null && !win.isEmpty()) i.putExtra("win", win);
        return PendingIntent.getActivity(this, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification.Builder builder(String channel) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, channel) : new Notification.Builder(this);
        return b.setSmallIcon(R.drawable.ic_notify);
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CH_EVENTS, tr("Agent 提醒", "Agent alerts"), NotificationManager.IMPORTANCE_HIGH));
        NotificationChannel listen = new NotificationChannel(CH_LISTEN, tr("后台连接", "Background connection"), NotificationManager.IMPORTANCE_MIN);
        listen.setShowBadge(false);
        nm.createNotificationChannel(listen);
    }

    private static class Unauthorized extends Exception {}
}
