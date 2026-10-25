package com.agentremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.service.notification.StatusBarNotification;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.HashMap;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

// Keeps one event stream open to the relay and turns its events into notifications.
// Android WebView has no Web Push, and Google's push service is missing on Huawei phones, so the app listens itself.
// Notifications from Devin carry actions (pick an option, accept the changes, reply); they go back to the relay
// through POST /api/act, so nothing has to be opened.
public class NotifyService extends Service {
    static final String PREF = "notify";
    private static final String CH_EVENTS = "events";
    private static final String CH_LISTEN = "listen";
    private static final String CH_WORK = "work";
    private static final int LISTEN_ID = 1;
    private static final String TAG = "RA-notify";
    static final String ACT_NUDGE = "com.agentremote.NUDGE";

    // "off", "connecting", "connected" or "retry"; the web app shows it under Menu > Background connection.
    static volatile String status = "off";
    static volatile String lastError = "";

    private volatile boolean running;
    private volatile boolean skipWait;
    private volatile HttpURLConnection conn;
    // Last time anything (event or the relay's 25 s ping) arrived on the open stream.
    private volatile long lastData;
    private Thread worker, watchdog;
    private final Object gate = new Object();
    private final Map<String, Long> latestSeq = new HashMap<>();
    private ConnectivityManager cm;
    private ConnectivityManager.NetworkCallback netCallback;
    private long backoff = 2000;

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

