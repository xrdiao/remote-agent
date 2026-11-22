package com.agentremote;

import android.app.Activity;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Display;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

public final class PhoneProjectionService extends Service {
    private static final String START = "com.agentremote.PHONE_START", STOP = "com.agentremote.PHONE_STOP";
    private static final String CHANNEL = "phone-control";
    private static final int NOTIFICATION = 7302, MAX_FRAME = 512 * 1024;
    private static final MediaType JSON = MediaType.get("application/json");
    private static PhoneProjectionService sharing;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final OkHttpClient http = new OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(12, TimeUnit.SECONDS).pingInterval(12, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build();
    private final IBinder binder = new LocalBinder();
    private JSONObject config;
    private URI relay;
    private Call ticketRequest;
    private WebSocket control;
    private volatile WebSocket media;
    private String requested, controllerName, status = "将手机设为可被控后，从电脑浏览器发起连接。";
    private Runnable onChange;
    private boolean sharingAccepted, treeQueued, receiverRegistered, agent;
    private volatile boolean live;
    private volatile boolean framesReady;
    private int treeRevision, screenRevision;
    private volatile Geometry geometry;
    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private DisplayManager displays;
    private HandlerThread captureThread;
    private Handler capture;
    private ImageReader imageReader;
    private long lastFrameAt;

    final class LocalBinder extends Binder { PhoneProjectionService service() { return PhoneProjectionService.this; } }
    private record Geometry(int revision, int width, int height, int imageWidth, int imageHeight, int rotation) {}

    @Override public IBinder onBind(Intent intent) { return binder; }
    String status() { return status; }
    String request() { return requested; }
    boolean connected() { return ticketRequest != null || control != null; }
    boolean accepted() { return sharingAccepted; }
    void onChange(Runnable listener) { onChange = listener; }
    void change(String value) { status = value; if (onChange != null) onChange.run(); }

    void waitForController(String payload) {
        if (connected()) return;
        if (PhoneAccessibilityService.current() == null) { change("请先在系统设置中启用 Remote Agent 无障碍操作。"); return; }
        try {
            config = new JSONObject(payload);
            relay = URI.create(config.getString("relay"));
            if (!"https".equalsIgnoreCase(relay.getScheme()) || relay.getHost() == null || relay.getUserInfo() != null ||
                    relay.getQuery() != null || relay.getFragment() != null ||
                    !(relay.getPath().isEmpty() || "/".equals(relay.getPath()))) throw new IOException("需要 HTTPS 中继地址");
            String path = "/api/phone";
            byte[] body = packet("role", "host").getBytes(StandardCharsets.UTF_8);
            Request request = new Request.Builder().url(relay.resolve(path).toString())
                    .header("Authorization", "Bearer " + config.getString("token"))
                    .header("x-ra-proof", EntryAuth.proof(config, "POST", path, body))
                    .post(RequestBody.create(body, JSON)).build();
            change("正在连接中继…");
            ticketRequest = http.newCall(request);
            Call waiting = ticketRequest;
            waiting.enqueue(new Callback() {
                @Override public void onFailure(Call call, IOException error) {
                    main.post(() -> { if (ticketRequest == waiting) finish("无法连接中继。"); });
                }
                @Override public void onResponse(Call call, Response response) {
                    try (response) {
                        JSONObject result = new JSONObject(response.body().string());
                        if (!response.isSuccessful()) throw new IOException(result.optString("error", "此中继尚未支持手机远控。"));
                        String ticket = result.getString("ticket");
                        main.post(() -> {
                            if (ticketRequest != waiting) return;
                            ticketRequest = null;
                            control = openSocket(ticket, false);
                        });
                    } catch (Exception error) {
                        main.post(() -> { if (ticketRequest == waiting) finish("中继拒绝注册手机。请核对版本和配对。"); });
                    }
                }
            });
        } catch (Exception error) { finish("无法使用当前配对连接手机远控。"); }
    }

    private WebSocket openSocket(String ticket, boolean video) {
        String destination = "wss://" + relay.getRawAuthority() + "/phone";
        Request request = new Request.Builder().url(destination).build();
        return http.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket socket, Response response) {
                socket.send(video ? packet("type", "hello", "ticket", ticket)
                        : packet("type", "hello", "ticket", ticket, "agentVersion", 1));
            }
            @Override public void onMessage(WebSocket socket, String text) {
                if (!video) main.post(() -> {
                    if (control != socket) return;
                    try { receive(new JSONObject(text)); }
                    catch (JSONException error) { finish("中继返回了无效的远控消息。"); }
                });
            }
            @Override public void onClosing(WebSocket socket, int code, String reason) { socket.close(1000, null); }
            @Override public void onClosed(WebSocket socket, int code, String reason) { disconnected(socket, video); }
            @Override public void onFailure(WebSocket socket, Throwable error, Response response) { disconnected(socket, video); }
        });
    }

    private void disconnected(WebSocket socket, boolean video) {
        main.post(() -> {
            if (socket == (video ? media : control)) finish("连接已断开，手机远控已停止。");
        });
    }

    private void receive(JSONObject message) throws JSONException {
        switch (message.getString("type")) {
            case "online" -> change("等待电脑浏览器请求控制。");
            case "request" -> {
                requested = message.getString("id");
                controllerName = message.getString("name");
                change(controllerName + " 请求控制手机。");
            }
            case "started" -> {
                if (!sharingAccepted || projection == null) { finish("屏幕共享尚未授权。"); return; }
                media = openSocket(message.getString("ticket"), true);
                agent = message.optBoolean("agent");
                live = true;
                sendGeometry();
                publishTree();
                change(controllerName + " 正在控制手机。");
            }
            case "framesReady" -> {
                framesReady = true;
                ImageReader reader = imageReader;
                Geometry current = geometry;
                capture.post(() -> frame(reader, current));
            }
            case "action" -> handleAction(message);
            case "ended" -> {
                if (sharingAccepted) finish("远控已结束。");
                else {
                    requested = null;
                    controllerName = null;
                    change("等待电脑浏览器请求控制。");
                }
            }
        }
    }

    void reject(String id) {
        if (id == null || !id.equals(requested) || sharingAccepted) return;
        send(packet("type", "reject", "id", id));
    }

    void confirm(String id, Intent permission) {
        if (permission == null || id == null || !id.equals(requested) || sharingAccepted) return;
        Intent intent = new Intent(this, PhoneProjectionService.class).setAction(START)
                .putExtra("request", id).putExtra("projection", permission);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
        else startService(intent);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) { finish("远控已停止。"); return START_NOT_STICKY; }
        String id = intent.getStringExtra("request");
        Intent permission = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra("projection", Intent.class)
                : intent.getParcelableExtra("projection");
        if (!START.equals(intent.getAction()) || id == null || !id.equals(requested) || sharingAccepted ||
                permission == null || locked() || PhoneAccessibilityService.current() == null) {
            if (!sharingAccepted) finish("屏幕共享权限已失效，请重新发起。");
            return START_NOT_STICKY;
        }
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            else startForeground(NOTIFICATION, notification());
            MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
            projection = manager.getMediaProjection(Activity.RESULT_OK, permission);
            if (projection == null) throw new IllegalStateException("projection missing");
            MediaProjection current = projection;
            projection.registerCallback(new MediaProjection.Callback() {
                @Override public void onStop() { if (projection == current) finish("系统已停止共享屏幕。"); }
            }, main);
            captureThread = new HandlerThread("Remote Agent phone frames");
            captureThread.start();
            capture = new Handler(captureThread.getLooper());
            displays = getSystemService(DisplayManager.class);
            displays.registerDisplayListener(displayChanges, main);
            IntentFilter screenOff = new IntentFilter(Intent.ACTION_SCREEN_OFF);
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenLock, screenOff, Context.RECEIVER_NOT_EXPORTED);
            else registerReceiver(screenLock, screenOff);
            receiverRegistered = true;
            resize();
            sharingAccepted = true;
            sharing = this;
            main.post(screenCheck);
            send(packet("type", "accept", "id", id));
            change("屏幕共享已授权，正在连接电脑。");
        } catch (RuntimeException error) { finish("无法启动 Android 屏幕共享。"); }
        return START_NOT_STICKY;
    }

    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(CHANNEL, "手机远控", NotificationManager.IMPORTANCE_LOW));
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, PhoneProjectionService.class).setAction(STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return builder.setSmallIcon(R.drawable.ic_notify).setContentTitle("Remote Agent 正在共享屏幕")
                .setContentText(controllerName + " 正在连接此手机").setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "停止远控", stop).build()).build();
    }

    private final DisplayManager.DisplayListener displayChanges = new DisplayManager.DisplayListener() {
        @Override public void onDisplayAdded(int id) {}
        @Override public void onDisplayRemoved(int id) {}
        @Override public void onDisplayChanged(int id) {
            if (id != Display.DEFAULT_DISPLAY || projection == null) return;
            try { resize(); } catch (RuntimeException error) { finish("无法更新屏幕尺寸。"); }
        }
    };
    private final BroadcastReceiver screenLock = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { finish("手机已锁屏，远控停止。"); }
    };

    private final Runnable screenCheck = new Runnable() {
        @Override public void run() {
            if (!sharingAccepted) return;
            if (locked()) finish("手机已锁屏，远控停止。");
            else main.postDelayed(this, 500);
        }
    };

    private void resize() {
        Display display = displays.getDisplay(Display.DEFAULT_DISPLAY);
        DisplayMetrics metrics = new DisplayMetrics();
        display.getRealMetrics(metrics);
        int w = metrics.widthPixels, h = metrics.heightPixels, rotation = display.getRotation();
        Geometry old = geometry;
        if (old != null && old.width == w && old.height == h && old.rotation == rotation) return;
        float scale = Math.min(1f, 960f / Math.max(w, h));
        Geometry next = new Geometry(++screenRevision, w, h, Math.round(w * scale), Math.round(h * scale), rotation);
        ImageReader previous = imageReader;
        imageReader = ImageReader.newInstance(next.imageWidth, next.imageHeight, PixelFormat.RGBA_8888, 2);
        imageReader.setOnImageAvailableListener(reader -> frame(reader, next), capture);
        geometry = next;
        if (virtualDisplay == null) {
            virtualDisplay = projection.createVirtualDisplay("Remote Agent", next.imageWidth, next.imageHeight, metrics.densityDpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, imageReader.getSurface(), null, capture);
        } else {
            virtualDisplay.resize(next.imageWidth, next.imageHeight, metrics.densityDpi);
            virtualDisplay.setSurface(imageReader.getSurface());
        }
        if (previous != null) capture.post(previous::close);
        if (live) sendGeometry();
    }

    private void sendGeometry() {
        Geometry current = geometry;
        if (current != null) send(packet("type", "screen", "revision", current.revision, "width", current.width, "height", current.height));
    }

    private void frame(ImageReader reader, Geometry captured) {
        if (!framesReady) return;
        try (Image image = reader.acquireLatestImage()) {
            WebSocket socket = media;
            long now = SystemClock.elapsedRealtime();
            if (image == null || !live || captured != geometry || socket == null || socket.queueSize() > 0 || now - lastFrameAt < 100) return;
            lastFrameAt = now;
            Image.Plane plane = image.getPlanes()[0];
            int width = image.getWidth(), height = image.getHeight();
            int paddedWidth = plane.getRowStride() / plane.getPixelStride();
            Bitmap padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888);
            Bitmap cropped = padded;
            try {
                padded.copyPixelsFromBuffer(plane.getBuffer());
                if (paddedWidth != width) cropped = Bitmap.createBitmap(padded, 0, 0, width, height);
                ByteArrayOutputStream encoded = new ByteArrayOutputStream();
                cropped.compress(Bitmap.CompressFormat.JPEG, 62, encoded);
                if (!live || captured != geometry || socket != media || encoded.size() > MAX_FRAME - 4 || locked()) return;
                byte[] bytes = ByteBuffer.allocate(encoded.size() + 4).putInt(captured.revision).put(encoded.toByteArray()).array();
                socket.send(ByteString.of(bytes));
            } finally {
                if (cropped != padded) cropped.recycle();
                padded.recycle();
            }
        } catch (IllegalStateException ignored) {
            // ImageReader can be closed while releasing a display or switching its size.
        }
    }

    static void accessibilityChanged() {
        PhoneProjectionService service = sharing;
        if (service == null) return;
        if (PhoneAccessibilityService.current() == null) service.finish("无障碍服务已关闭，远控停止。");
        else service.scheduleTree();
    }

    private void scheduleTree() {
        if (!live || treeQueued) return;
        treeQueued = true;
        main.postDelayed(() -> { treeQueued = false; publishTree(); }, 120);
    }

    private void publishTree() {
        PhoneAccessibilityService access = PhoneAccessibilityService.current();
        if (!live || access == null) return;
        if (locked()) { finish("手机已锁屏，远控停止。"); return; }
        try {
            JSONObject tree = access.snapshot(treeRevision + 1, agent);
            if (tree != null) { treeRevision++; send(tree.toString()); }
        }
        catch (JSONException error) { finish("无法读取当前 Android 控件。"); }
    }

    private boolean locked() {
        return !getSystemService(PowerManager.class).isInteractive() || getSystemService(KeyguardManager.class).isKeyguardLocked();
    }
    private void handleAction(JSONObject message) throws JSONException {
        if (!live) return;
        int id = message.getInt("id");
        if (locked()) { ack(id, false, "locked"); finish("手机已锁屏，远控停止。"); return; }
        PhoneAccessibilityService access = PhoneAccessibilityService.current();
        if (access == null) { finish("无障碍服务已关闭，远控停止。"); return; }
        switch (message.getString("kind")) {
            case "inspect" -> { publishTree(); ack(id, true, ""); }
            case "apps" -> {
                if (agent) send(packet("type", "ack", "id", id, "ok", true, "apps", access.apps()));
                else ack(id, false, "unsupported");
            }
            case "launch" -> ack(id, agent && access.launch(message.getString("app")), "unsupported");
            case "system" -> ack(id, access.systemAction(message.getString("action")), "unsupported");
            case "node" -> ack(id, access.nodeAction(message.getInt("revision"), message.getInt("node"),
                    message.getString("action"), message.optString("text")), "stale");
            case "gesture" -> {
                Geometry bounds = geometry;
                if (bounds == null || bounds.revision != message.getInt("revision") ||
                        displays.getDisplay(Display.DEFAULT_DISPLAY).getRotation() != bounds.rotation) { ack(id, false, "stale"); return; }
                if (agent && message.has("window") && !access.isActiveWindow(message.getInt("window"), message.getString("app"))) {
                    ack(id, false, "stale"); return;
                }
                access.gesture(coordinate(message, "x", bounds.width), coordinate(message, "y", bounds.height),
                        coordinate(message, "endX", bounds.width), coordinate(message, "endY", bounds.height),
                        message.getInt("duration"), ok -> { if (live) ack(id, ok, "unsupported"); });
            }
        }
    }

    private static float coordinate(JSONObject message, String name, int pixels) throws JSONException {
        return (float) (message.getDouble(name) * (pixels - 1));
    }
    private void ack(int id, boolean ok, String reason) {
        send(packet("type", "ack", "id", id, "ok", ok, "reason", reason));
        scheduleTree();
    }
    private void send(String message) { if (control != null) control.send(message); }
    private static String packet(Object... fields) {
        JSONObject result = new JSONObject();
        try { for (int i = 0; i < fields.length; i += 2) result.put((String) fields[i], fields[i + 1]); }
        catch (JSONException error) { throw new IllegalArgumentException(error); }
        return result.toString();
    }

    void finish(String message) {
        live = false;
        agent = false;
        framesReady = false;
        main.removeCallbacks(screenCheck);
        if (sharing == this) sharing = null;
        PhoneAccessibilityService access = PhoneAccessibilityService.current();
        if (access != null) access.invalidate();
        if (ticketRequest != null) { ticketRequest.cancel(); ticketRequest = null; }
        if (control != null) {
            control.send(packet("type", "stop"));
            control.close(1000, null);
            control = null;
        }
        if (media != null) { media.close(1000, null); media = null; }
        if (receiverRegistered) { unregisterReceiver(screenLock); receiverRegistered = false; }
        if (displays != null) { displays.unregisterDisplayListener(displayChanges); displays = null; }
        if (virtualDisplay != null) { virtualDisplay.release(); virtualDisplay = null; }
        if (imageReader != null) { capture.post(imageReader::close); imageReader = null; }
        if (captureThread != null) { captureThread.quitSafely(); captureThread = null; }
        if (projection != null) { MediaProjection previous = projection; projection = null; previous.stop(); }
        geometry = null;
        requested = null;
        controllerName = null;
        sharingAccepted = false;
        config = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        change(message);
    }

    @Override public void onDestroy() {
        onChange = null;
        finish("远控已停止。");
        super.onDestroy();
    }
}
