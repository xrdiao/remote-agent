package com.agentremote;

import android.app.Activity;
import android.app.DownloadManager;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;
import android.speech.RecognizerIntent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebViewRenderProcess;

import androidx.core.content.ContextCompat;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;
import com.google.zxing.client.android.Intents;

import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;

// A thin WebView shell around the user's GitHub Pages app, so it installs without Google Play services or PWA support.
public class MainActivity extends Activity {
    private static final String SETUP = "file:///android_asset/setup.html";
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private static final String UPDATE_FILE = "AgentRemote-update.apk";
    private static final int VOICE = 7;
    private static final int PICK = 8;
    private FrameLayout root;
    private WebView web;
    private WebView dying;
    private RefreshBubble bubble;
    private ValueCallback<Uri[]> pickFile;
    private SharedPreferences prefs;
    private HistoryDb hist;

    private final BroadcastReceiver downloaded = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            long id = i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (id != -1 && id == prefs.getLong("updateId", -2)) installUpdate(id);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("agent-remote", MODE_PRIVATE);
        root = new FrameLayout(this);
        web = createWeb();
        root.addView(web);
        bubble = new RefreshBubble(this, root, this::restartWeb);
        setContentView(root);
        applyTheme(prefs.getBoolean("light", false));

        IntentFilter done = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        // The broadcast comes from the system download provider, a separate app.
        ContextCompat.registerReceiver(this, downloaded, done, ContextCompat.RECEIVER_EXPORTED);