    // Reconnect right now instead of waiting out the retry delay (menu button, network came back).
    static void nudge(Context c) {
        if (!enabled(c)) return;
        Intent i = new Intent(c, NotifyService.class).setAction(ACT_NUDGE);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("agent-remote", Context.MODE_PRIVATE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannels();
        startForegroundCompat(listening());
        if (!enabled(this)) {
            status = "off";
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null && ACT_NUDGE.equals(intent.getAction())) wake(true);
        if (worker == null || !worker.isAlive()) {
            running = true;
            worker = new Thread(this::loop, "agent-remote-notify");
            worker.start();
            watchNetwork();
        }
        if (watchdog == null || !watchdog.isAlive()) {
            watchdog = new Thread(this::watch, "agent-remote-watchdog");
            watchdog.start();
        }
        return START_STICKY;
    }

    private void startForegroundCompat(Notification n) {
        if (Build.VERSION.SDK_INT >= 34) startForeground(LISTEN_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        else startForeground(LISTEN_ID, n);
    }

    @Override
    public void onDestroy() {
        running = false;
        status = "off";
        if (cm != null && netCallback != null) {
            try { cm.unregisterNetworkCallback(netCallback); } catch (Exception ignored) {}
        }
        wake(true);
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // A dropped connection or a new network (Wi-Fi to mobile data) should reconnect at once, not after the backoff.
    private void watchNetwork() {
        try {
            cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            netCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network n) {
                    wake(!"connected".equals(status));
                }
            };
            cm.registerDefaultNetworkCallback(netCallback);
        } catch (Exception ignored) {}
    }

    // Some phones (seen on ColorOS when the app goes to the background) leave the stream's socket dead
    // without the read ever failing or timing out, while the relay already dropped it. The relay pings
    // every 25 s, so a stream silent for over a minute is gone: drop it and reconnect.
    private void watch() {
        while (running) {
            try { Thread.sleep(15000); } catch (InterruptedException e) { return; }
            long silent = android.os.SystemClock.elapsedRealtime() - lastData;
            if (conn != null && "connected".equals(status) && silent > 65000) {
                Log.i(TAG, "watchdog: stream silent " + silent / 1000 + " s, reconnecting");
                wake(true);
            }
        }
    }

    private void wake(boolean dropCurrent) {
        if (dropCurrent) {
            Log.i(TAG, "wake: drop current connection");
            skipWait = true;
            HttpURLConnection c = conn;
            if (c != null) {
                // disconnect() blocks on some stacks while the read is pending, so do it off the caller's thread.
                new Thread(c::disconnect, "agent-remote-drop").start();
            }
        }
        synchronized (gate) { gate.notifyAll(); }
    }

    private void setStatus(String s) {
        if (s.equals(status)) return;
        status = s;
        try {
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(LISTEN_ID, listening());
        } catch (Exception ignored) {}
    }

    private Notification listening() {
        String text;
        switch (status) {
            case "connected": text = tr("已连接电脑。Agent 完成或需要你确认时会提醒你", "Connected to your computer. You'll be alerted when the Agent finishes or needs your OK"); break;
            case "retry": text = tr("和电脑的连接断开了，正在重连…", "Lost the connection to your computer, reconnecting…"); break;
            default: text = tr("正在连接电脑…", "Connecting to your computer…");
        }
        return builder(CH_LISTEN)
                .setContentTitle(tr("Remote Agent 后台连接", "Remote Agent background connection"))
                .setContentText(text)
                .setContentIntent(openApp(null, 0))
                .setOngoing(true)
                .build();
    }

    private void loop() {
        while (running) {
            try {
                setStatus("connecting");
                JSONObject cfg = new JSONObject(prefs(this).getString(PREF, "{}"));
                String relay = resolveRelay(cfg.getString("app"), cfg.optString("key"));
                Log.i(TAG, "connecting to " + Uri.parse(relay).getHost());
                listen(relay, cfg);
            } catch (Unauthorized e) {
                // Device was removed or needs 2FA again; the app turns this back on after re-pairing.
                prefs(this).edit().remove(PREF).apply();
                status = "off";
                stopSelf();
                return;
            } catch (Exception e) {
                lastError = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                Log.i(TAG, "connect failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                if (!running) return;
            }
            if (!running) return;
            setStatus("retry");
            try {
                if (skipWait) skipWait = false;
                else synchronized (gate) { gate.wait(backoff); }
            } catch (InterruptedException ie) {
                return;
            }
            backoff = Math.min(backoff * 2, 60000);
            Log.i(TAG, "retrying in " + backoff + " ms");
        }
    }

    // Same lookup as the web app: url.json on GitHub Pages holds the relay address, AES-GCM encrypted with the paired key.
    static String resolveRelay(String app, String key) throws Exception {
        JSONObject info = new JSONObject(get(app + (app.endsWith("/") ? "" : "/") + "url.json?t=" + System.currentTimeMillis()));
        if (info.optBoolean("self")) {
            Uri u = Uri.parse(app);
            return u.getScheme() + "://" + u.getAuthority();
        }
        byte[] k = Base64.decode(key, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        if (info.optInt("v") != 3 || info.optJSONArray("computers") == null) return decrypt(k, info);
        JSONArray list = info.getJSONArray("computers");
        String id = computerId(k);
        for (int i = 0; i < list.length(); i++) {
            JSONObject e = list.optJSONObject(i);
            if (e != null && id.equals(e.optString("id"))) {
                try { return decrypt(k, e); } catch (Exception ignored) {}
            }
        }
        // A wrong key fails AES-GCM authentication, so an entry that opens is the one for this computer.
        for (int i = 0; i < list.length(); i++) {
            JSONObject e = list.optJSONObject(i);
            if (e != null && !id.equals(e.optString("id"))) {
                try { return decrypt(k, e); } catch (Exception ignored) {}
            }
        }
        throw new Exception("No address for this computer in url.json");
    }

    private static String decrypt(byte[] k, JSONObject entry) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(k, "AES"), new GCMParameterSpec(128, Base64.decode(entry.getString("iv"), Base64.DEFAULT)));
        byte[] plain = c.doFinal(Base64.decode(entry.getString("data"), Base64.DEFAULT));
        return new JSONObject(new String(plain, StandardCharsets.UTF_8)).getString("url");
    }

    private static String computerId(byte[] k) throws Exception {
        byte[] h = MessageDigest.getInstance("SHA-256").digest(k);
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < 8; i++) s.append(String.format(Locale.ROOT, "%02x", h[i]));
        return s.toString();
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

    private void listen(String relay, JSONObject cfg) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(relay + "/api/events").openConnection();
        conn = c;
        c.setConnectTimeout(15000);
        // The relay pings every 25 s; silence longer than this means the connection is dead.
        c.setReadTimeout(70000);
        c.setRequestProperty("Authorization", "Bearer " + cfg.getString("token"));
        c.setRequestProperty("X-RA-Proof", EntryAuth.proof(cfg, "POST", "/api/events"));
        c.setRequestProperty("Accept", "text/event-stream");
        // Quick tunnels buffer GET event streams until they close; POST is streamed.
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setFixedLengthStreamingMode(0);
        try {
            c.getOutputStream().close();
            int code = c.getResponseCode();
            Log.i(TAG, "HTTP " + code);
            if (code == 401) throw new Unauthorized();
            if (code != 200) throw new Exception("HTTP " + code);
            setStatus("connected");
            lastError = "";
            backoff = 2000;
            Log.i(TAG, "stream open");
            lastData = android.os.SystemClock.elapsedRealtime();
            // Events posted while this stream was down are lost; drop every stale "working"
            // stopwatch — the relay replays the ones that are really still running.
            if (Build.VERSION.SDK_INT >= 23) {
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                int cleared = 0;
                for (StatusBarNotification n : nm.getActiveNotifications()) {
                    if (n.getNotification().extras.getBoolean("ra.working", false)) { nm.cancel(n.getId()); cleared++; }
                }
                Log.i(TAG, "cleared " + cleared + " stale working notifications");
            }
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            for (String line; running && (line = r.readLine()) != null; ) {
                lastData = android.os.SystemClock.elapsedRealtime();
                if (line.startsWith("data:")) {
                    JSONObject e = new JSONObject(line.substring(5).trim());
                    String k = e.optString("win", "") + "|" + e.optString("windowId", "") + "|" + e.optString("threadId", "");
                    int id = k.replace("|", "").isEmpty() ? 2 : 3 + (k.hashCode() & 0x7fffffff) % 100000;
                    Log.i(TAG, "data kind=" + e.optString("kind") + " id=" + id + (e.has("startedAt") ? " startedAt=" + e.optLong("startedAt") : ""));
                    show(e);
                }
            }
            if (running) Log.i(TAG, "stream ended by server");
        } catch (java.net.SocketTimeoutException e) {
            Log.i(TAG, "read timeout");
            throw e;
        } finally {
            c.disconnect();
            conn = null;
        }
    }

    private static int notificationId(String win) {
        // One notification per window: a newer event replaces the older one.
        return win.isEmpty() ? 2 : 3 + (win.hashCode() & 0x7fffffff) % 100000;
    }

    private void show(JSONObject e) {
        String win = e.optString("win", "");
        String windowId = e.optString("windowId", "");
        String threadId = e.optString("threadId", "");
        // One notification per thread, so a second session does not replace the first.
        String key = win + "|" + windowId + "|" + threadId;
        long seq = e.optLong("seq", 0);
        if (seq > 0) {
            long previous = latestSeq.containsKey(key) ? latestSeq.get(key) : 0;
            if (seq <= previous) return;
            latestSeq.put(key, seq);
        }
        int id = key.replace("|", "").isEmpty() ? 2 : 3 + (key.hashCode() & 0x7fffffff) % 100000;
        String kind = e.optString("kind");
        if ("end".equals(kind)) { Log.i(TAG, "cancel id=" + id); ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).cancel(id); return; }
        if ("working".equals(kind)) { Log.i(TAG, "notify working id=" + id + " when=" + e.optLong("startedAt")); showWorking(e, id, win, windowId, threadId); return; }
        if ("tasks".equals(kind)) { showTasks(e, win, windowId, threadId); return; }
        Notification.Builder b = builder(CH_EVENTS)
                .setContentTitle(e.optString("title", "Remote Agent"))
                .setContentText(e.optString("body", ""))
                .setStyle(new Notification.BigTextStyle().bigText(e.optString("body", "")))
                .setContentIntent(openApp(win, windowId, threadId, id))
                .setAutoCancel(true);
        // Android shows three action buttons; Reply (with its text field) always gets one of them.
        boolean reply = e.optBoolean("reply");
        JSONArray acts = e.optJSONArray("actions");
        int room = reply ? 2 : 3;
        for (int i = 0; acts != null && i < acts.length() && i < room; i++) {
            JSONObject a = acts.optJSONObject(i);
            if (a == null) continue;
            String aid = a.optString("id");
            String label = a.optString("label", "");
            if (label.isEmpty()) label = "acceptAll".equals(aid) ? tr("全部接受", "Accept all") : aid;
            b.addAction(new Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_notify), label, actionIntent(win, windowId, threadId, e.optString("question"), aid, id, false)).build());
        }
        if (reply && !win.isEmpty()) {
            RemoteInput ri = new RemoteInput.Builder("text").setLabel(tr("回复 Agent…", "Reply to the Agent…")).build();
            b.addAction(new Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_notify), tr("回复", "Reply"), actionIntent(win, windowId, threadId, e.optString("question"), "reply", id, true))
                    .addRemoteInput(ri).build());
        }
        Log.i(TAG, "notify event id=" + id);
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(id, b.build());
    }

    // Android 16 shows the ongoing notification as a live status chip when it is promoted; older versions get a spinner.
    private void showWorking(JSONObject e, int id, String win, String windowId, String threadId) {
        Notification.Builder b = builder(CH_WORK)
                .setContentTitle(e.optString("title", "Remote Agent"))
                .setContentText(e.optString("body", ""))
                .setContentIntent(openApp(win, windowId, threadId, id))
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_PROGRESS)
                .setWhen(e.optLong("startedAt", System.currentTimeMillis()))
                .setShowWhen(true)
                .setUsesChronometer(true);
        b.getExtras().putBoolean("ra.working", true);
        if (Build.VERSION.SDK_INT >= 26) b.setOnlyAlertOnce(true).setTimeoutAfter(30 * 60 * 1000L);
        if (Build.VERSION.SDK_INT >= 36 && !e.optBoolean("quiet")) {
            b.getExtras().putBoolean("android.requestPromotedOngoing", true);
            try {
                Notification.Style style = (Notification.Style) Class.forName("android.app.Notification$ProgressStyle").getConstructor().newInstance();
                style.getClass().getMethod("setProgressIndeterminate", boolean.class).invoke(style, true);
                b.setStyle(style);
            } catch (Exception ex) {
                b.setProgress(0, 0, true);
            }
        } else {
            b.setProgress(0, 0, true);
        }
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(id, b.build());
    }

    // Devin's todo list as a progress chip; its own id, so the run's end and alerts leave it alone.
    private void showTasks(JSONObject e, String win, String windowId, String threadId) {
        String key = win + "|" + windowId + "|" + threadId;
        int tid = 3 + ((key + "|tasks").hashCode() & 0x7fffffff) % 100000;
        int done = e.optInt("done"), total = e.optInt("total");
        boolean complete = total > 0 && done >= total;
        boolean finished = complete || e.optBoolean("stopped");
        Notification.Builder b = builder(CH_WORK)
                .setContentTitle(e.optString("title", "Remote Agent"))
                .setContentText(e.optString("body", ""))
                .setContentIntent(openApp(win, windowId, threadId, tid))
                .setCategory(Notification.CATEGORY_PROGRESS)
                .setOngoing(!finished)
                .setAutoCancel(finished);
        if (Build.VERSION.SDK_INT >= 26) b.setOnlyAlertOnce(true).setTimeoutAfter(finished ? 60 * 60 * 1000L : 12 * 60 * 60 * 1000L);
        if (complete) {
            b.setProgress(0, 0, false);
        } else if (finished || Build.VERSION.SDK_INT < 36) {
            b.setProgress(total, done, false);
        } else {
            b.getExtras().putBoolean("android.requestPromotedOngoing", true);
            try {
                Notification.Style style = (Notification.Style) Class.forName("android.app.Notification$ProgressStyle").getConstructor().newInstance();
                Class<?> seg = Class.forName("android.app.Notification$ProgressStyle$Segment");
                style.getClass().getMethod("setProgressIndeterminate", boolean.class).invoke(style, false);
                style.getClass().getMethod("addProgressSegment", seg).invoke(style, seg.getConstructor(int.class).newInstance(total));
                style.getClass().getMethod("setProgress", int.class).invoke(style, done);
                b.setStyle(style);
            } catch (Exception ex) {
                b.setProgress(total, done, false);
            }
            try {
                Notification.Builder.class.getMethod("setShortCriticalText", String.class).invoke(b, done + "/" + total);
            } catch (Exception ignored) {}
        }
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(tid, b.build());
    }

    private PendingIntent actionIntent(String win, String windowId, String threadId, String question, String act, int notifId, boolean mutable) {
        Intent i = new Intent(this, ActionReceiver.class).setAction("com.agentremote.ACT." + notifId + "." + act)
                .putExtra("win", win).putExtra("windowId", windowId).putExtra("threadId", threadId).putExtra("question", question).putExtra("act", act).putExtra("nid", notifId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (mutable ? (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0) : PendingIntent.FLAG_IMMUTABLE);
        return PendingIntent.getBroadcast(this, (notifId * 31 + act.hashCode()) & 0x7fffffff, i, flags);
    }

    // Runs on a worker thread from ActionReceiver: sends the chosen action to the relay and updates the notification.
    static void handleAction(Context c, Intent intent) {
        String win = intent.getStringExtra("win");
        String act = intent.getStringExtra("act");
        int nid = intent.getIntExtra("nid", 2);
        String text = null;
        Bundle in = RemoteInput.getResultsFromIntent(intent);
        if (in != null && in.getCharSequence("text") != null) text = in.getCharSequence("text").toString();
        try {
            JSONObject body = new JSONObject().put("win", win).put("windowId", intent.getStringExtra("windowId")).put("threadId", intent.getStringExtra("threadId")).put("question", intent.getStringExtra("question"));
            if (act != null && act.startsWith("opt:")) body.put("act", "opt").put("index", Integer.parseInt(act.substring(4)));
            else if ("reply".equals(act)) body.put("act", "reply").put("text", text == null ? "" : text);
            else body.put("act", act);
            JSONObject cfg = new JSONObject(prefs(c).getString(PREF, "{}"));
            String relay = resolveRelay(cfg.getString("app"), cfg.optString("key"));
            HttpURLConnection h = (HttpURLConnection) new URL(relay + "/api/act").openConnection();
            h.setConnectTimeout(15000);
            h.setReadTimeout(60000);
            h.setRequestMethod("POST");
            h.setDoOutput(true);
            h.setRequestProperty("Authorization", "Bearer " + cfg.getString("token"));
            h.setRequestProperty("X-RA-Proof", EntryAuth.proof(cfg, "POST", "/api/act"));
            h.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = h.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            int code = h.getResponseCode();
            String msg = "";
            if (code != 200) {
                try (InputStream err = h.getErrorStream()) { if (err != null) msg = new JSONObject(new String(readAll(err), StandardCharsets.UTF_8)).optString("error"); } catch (Exception ignored) {}
            }
            h.disconnect();
            if (code == 200) result(c, nid, true, "reply".equals(act) ? text : null);
            else result(c, nid, false, msg.isEmpty() ? "HTTP " + code : msg);
        } catch (Exception ex) {
            result(c, nid, false, String.valueOf(ex.getMessage()));
        }
    }

    // Replaces the notification (this also ends the "sending" spinner a reply leaves behind) and lets it go away.
    private static void result(Context c, int id, boolean ok, String detail) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CH_EVENTS) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(ok ? tr("已发送给 Agent", "Sent to the Agent") : tr("没发出去", "Couldn't send"))
                .setAutoCancel(true);
        if (detail != null && !detail.isEmpty()) b.setContentText(detail);
        if (Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(ok ? 4000 : 15000);
        ((NotificationManager) c.getSystemService(NOTIFICATION_SERVICE)).notify(id, b.build());
    }

    private PendingIntent openApp(String win, int requestCode) {
        return openApp(win, "", "", requestCode);
    }

    private PendingIntent openApp(String win, String windowId, String threadId, int requestCode) {
        Intent i = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (win != null && !win.isEmpty()) i.putExtra("win", win);
        if (windowId != null && !windowId.isEmpty()) i.putExtra("windowId", windowId);
        if (threadId != null && !threadId.isEmpty()) i.putExtra("threadId", threadId);
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
        NotificationChannel work = new NotificationChannel(CH_WORK, tr("Agent 进行中", "Agent running"), NotificationManager.IMPORTANCE_LOW);
        work.setShowBadge(false);
        nm.createNotificationChannel(work);
    }

    private static class Unauthorized extends Exception {}
}