        if (!openPairLink(getIntent())) {
            saveOpen(getIntent());
            if (state != null) web.restoreState(state);
            else load();
        }
        NotifyService.start(this);
    }

    private WebView createWeb() {
        WebView w = new WebView(this);
        w.setBackgroundColor(prefs.getBoolean("light", false) ? 0xFFFFFFFF : 0xFF1E1E1E);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUserAgentString(s.getUserAgentString() + " AgentRemoteApp/" + BuildConfigVersion.name(this));

        w.addJavascriptInterface(new Bridge(), "AgentRemoteApp");
        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pickFile != null) pickFile.onReceiveValue(null);
                pickFile = callback;
                try {
                    startActivityForResult(params.createIntent(), PICK);
                } catch (Exception e) {
                    pickFile = null;
                    return false;
                }
                return true;
            }
        });
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("file".equals(u.getScheme()) || sameOrigin(u, appUrl())) return false;
                // Donate links etc. open in the system browser; the bridge is only exposed to the app's own pages.
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) view.loadUrl(SETUP + "?offline=1");
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The WebView being replaced has its renderer killed on purpose; only the current one needs a restart.
                if (view == web && view != dying) view.post(() -> { if (view == web) restartWeb(); });
                return true;
            }
        });
        return w;
    }

    // Replaces the WebView even if its renderer is hung. Loads the saved address rather than reloading, since the
    // current URL may carry a one-time #pair fragment that was already used.
    private void restartWeb() {
        WebView old = web;
        dying = old;
        if (Build.VERSION.SDK_INT >= 29) {
            WebViewRenderProcess p = old.getWebViewRenderProcess();
            if (p != null) p.terminate();
        }
        root.removeView(old);
        old.destroy();
        if (pickFile != null) {
            pickFile.onReceiveValue(null);
            pickFile = null;
        }
        web = createWeb();
        root.addView(web, 0);
        applyTheme(prefs.getBoolean("light", false));
        load();
    }

    // WebView's onPause/onResume flip document.visibilityState, which tells the relay whether to notify.
    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        unregisterReceiver(downloaded);
        super.onDestroy();
    }

    // Keeps the WebView background and system-bar icon contrast in sync with the web app's theme.
    private void applyTheme(boolean light) {
        web.setBackgroundColor(light ? 0xFFFFFFFF : 0xFF1E1E1E);
        bubble.setLight(light);
        if (Build.VERSION.SDK_INT >= 23) {
            View d = getWindow().getDecorView();
            int flags = d.getSystemUiVisibility();
            flags = light ? flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR : flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26)
                flags = light ? flags | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : flags & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            d.setSystemUiVisibility(flags);
        }
    }

    private void downloadUpdate(String url) {
        DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
        long previous = prefs.getLong("updateId", -1);
        if (previous != -1) dm.remove(previous);
        File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir != null) new File(dir, UPDATE_FILE).delete();
        DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url))
                .setTitle(NotifyService.tr("Remote Agent 更新", "Remote Agent update"))
                .setMimeType(APK_MIME)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, UPDATE_FILE);
        prefs.edit().putLong("updateId", dm.enqueue(r)).apply();
        Toast.makeText(this, NotifyService.tr("正在下载新版本，下载完会弹出安装界面", "Downloading the update; the installer opens when done"), Toast.LENGTH_LONG).show();
    }

    private void installUpdate(long id) {
        Uri apk = ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).getUriForDownloadedFile(id);
        if (apk == null) {
            Toast.makeText(this, NotifyService.tr("下载失败，请稍后在菜单里重试", "Download failed; retry from the menu later"), Toast.LENGTH_LONG).show();
            return;
        }
        Intent install = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(apk, APK_MIME)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(install);
        } catch (Exception e) {
            Toast.makeText(this, NotifyService.tr("无法打开安装界面，请到浏览器下载安装", "Cannot open the installer; download it in a browser"), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (openPairLink(intent)) return;
        String win = intent.getStringExtra("win");
        if (win != null) {
            saveOpen(intent);
            web.evaluateJavascript("window.openWin && openWin(" + JSONObject.quote(prefs.getString("openWin", "")) + ")", null);
        }
    }

    private void saveOpen(Intent intent) {
        String win = intent.getStringExtra("win");
        if (win == null || win.isEmpty()) return;
        try {
            JSONObject o = new JSONObject();
            o.put("win", win);
            o.put("windowId", intent.getStringExtra("windowId") == null ? "" : intent.getStringExtra("windowId"));
            o.put("threadId", intent.getStringExtra("threadId") == null ? "" : intent.getStringExtra("threadId"));
            prefs.edit().putString("openWin", o.toString()).apply();
        } catch (Exception ignored) {}
    }

    private void enableNotify(String config) {
        String old = prefs.getString(NotifyService.PREF, null);
        prefs.edit().putString(NotifyService.PREF, config).apply();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        // Without this, stock Android may stop the listener after the phone has been idle for a while.
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (!pm.isIgnoringBatteryOptimizations(getPackageName()) && !prefs.getBoolean("askedBattery", false)) {
            prefs.edit().putBoolean("askedBattery", true).apply();
            try {
                startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
            } catch (Exception ignored) {}
        }
        if (old != null && !old.equals(config)) NotifyService.nudge(this);
        else NotifyService.start(this);
    }

    private void disableNotify() {
        prefs.edit().remove(NotifyService.PREF).apply();
        stopService(new Intent(this, NotifyService.class));
    }

    // agentremote://pair?app=<https app address>&d=<url key>.<one-time code>, handed over by the web app in a browser.
    private boolean openPairLink(Intent intent) {
        return openPairLink(intent == null ? null : intent.getData());
    }

    private boolean openPairLink(Uri u) {
        if (u == null || !"agentremote".equals(u.getScheme())) return false;
        String app = u.getQueryParameter("app");
        String d = u.getQueryParameter("d");
        if (app == null || d == null || !app.startsWith("https://") || !d.matches("[\\w-]+\\.[\\w-]+")) return false;
        prefs.edit().putString("url", app).apply();
        web.loadUrl(app + "#pair=" + d);
        return true;
    }

    private String appUrl() {
        String saved = prefs.getString("url", null);
        return saved != null ? saved : getString(R.string.default_url);
    }

    private void load() {
        String url = appUrl();
        web.loadUrl(url.isEmpty() ? SETUP : url);
    }

    private static boolean sameOrigin(Uri u, String base) {
        if (base == null || base.isEmpty()) return false;
        Uri b = Uri.parse(base);
        return u.getScheme() != null && u.getScheme().equals(b.getScheme()) && u.getHost() != null && u.getHost().equals(b.getHost());
    }

    private static Intent voiceIntent(String lang) {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        if (lang != null && !lang.isEmpty()) i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        return i;
    }

    private void voiceResult(String text) {
        web.evaluateJavascript("window.onVoice && onVoice(" + JSONObject.quote(text) + ")", null);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        IntentResult scan = IntentIntegrator.parseActivityResult(request, result, data);
        if (scan != null) {
            String s = scan.getContents();
            if (s == null) return;
            if (s.startsWith("agentremote://")) openPairLink(Uri.parse(s));
            else if (s.startsWith("https://")) new Bridge().setUrl(s);
            else Toast.makeText(this, NotifyService.tr("这不是 Remote Agent 的配对二维码", "Not a Remote Agent pairing QR code"), Toast.LENGTH_LONG).show();
            return;
        }
        if (request == PICK) {
            if (pickFile != null) pickFile.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            pickFile = null;
            return;
        }
        if (request != VOICE) return;
        ArrayList<String> heard = result == RESULT_OK && data != null ? data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS) : null;
        voiceResult(heard == null || heard.isEmpty() ? "" : heard.get(0));
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private synchronized HistoryDb hist() {
        if (hist == null) hist = new HistoryDb(getApplicationContext());
        return hist;
    }

    private class Bridge {
        // ---- the phone's own copy of every session (app-private SQLite, not WebView storage) ----
        @JavascriptInterface
        public String histGet(String k) { return hist().get(k); }

        @JavascriptInterface
        public String histMeta(String k) { return hist().meta(k); }

        @JavascriptInterface
        public boolean histPut(String k, String data, String meta, String msgs) { return hist().put(k, data, meta, msgs); }

        @JavascriptInterface
        public void histDel(String k) { hist().delete(k); }

        @JavascriptInterface
        public String histKeys() { return hist().keys(); }

        @JavascriptInterface
        public String histSearch(String q) { return hist().search(q, 50); }

        // ---- the background connection ----
        // "off", "connecting", "connected" or "retry".
        @JavascriptInterface
        public String listenStatus() {
            return NotifyService.enabled(MainActivity.this) ? NotifyService.status : "off";
        }

        @JavascriptInterface
        public boolean batteryOk() {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            return pm.isIgnoringBatteryOptimizations(getPackageName());
        }

        @JavascriptInterface
        public void askBattery() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
                } catch (Exception e) {
                    try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); } catch (Exception ignored) {}
                }
            });
        }

        @JavascriptInterface
        public void reconnectListen() { NotifyService.nudge(MainActivity.this); }

        @JavascriptInterface
        public String listenError() { return NotifyService.lastError; }

        @JavascriptInterface
        public boolean notifyAllowed() {
            return ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).areNotificationsEnabled();
        }

        @JavascriptInterface
        public void openNotifySettings() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
                } catch (Exception e) {
                    try { startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); } catch (Exception ignored) {}
                }
            });
        }

        @JavascriptInterface
        public String getUrl() {
            return appUrl();
        }

        @JavascriptInterface
        public void setUrl(String url) {
            if (url == null || !url.startsWith("https://")) return;
            // A pasted pairing link keeps its #pair fragment for this load, but only the address is remembered.
            prefs.edit().putString("url", url.split("#")[0]).apply();
            runOnUiThread(() -> { web.clearHistory(); web.loadUrl(url); });
        }

        @JavascriptInterface
        public void retry() {
            runOnUiThread(MainActivity.this::load);
        }

        @JavascriptInterface
        public void changeUrl() {
            runOnUiThread(() -> web.loadUrl(SETUP + "?change=1"));
        }

        // config: {"app","key","token"} from the paired page, or "" to turn notifications off.
        @JavascriptInterface
        public void setNotify(String config) {
            runOnUiThread(() -> {
                if (config == null || config.isEmpty()) disableNotify();
                else enableNotify(config);
            });
        }

        @JavascriptInterface
        public boolean notifyEnabled() {
            return NotifyService.enabled(MainActivity.this);
        }

        // A notification tapped while the app was closed: the page asks for its window once it has connected.
        @JavascriptInterface
        public String takeOpenWin() {
            String win = prefs.getString("openWin", "");
            prefs.edit().remove("openWin").apply();
            return win;
        }

        @JavascriptInterface
        public boolean canVoice() {
            return voiceIntent("").resolveActivity(getPackageManager()) != null;
        }

        // The result comes back through onActivityResult as window.onVoice(text).
        @JavascriptInterface
        public boolean voice(String lang) {
            Intent i = voiceIntent(lang);
            if (i.resolveActivity(getPackageManager()) == null) return false;
            runOnUiThread(() -> {
                try { startActivityForResult(i, VOICE); } catch (Exception e) { voiceResult(""); }
            });
            return true;
        }

        // The web app reports its effective theme so the WebView background behind it matches.
        @JavascriptInterface
        public void setTheme(boolean light) {
            prefs.edit().putBoolean("light", light).apply();
            runOnUiThread(() -> applyTheme(light));
        }

        @JavascriptInterface
        public boolean isLight() {
            return prefs.getBoolean("light", false);
        }

        @JavascriptInterface
        public void scan() {
            runOnUiThread(() -> new IntentIntegrator(MainActivity.this)
                    .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
                    .setPrompt(NotifyService.tr("扫描电脑上 npm run pair 显示的二维码", "Scan the QR code shown by npm run pair"))
                    .setBeepEnabled(false)
                    .setOrientationLocked(false)
                    .addExtra(Intents.Scan.SCAN_TYPE, Intents.Scan.MIXED_SCAN)
                    .initiateScan());
        }

        @JavascriptInterface
        public void update(String url) {
            if (url == null || !url.startsWith("https://")) return;
            runOnUiThread(() -> downloadUpdate(url));
        }
    }
}
