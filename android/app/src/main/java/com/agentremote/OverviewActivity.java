package com.agentremote;

import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.transition.ChangeBounds;
import android.transition.Fade;
import android.transition.TransitionManager;
import android.transition.TransitionSet;
import android.view.animation.DecelerateInterpolator;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Space;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Native overview: a tile board of every computer the paired web app told us about, fed by
// GET /api/overview on each relay. Levels (computers / projects / sessions) work like the web mock;
// a session expands in place and can answer Devin questions through POST /api/act.
public class OverviewActivity extends Activity {
    private static final int LEVEL_COMPUTERS = 0, LEVEL_PROJECTS = 1, LEVEL_SESSIONS = 2;
    private static final int ST_WAIT = 0, ST_RUN = 1, ST_DONE = 2, ST_IDLE = 3;
    private static final long POLL_MS = 4000, READY_RETRY_MS = 1500, DONE_KEEP_MS = 60 * 60 * 1000;

    private SharedPreferences prefs;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private boolean light, resumed;

    // Per-computer snapshot, keyed by computer id and kept in the store's insertion order.
    private static class Comp {
        JSONObject cfg;
        String id;
        String status = "loading"; // loading / ok / offline / unauthorized / unavailable
        String error = "";
        String name;
        long offset; // relay clock minus phone clock
        volatile boolean inFlight;
        List<JSONObject> sessions = new ArrayList<>();
        final Map<String, Boolean> wasBusy = new HashMap<>();
    }

    private final Map<String, Comp> comps = new LinkedHashMap<>();
    // key -> wall time it went from busy to neither busy nor waiting; forgotten after an hour.
    private final Map<String, Long> finished = new HashMap<>();

    private int level = LEVEL_SESSIONS;
    private String compFilter, projFilter, openKey, scrollKey;
    private boolean idleShown;

    private LinearLayout root, crumbs, laneRow, empty, summary;
    private ImageView back;
    private HorizontalScrollView lane;
    private ScrollView scroller;
    private androidx.swiperefreshlayout.widget.SwipeRefreshLayout refresh;
    private OverviewGrid grid;
    private final TextView[] tabs = new TextView[3];
    private View sessionDot;
    private final Map<String, View> tiles = new HashMap<>();

    // ---- palette ----
    private int BG, S1, S2, S3, LINE, FG, FGH, FG2, FG3, FG4, ACC, OK, ERR, AMB, WTXT;

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private int tint(int color) {
        return (color & 0xFFFFFF) | 0x26000000;
    }

    private static String tr(String zh, String en) {
        return NotifyService.tr(zh, en);
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("agent-remote", MODE_PRIVATE);
        light = prefs.getBoolean("light", false);
        loadPalette();
        applyTheme();
        buildViews();
        setContentView(root);

        for (JSONObject cfg : OverviewStore.all(this)) {
            Comp c = new Comp();
            c.cfg = cfg;
            c.id = cfg.optString("id");
            c.name = OverviewStore.name(this, c.id);
            comps.put(c.id, c);
        }
        if (state == null && !OverviewStore.any(this)) {
            startActivity(new Intent(this, MainActivity.class));
            showEmpty(true);
        } else render();
        NotifyService.start(this);
    }

    private void loadPalette() {
        if (light) {
            BG = 0xFFF6F6F4; S1 = 0xFFFFFFFF; S2 = 0xFFEEEEEB; S3 = 0xFFE3E3DF; LINE = 0x1C111114;
            FG = 0xFF1D1E21; FGH = 0xFF0B0B0D; FG2 = 0xFF45484E; FG3 = 0xFF6C7078; FG4 = 0xFF9599A1;
            ACC = 0xFF5B50E8; OK = 0xFF12844F; ERR = 0xFFCC2F2F; AMB = 0xFFD98200; WTXT = 0xFF8A4E00;
        } else {
            BG = 0xFF0F1012; S1 = 0xFF17181C; S2 = 0xFF1F2125; S3 = 0xFF2A2C31; LINE = 0x1AFFFFFF;
            FG = 0xFFE8E9EB; FGH = 0xFFFAFAFB; FG2 = 0xFFB9BCC2; FG3 = 0xFF8A8E96; FG4 = 0xFF62666E;
            ACC = 0xFF8F87FF; OK = 0xFF4ADE9B; ERR = 0xFFFF6B6B; AMB = 0xFFFBBF4D; WTXT = 0xFFFBBF4D;
        }
    }

    // Same system-bar handling as MainActivity.applyTheme.
    private void applyTheme() {
        getWindow().setBackgroundDrawable(new ColorDrawable(BG));
        if (Build.VERSION.SDK_INT >= 23) {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            getWindow().setStatusBarColor(BG);
            if (Build.VERSION.SDK_INT >= 26) getWindow().setNavigationBarColor(BG);
            View d = getWindow().getDecorView();
            int flags = d.getSystemUiVisibility();
            flags = light ? flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR : flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26)
                flags = light ? flags | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : flags & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            d.setSystemUiVisibility(flags);
        }
    }

    private void buildViews() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);

        // Header: back arrow, breadcrumb, "Full UI" pill.
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(8), 0, dp(16), 0);
        root.addView(header, new LinearLayout.LayoutParams(-1, dp(52)));

        back = new ImageView(this);
        back.setImageResource(R.drawable.ic_back);
        back.setColorFilter(FGH);
        back.setPadding(dp(10), dp(10), dp(10), dp(10));
        back.setBackground(pill(0));
        back.setOnClickListener(v -> goUp());
        header.addView(back, new LinearLayout.LayoutParams(dp(44), dp(44)));
        ((LinearLayout.LayoutParams) back.getLayoutParams()).rightMargin = dp(4);

        crumbs = new LinearLayout(this);
        crumbs.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(crumbs, new LinearLayout.LayoutParams(0, -1, 1));

        TextView full = label(tr("完整界面", "Full UI"), 13, FGH, true);
        GradientDrawable fp = pill(tint(ACC));
        fp.setColor(tint(ACC));
        full.setBackground(fp);
        full.setPadding(dp(14), dp(8), dp(14), dp(8));
        full.setOnClickListener(v -> startActivity(new Intent(this, MainActivity.class)));
        header.addView(full);

        summary = new LinearLayout(this);
        summary.setGravity(Gravity.CENTER_VERTICAL);
        summary.setPadding(dp(20), 0, dp(20), dp(6));
        root.addView(summary);

        lane = new HorizontalScrollView(this);
        lane.setHorizontalScrollBarEnabled(false);
        laneRow = new LinearLayout(this);
        laneRow.setPadding(dp(16), 0, dp(16), dp(8));
        lane.addView(laneRow);
        root.addView(lane);

        scroller = new ScrollView(this);
        grid = new OverviewGrid(this);
        grid.setPadding(dp(16), dp(4), dp(16), dp(24));
        scroller.addView(grid, new ScrollView.LayoutParams(-1, -2));
        refresh = new androidx.swiperefreshlayout.widget.SwipeRefreshLayout(this);
        refresh.setColorSchemeColors(ACC);
        refresh.setProgressBackgroundColorSchemeColor(S1);
        refresh.addView(scroller);
        refresh.setOnRefreshListener(() -> {
            if (comps.isEmpty()) { refresh.setRefreshing(false); return; }
            pollAll();
        });
        root.addView(refresh, new LinearLayout.LayoutParams(-1, 0, 1));

        // Bottom level bar, Material 3 style tabs.
        LinearLayout bar = new LinearLayout(this);
        bar.setBackgroundColor(S1);
        bar.setPadding(dp(24), dp(6), dp(24), dp(14));
        bar.setBackgroundColor(S1);
        root.addView(bar);
        String[] names = {tr("电脑", "Computers"), tr("项目", "Projects"), tr("会话", "Sessions")};
        for (int i = 0; i < 3; i++) {
            final int lv = i;
            FrameLayout cell = new FrameLayout(this);
            TextView t = label(names[i], 13, FG3, true);
            t.setGravity(Gravity.CENTER);
            t.setPadding(dp(14), dp(8), dp(14), dp(8));
            tabs[i] = t;
            cell.addView(t, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
            cell.setOnClickListener(v -> setLevel(lv));
            bar.addView(cell, new LinearLayout.LayoutParams(0, -2, 1));
        }
        sessionDot = dot(AMB);
        ((FrameLayout) tabs[LEVEL_SESSIONS].getParent()).addView(sessionDot, new FrameLayout.LayoutParams(dp(7), dp(7), Gravity.TOP | Gravity.RIGHT));
        ((FrameLayout.LayoutParams) sessionDot.getLayoutParams()).setMargins(0, dp(6), dp(24), 0);

        empty = new LinearLayout(this);
        empty.setOrientation(LinearLayout.VERTICAL);
        empty.setGravity(Gravity.CENTER);
        empty.setPadding(dp(32), 0, dp(32), 0);
        TextView msg = label(tr("打开完整应用并连接电脑，电脑会显示在这里", "Open the full app and connect a computer; it will show up here"), 15, FG3, false);
        msg.setGravity(Gravity.CENTER);
        empty.addView(msg);
        TextView open = label(tr("打开完整应用", "Open full app"), 14, 0xFFFFFFFF, true);
        GradientDrawable ob = pill(ACC);
        open.setBackground(ob);
        open.setPadding(dp(20), dp(10), dp(20), dp(10));
        open.setOnClickListener(v -> startActivity(new Intent(this, MainActivity.class)));
        LinearLayout.LayoutParams op = new LinearLayout.LayoutParams(-2, -2);
        op.topMargin = dp(16);
        empty.addView(open, op);
    }

    private void showEmpty(boolean show) {
        if (show && empty.getParent() == null) {
            int i = root.indexOfChild(refresh);
            root.removeView(refresh);
            root.addView(empty, i < 0 ? root.getChildCount() - 1 : i, new LinearLayout.LayoutParams(-1, 0, 1));
        } else if (!show && empty.getParent() != null) {
            int i = root.indexOfChild(empty);
            root.removeView(empty);
            root.addView(refresh, i < 0 ? root.getChildCount() - 1 : i, new LinearLayout.LayoutParams(-1, 0, 1));
        }
    }

    // ---- small view factories ----

    private TextView label(String text, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        return t;
    }

    private GradientDrawable pill(int color) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setCornerRadius(dp(999));
        g.setColor(color);
        return g;
    }

    private View dot(int color) {
        View d = new View(this);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(color);
        d.setBackground(g);
        return d;
    }

    private int optIndex(String id) {
        try { return Integer.parseInt(id.substring(id.indexOf(':') + 1)); } catch (Exception e) { return 0; }
    }

    // ---- polling ----

    private final Runnable pollTick = new Runnable() {
        @Override
        public void run() {
            pollAll();
            ui.postDelayed(this, POLL_MS);
        }
    };

    @Override
    protected void onResume() {
        super.onResume();
        boolean nowLight = prefs.getBoolean("light", false);
        if (nowLight != light) { recreate(); return; }
        resumed = true;
        syncComps();
        pollAll();
        ui.postDelayed(pollTick, POLL_MS);
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
        ui.removeCallbacks(pollTick);
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        pool.shutdownNow();
        super.onDestroy();
    }

    // Credentials can appear or change while we're paused (the user paired in the full app).
    private void syncComps() {
        List<JSONObject> all = OverviewStore.all(this);
        Map<String, Comp> ordered = new LinkedHashMap<>();
        for (JSONObject cfg : all) {
            String id = cfg.optString("id");
            Comp c = comps.remove(id);
            if (c == null) {
                c = new Comp();
                c.id = id;
                c.name = OverviewStore.name(this, id);
            }
            c.cfg = cfg;
            ordered.put(id, c);
        }
        comps.clear();
        comps.putAll(ordered);
        if (compFilter != null && !comps.containsKey(compFilter)) { compFilter = null; projFilter = null; }
        render();
    }

    private void pollAll() {
        for (Comp c : comps.values()) poll(c);
    }

    private void poll(final Comp c) {
        if (c.inFlight) return;
        c.inFlight = true;
        pool.execute(() -> {
            try {
                JSONObject r = OverviewClient.fetch(c.cfg);
                ui.post(() -> { c.inFlight = false; onFetched(c, r); });
            } catch (OverviewClient.Unauthorized e) {
                ui.post(() -> { c.inFlight = false; c.status = "unauthorized"; c.sessions = new ArrayList<>(); render(); });
            } catch (Exception e) {
                String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                ui.post(() -> { c.inFlight = false; c.status = "offline"; c.error = msg; c.sessions = new ArrayList<>(); render(); });
            }
        });
    }

    private void onFetched(Comp c, JSONObject r) {
        if (!r.optBoolean("available", true)) {
            c.status = "unavailable";
            c.sessions = new ArrayList<>();
            render();
            return;
        }
        if (!r.optBoolean("ready", true)) {
            c.status = "loading";
            render();
            if (resumed) ui.postDelayed(() -> poll(c), READY_RETRY_MS);
            return;
        }
        c.status = "ok";
        c.error = "";
        String name = r.optString("name");
        if (!name.isEmpty() && !name.equals(c.name)) {
            c.name = name;
            OverviewStore.setName(this, c.id, name);
        }
        c.offset = r.optLong("now") - System.currentTimeMillis();
        JSONArray arr = r.optJSONArray("sessions");
        List<JSONObject> list = new ArrayList<>();
        if (arr != null) for (int i = 0; i < arr.length(); i++) {
            JSONObject s = arr.optJSONObject(i);
            if (s != null) list.add(s);
        }
        // A session that was busy and is now neither busy nor waiting is done; remember when.
        long now = System.currentTimeMillis();
        Map<String, Boolean> busy = new HashMap<>();
        for (JSONObject s : list) {
            String k = key(c.id, s);
            busy.put(k, s.optBoolean("busy"));
            Boolean was = c.wasBusy.get(k);
            if (Boolean.TRUE.equals(was) && !s.optBoolean("busy") && s.optString("waiting").isEmpty())
                finished.put(k, now);
        }
        c.wasBusy.clear();
        c.wasBusy.putAll(busy);
        for (Map.Entry<String, Long> e : new ArrayList<>(finished.entrySet()))
            if (now - e.getValue() > DONE_KEEP_MS) finished.remove(e.getKey());
        c.sessions = list;
        render();
    }

    // ---- model helpers ----

    private static String key(String comp, JSONObject s) {
        return comp + "|" + s.optString("win") + "|" + s.optString("windowId") + "|" + s.optString("threadId");
    }

    private int stateOf(String k, JSONObject s) {
        if (!s.optString("waiting").isEmpty()) return ST_WAIT;
        if (s.optBoolean("busy")) return ST_RUN;
        if (finished.containsKey(k)) return ST_DONE;
        return ST_IDLE;
    }

    private int stateColor(int st) {
        switch (st) {
            case ST_WAIT: return AMB;
            case ST_RUN: return ACC;
            case ST_DONE: return OK;
            default: return FG4;
        }
    }

    private Comp compOf(JSONObject s) {
        for (Comp c : comps.values()) if (c.sessions.contains(s)) return c;
        return null;
    }

    private List<JSONObject> scopedSessions() {
        List<JSONObject> out = new ArrayList<>();
        for (Comp c : comps.values()) {
            if (compFilter != null && !c.id.equals(compFilter)) continue;
            for (JSONObject s : c.sessions) {
                if (projFilter != null && !(c.id + "|" + s.optString("win") + "|" + s.optString("windowId")).equals(projFilter)) continue;
                out.add(s);
            }
        }
        return out;
    }

    private List<JSONObject> sorted(List<JSONObject> in, Comp c) {
        List<JSONObject> wait = new ArrayList<>(), run = new ArrayList<>(), done = new ArrayList<>(), idle = new ArrayList<>();
        for (JSONObject s : in) {
            switch (stateOf(key(c.id, s), s)) {
                case ST_WAIT: wait.add(s); break;
                case ST_RUN: run.add(s); break;
                case ST_DONE: done.add(s); break;
                default: idle.add(s);
            }
        }
        done.sort((a, b2) -> Long.compare(finished.getOrDefault(key(c.id, b2), 0L), finished.getOrDefault(key(c.id, a), 0L)));
        List<JSONObject> out = new ArrayList<>();
        out.addAll(wait); out.addAll(run); out.addAll(done); out.addAll(idle);
        return out;
    }

    private int[] counts(List<JSONObject> in, Comp c) {
        int[] n = new int[4];
        for (JSONObject s : in) n[stateOf(key(c.id, s), s)]++;
        return n;
    }

    private String elapsed(long startedAt, long offset) {
        if (startedAt <= 0) return "";
        long ms = System.currentTimeMillis() - (startedAt - offset);
        if (ms < 0) ms = 0;
        return dur(ms);
    }

    private String ago(long at) {
        return dur(System.currentTimeMillis() - at) + tr("前", " ago");
    }

    private String dur(long ms) {
        long m = ms / 60000;
        if (m < 1) return tr("刚刚", "just now");
        if (m < 60) return m + "m";
        return (m / 60) + "h " + (m % 60) + "m";
    }

    private int logoFor(String app) {
        switch (app) {
            case "cursor": return R.drawable.ic_logo_cursor;
            case "devin": return R.drawable.ic_logo_devin;
            case "codex": return R.drawable.ic_logo_codex;
            default: return R.drawable.ic_monitor;
        }
    }

    private String appName(String app) {
        switch (app) {
            case "cursor": return "Cursor";
            case "devin": return "Devin";
            case "codex": return "Codex";
            default: return app;
        }
    }

    // ---- navigation ----

    private void setLevel(int lv) {
        if (lv == LEVEL_COMPUTERS) { compFilter = null; projFilter = null; }
        if (lv == LEVEL_PROJECTS) projFilter = null;
        level = lv;
        render();
    }

    private void goUp() {
        if (projFilter != null) { projFilter = null; level = LEVEL_PROJECTS; }
        else if (compFilter != null) { compFilter = null; level = LEVEL_COMPUTERS; }
        render();
    }

    @Override
    public void onBackPressed() {
        if (openKey != null) { animateBoard(); openKey = null; render(); return; }
        if (projFilter != null) { projFilter = null; level = LEVEL_PROJECTS; render(); return; }
        if (compFilter != null) { compFilter = null; level = LEVEL_COMPUTERS; render(); return; }
        super.onBackPressed();
    }

    // ---- rendering ----

    private void render() {
        if (refresh.isRefreshing() && comps.values().stream().noneMatch(c -> c.inFlight)) refresh.setRefreshing(false);
        if (!OverviewStore.any(this)) { showEmpty(true); return; }
        showEmpty(false);
        back.setVisibility(projFilter != null || compFilter != null ? View.VISIBLE : View.GONE);
        renderCrumbs();
        renderSummary();
        renderLane();
        renderBoard();
        renderTabs();
    }

    private void renderCrumbs() {
        crumbs.removeAllViews();
        List<String[]> parts = new ArrayList<>(); // label, action
        parts.add(new String[]{tr("全部", "All"), "all"});
        if (compFilter != null) {
            Comp c = comps.get(compFilter);
            parts.add(new String[]{c != null ? c.name : compFilter, "comp"});
        }
        if (projFilter != null) parts.add(new String[]{projName(projFilter), "proj"});
        for (int i = 0; i < parts.size(); i++) {
            if (i > 0) {
                TextView sep = label("›", 15, FG4, false);
                sep.setPadding(dp(4), 0, dp(4), 0);
                crumbs.addView(sep);
            }
            boolean last = i == parts.size() - 1;
            TextView t = label(parts.get(i)[0], last ? 17 : 15, last ? FGH : FG3, last);
            t.setSingleLine(true);
            t.setEllipsize(TextUtils.TruncateAt.END);
            final String act = parts.get(i)[1];
            t.setOnClickListener(v -> {
                if ("all".equals(act)) setLevel(LEVEL_COMPUTERS);
                else if ("comp".equals(act)) setLevel(LEVEL_PROJECTS);
            });
            crumbs.addView(t);
        }
    }

    private String projName(String filter) {
        for (Comp c : comps.values())
            for (JSONObject s : c.sessions)
                if ((c.id + "|" + s.optString("win") + "|" + s.optString("windowId")).equals(filter))
                    return s.optString("project");
        return filter;
    }

    private void renderSummary() {
        List<JSONObject> scope = scopedSessions();
        int[] n = new int[4];
        for (JSONObject s : scope) {
            Comp c = compOf(s);
            n[stateOf(key(c != null ? c.id : "", s), s)]++;
        }
        summary.removeAllViews();
        int[][] parts = {
                {n[ST_WAIT], AMB},
                {n[ST_RUN], ACC},
                {n[ST_DONE], OK},
                {level != LEVEL_SESSIONS ? n[ST_IDLE] : 0, FG4},
        };
        String[] words = {tr(" 个等你处理", " need you"), tr(" 个进行中", " running"), tr(" 个已完成", " done"), tr(" 个空闲", " idle")};
        boolean any = false;
        for (int i = 0; i < parts.length; i++) {
            if (parts[i][0] == 0) continue;
            any = true;
            View d = dot(parts[i][1]);
            LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(dp(8), dp(8));
            dlp.rightMargin = dp(6);
            summary.addView(d, dlp);
            TextView t = label(parts[i][0] + words[i], 13, FG3, false);
            LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(-2, -2);
            tp.rightMargin = dp(14);
            summary.addView(t, tp);
        }
        summary.setVisibility(any ? View.VISIBLE : View.GONE);
    }

    private void renderLane() {
        laneRow.removeAllViews();
        if (level == LEVEL_SESSIONS) { lane.setVisibility(View.GONE); return; }
        List<JSONObject> waiting = new ArrayList<>();
        for (JSONObject s : scopedSessions()) {
            Comp c = compOf(s);
            if (c != null && stateOf(key(c.id, s), s) == ST_WAIT) waiting.add(s);
        }
        if (waiting.isEmpty()) { lane.setVisibility(View.GONE); return; }
        lane.setVisibility(View.VISIBLE);
        for (JSONObject s : waiting) {
            final Comp c = compOf(s);
            final String k = key(c.id, s);
            LinearLayout pill = new LinearLayout(this);
            pill.setGravity(Gravity.CENTER_VERTICAL);
            pill.setOrientation(LinearLayout.HORIZONTAL);
            GradientDrawable g = pill(S1);
            g.setStroke(dp(2), AMB);
            pill.setBackground(g);
            pill.setPadding(dp(6), 0, dp(16), 0);
            ImageView logo = logo(s.optString("app"), 32);
            pill.addView(logo);
            TextView t = label(s.optString("title"), 14, FGH, true);
            t.setSingleLine(true);
            t.setEllipsize(TextUtils.TruncateAt.END);
            t.setMaxWidth(dp(180));
            t.setPadding(dp(9), 0, dp(6), 0);
            pill.addView(t);
            TextView kind = label(s.optString("waiting").startsWith("q:") ? tr("提问", "Question") : tr("待批准", "Approve?"), 12, WTXT, true);
            pill.addView(kind);
            pill.setOnClickListener(v -> {
                compFilter = c.id;
                projFilter = null;
                openKey = k;
                scrollKey = k;
                level = LEVEL_SESSIONS;
                render();
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, dp(46));
            lp.rightMargin = dp(8);
            laneRow.addView(pill, lp);
        }
    }

    private void renderTabs() {
        for (int i = 0; i < 3; i++) {
            boolean on = level == i;
            tabs[i].setTextColor(on ? ACC : FG3);
            tabs[i].setBackground(on ? pill(tint(ACC)) : null);
        }
        boolean anyWait = false;
        for (JSONObject s : scopedSessions()) {
            Comp c = compOf(s);
            if (c != null && stateOf(key(c.id, s), s) == ST_WAIT) { anyWait = true; break; }
        }
        sessionDot.setVisibility(anyWait && level != LEVEL_SESSIONS ? View.VISIBLE : View.GONE);
    }

    // ---- board ----

    private static class Item {
        String key;
        int kind; // 0 session, 1 computer, 2 project, 3 label, 4 idle toggle, 5 expanded
        int span;
        float aspect;
        Object data;
        String text;
        int color;
    }

    private void renderBoard() {
        boolean wide = getResources().getConfiguration().screenWidthDp >= 600;
        int cols = wide ? 4 : 2;
        grid.setCols(cols);
        View focused = getCurrentFocus();
        List<Item> items = new ArrayList<>();
        switch (level) {
            case LEVEL_COMPUTERS: computerItems(items, cols); break;
            case LEVEL_PROJECTS: projectItems(items, cols); break;
            default: sessionItems(items, cols);
        }
        // Reorder/reuse tiles by key; expanded tiles keep their views (and the EditText's text).
        for (int i = 0; i < items.size(); i++) {
            Item it = items.get(i);
            View v = tiles.get(it.key);
            if (v == null || (Integer) v.getTag() != it.kind) {
                v = createTile(it);
                tiles.put(it.key, v);
            }
            if (grid.getChildAt(i) != v) {
                if (v.getParent() != null) ((ViewGroup) v.getParent()).removeView(v);
                v.setLayoutParams(new OverviewGrid.LP(it.span, it.aspect));
                grid.addView(v, i);
            } else {
                OverviewGrid.LP lp = (OverviewGrid.LP) v.getLayoutParams();
                lp.span = it.span;
                lp.aspect = it.aspect;
            }
            // Collapsed and expanded tiles of one session share a name so the transition morphs one into the other.
            v.setTransitionName(it.kind == 0 || it.kind == 5 ? "t:" + it.key.substring(2) : null);
            bindTile(it, v);
        }
        for (int i = grid.getChildCount() - 1; i >= items.size(); i--) grid.removeViewAt(i);
        tiles.keySet().retainAll(keysOf(items));
        // Moving a tile re-attaches it, which clears focus inside it; give the reply field its focus back.
        if (focused != null && focused.isAttachedToWindow() && focused.isShown() && !focused.isFocused()) focused.requestFocus();
        if (scrollKey != null) {
            final View v = tiles.get(scrollKey);
            scrollKey = null;
            if (v != null) scroller.post(() -> scroller.smoothScrollTo(0, v.getTop() - dp(8)));
        }
        grid.requestLayout();
    }

    // Animate the next board layout; only for user-driven expand/collapse, never for polling.
    private void animateBoard() {
        TransitionSet t = new TransitionSet().addTransition(new ChangeBounds()).addTransition(new Fade());
        t.setDuration(240);
        t.setInterpolator(new DecelerateInterpolator());
        TransitionManager.beginDelayedTransition(grid, t);
    }

    private List<String> keysOf(List<Item> items) {
        List<String> out = new ArrayList<>();
        for (Item it : items) out.add(it.key);
        return out;
    }

    private void computerItems(List<Item> items, int cols) {
        for (Comp c : comps.values()) {
            Item it = new Item();
            it.key = "c:" + c.id;
            it.kind = 1;
            it.data = c;
            it.span = 1;
            it.aspect = 1;
            items.add(it);
        }
    }

    private void projectItems(List<Item> items, int cols) {
        for (Comp c : comps.values()) {
            if (compFilter != null && !c.id.equals(compFilter)) continue;
            // One project tile per window (win + windowId).
            Map<String, List<JSONObject>> groups = new LinkedHashMap<>();
            for (JSONObject s : c.sessions) {
                String g = c.id + "|" + s.optString("win") + "|" + s.optString("windowId");
                groups.computeIfAbsent(g, k -> new ArrayList<>()).add(s);
            }
            if (groups.isEmpty()) {
                Item it = new Item();
                it.key = "p:" + c.id + "|";
                it.kind = 2;
                it.data = new Object[]{c, "", new ArrayList<JSONObject>()};
                it.span = 1;
                it.aspect = 1;
                items.add(it);
                continue;
            }
            for (Map.Entry<String, List<JSONObject>> e : groups.entrySet()) {
                Item it = new Item();
                it.key = "p:" + e.getKey();
                it.kind = 2;
                it.data = new Object[]{c, e.getKey(), e.getValue()};
                it.span = 1;
                it.aspect = 1;
                items.add(it);
            }
        }
    }

    private void sessionItems(List<Item> items, int cols) {
        int scoped = 0;
        for (Comp c : comps.values()) if (compFilter == null || c.id.equals(compFilter)) scoped++;
        for (Comp c : comps.values()) {
            if (compFilter != null && !c.id.equals(compFilter)) continue;
            if (compFilter == null && scoped > 1) items.add(labelItem("h:" + c.id, c.name, cols, FG2));
            List<JSONObject> in = new ArrayList<>();
            for (JSONObject s : c.sessions) {
                if (projFilter != null && !(c.id + "|" + s.optString("win") + "|" + s.optString("windowId")).equals(projFilter)) continue;
                in.add(s);
            }
            List<JSONObject> all = sorted(in, c);
            List<JSONObject> shown = new ArrayList<>(), idle = new ArrayList<>();
            for (JSONObject s : all) {
                if (stateOf(key(c.id, s), s) == ST_IDLE) idle.add(s);
                else shown.add(s);
            }
            boolean sawDone = false;
            for (JSONObject s : shown) {
                String k = key(c.id, s);
                int st = stateOf(k, s);
                if (st == ST_DONE && !sawDone) {
                    sawDone = true;
                    items.add(labelItem("d:" + c.id, tr("已完成", "Finished"), cols));
                }
                if (k.equals(openKey)) {
                    Item it = new Item();
                    it.key = "o:" + k;
                    it.kind = 5;
                    it.data = new Object[]{c, s};
                    it.span = cols;
                    it.aspect = 0;
                    items.add(it);
                    continue;
                }
                Item it = new Item();
                it.key = "s:" + k;
                it.kind = 0;
                it.data = new Object[]{c, s};
                if (st == ST_WAIT) {
                    it.span = Math.min(2, cols);
                    it.aspect = 0.5f;
                } else if (st == ST_RUN) {
                    it.span = 1;
                    it.aspect = 1;
                } else {
                    it.span = 1;
                    it.aspect = 0;
                }
                items.add(it);
            }
            if (!idle.isEmpty()) {
                Item t = new Item();
                t.key = "i:" + c.id;
                t.kind = 4;
                t.data = new Object[]{c, idle};
                t.text = tr("空闲会话", "Idle sessions") + " (" + idle.size() + ")";
                t.span = cols;
                t.aspect = 0;
                items.add(t);
                if (idleShown) {
                    for (JSONObject s : idle) {
                        String k = key(c.id, s);
                        if (k.equals(openKey)) {
                            Item it = new Item();
                            it.key = "o:" + k;
                            it.kind = 5;
                            it.data = new Object[]{c, s};
                            it.span = cols;
                            it.aspect = 0;
                            items.add(it);
                            continue;
                        }
                        Item it = new Item();
                        it.key = "s:" + k;
                        it.kind = 0;
                        it.data = new Object[]{c, s};
                        it.span = 1;
                        it.aspect = 0;
                        items.add(it);
                    }
                }
            }
            if (!"ok".equals(c.status)) {
                String text = "loading".equals(c.status) ? tr("加载中…", "Loading…")
                        : "unauthorized".equals(c.status) ? tr("打开完整应用重新连接", "Open the full app to reconnect")
                        : "unavailable".equals(c.status) ? tr("另一个中继实例正在负责监控", "Another relay instance owns the watcher")
                        : c.error.isEmpty() ? c.status : c.error;
                items.add(labelItem("e:" + c.id, text, cols));
            } else if (all.isEmpty()) items.add(labelItem("e:" + c.id, tr("没有打开中的 Agent 窗口", "No agent windows open"), cols));
        }
        if (items.isEmpty()) items.add(labelItem("e:all", tr("没有会话", "No sessions"), cols));
    }

    private Item labelItem(String key, String text, int cols) {
        return labelItem(key, text, cols, FG4);
    }

    private Item labelItem(String key, String text, int cols, int color) {
        Item it = new Item();
        it.key = key;
        it.kind = 3;
        it.text = text;
        it.span = cols;
        it.aspect = 0;
        it.color = color;
        return it;
    }

    // ---- tiles ----

    private String chipText(JSONObject s, int st) {
        switch (st) {
            case ST_WAIT: return s.optString("waiting").startsWith("q:") ? tr("提问", "Question") : tr("待批准", "Approve?");
            case ST_RUN: return tr("进行中", "Running");
            case ST_DONE: return tr("已完成", "Done");
            default: return tr("空闲", "Idle");
        }
    }

    private ImageView logo(String app, int dp) {
        ImageView iv = new ImageView(this);
        iv.setImageResource(logoFor(app));
        iv.setColorFilter(FGH);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(S2);
        iv.setBackground(bg);
        int p = Math.round(dp * getResources().getDisplayMetrics().density * 0.22f);
        iv.setPadding(p, p, p, p);
        iv.setLayoutParams(new LinearLayout.LayoutParams(dp(dp), dp(dp)));
        return iv;
    }

    private LinearLayout chip(String text, int color) {
        LinearLayout ch = new LinearLayout(this);
        ch.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable g = pill(tint(color));
        ch.setBackground(g);
        ch.setPadding(dp(8), dp(4), dp(10), dp(4));
        View d = dot(color);
        ch.addView(d, new LinearLayout.LayoutParams(dp(7), dp(7)));
        ((LinearLayout.LayoutParams) d.getLayoutParams()).rightMargin = dp(6);
        TextView t = label(text, 12, color, true);
        ch.addView(t);
        ch.setTag(d);
        return ch;
    }

    private void setChip(LinearLayout ch, String text, int color, boolean pulse) {
        GradientDrawable g = pill(tint(color));
        ch.setBackground(g);
        View d = (View) ch.getTag();
        ((GradientDrawable) d.getBackground()).setColor(color);
        ObjectAnimator old = (ObjectAnimator) d.getTag();
        if (old != null) { old.cancel(); d.setTag(null); d.setAlpha(1f); }
        if (pulse) {
            ObjectAnimator a = ObjectAnimator.ofFloat(d, "alpha", 1f, 0.25f);
            a.setDuration(800);
            a.setRepeatMode(ValueAnimator.REVERSE);
            a.setRepeatCount(ValueAnimator.INFINITE);
            a.start();
            d.setTag(a);
        }
        TextView t = (TextView) ch.getChildAt(1);
        t.setText(text);
        t.setTextColor(color);
    }

    // Tile draws the task-progress fill behind its children, clipped to the same round rect.
    private class Tile extends FrameLayout {
        float fillFrac;
        int fillColor;
        final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        final RectF rect = new RectF();

        Tile(Context c) {
            super(c);
            setWillNotDraw(false);
        }

        void setFill(float frac, int color) {
            fillFrac = frac;
            fillColor = color;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            if (fillFrac > 0) {
                float h = getHeight() * Math.min(1f, fillFrac);
                rect.set(0, getHeight() - h, getWidth(), getHeight());
                paint.setColor(fillColor);
                canvas.drawRect(rect, paint); // flat top edge; the tile outline clips the corners
            }
        }
    }

    private GradientDrawable tileBg(int st) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setCornerRadius(dp(28));
        g.setColor(S1);
        if (st == ST_WAIT) g.setStroke(dp(2), AMB);
        else g.setStroke(dp(1), LINE);
        return g;
    }

    private class SessTile extends Tile {
        final ImageView logo;
        final LinearLayout chip;
        final TextView title, now, big, time;
        final LinearLayout head, foot;
        String k;

        SessTile() {
            super(OverviewActivity.this);
            LinearLayout box = new LinearLayout(OverviewActivity.this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setPadding(dp(14), dp(14), dp(14), dp(14));
            addView(box, new FrameLayout.LayoutParams(-1, -1));

            head = new LinearLayout(OverviewActivity.this);
            head.setGravity(Gravity.TOP);
            box.addView(head);
            logo = OverviewActivity.this.logo("devin", 38);
            head.addView(logo);
            Space sp = new Space(OverviewActivity.this);
            head.addView(sp, new LinearLayout.LayoutParams(0, 1, 1));
            chip = OverviewActivity.this.chip("", FG4);
            head.addView(chip);

            title = label("", 18, FGH, true);
            title.setMaxLines(2);
            title.setEllipsize(TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(-1, -2);
            tp.topMargin = dp(12);
            box.addView(title, tp);

            now = label("", 13, FG3, false);
            now.setSingleLine(true);
            now.setEllipsize(TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(-1, -2);
            np.topMargin = dp(4);
            box.addView(now, np);

            Space mid = new Space(OverviewActivity.this);
            box.addView(mid, new LinearLayout.LayoutParams(-1, 0, 1));

            foot = new LinearLayout(OverviewActivity.this);
            foot.setGravity(Gravity.BOTTOM);
            box.addView(foot);
            big = label("", 20, FGH, true);
            foot.addView(big);
            Space sp2 = new Space(OverviewActivity.this);
            foot.addView(sp2, new LinearLayout.LayoutParams(0, 1, 1));
            time = label("", 13, FG3, false);
            foot.addView(time);
        }

        void bind(Comp c, JSONObject s) {
            k = key(c.id, s);
            int st = stateOf(k, s);
            boolean compact = st == ST_DONE || st == ST_IDLE;
            setBackground(tileBg(st));
            setClipToOutline(true);
            setElevation(dp(1));
            logo.setImageResource(logoFor(s.optString("app")));
            setChip(chip, chipText(s, st), stateColor(st), st == ST_RUN);
            String t = s.optString("title");
            if (t.isEmpty()) t = s.optString("project");
            title.setText(t);
            title.setTextSize(TypedValue.COMPLEX_UNIT_SP, compact ? 15 : 18);
            title.setTextColor(compact ? FG2 : FGH);
            now.setVisibility(compact ? GONE : VISIBLE);
            foot.setVisibility(compact ? GONE : VISIBLE);
            if (!compact) {
                String prefix = projFilter == null && !s.optString("project").isEmpty() ? s.optString("project") + " · " : "";
                String line;
                if (st == ST_WAIT) {
                    line = s.optString("waitingText");
                    now.setTextColor(WTXT);
                } else if (st == ST_RUN) {
                    JSONObject tasks = s.optJSONObject("tasks");
                    line = tasks != null ? tasks.optString("current") : "";
                    if (line.isEmpty()) line = tr("进行中…", "Working…");
                    now.setTextColor(FG3);
                } else {
                    line = s.optString("last");
                    now.setTextColor(FG3);
                }
                now.setText(prefix + line);
                JSONObject tasks = s.optJSONObject("tasks");
                big.setText(tasks != null ? tasks.optInt("done") + "/" + tasks.optInt("total") : "");
                if (st == ST_DONE) {
                    Long at = finished.get(k);
                    time.setText(at != null ? ago(at) : "");
                } else {
                    time.setText(elapsed(s.optLong("startedAt"), c.offset));
                }
                float frac = tasks != null && tasks.optInt("total") > 0 ? (float) tasks.optInt("done") / tasks.optInt("total") : 0;
                setFill(frac, tint(stateColor(st)));
            } else {
                setFill(0, 0);
            }
        }
    }

    private class OpenTile extends Tile {
        final ImageView logo;
        final LinearLayout chip;
        final TextView title, meta, elapsed, question, note, lastText, tasksLine, tasksNow, full;
        final LinearLayout opts, replyRow;
        final EditText reply;
        final ImageView send, close;
        final TextView accept;
        final SegView bar;
        final LinearLayout body;
        String k;
        Comp comp;
        JSONObject sess;

        boolean inFlight;

        OpenTile() {
            super(OverviewActivity.this);
            setBackground(tileBg(ST_IDLE));
            setClipToOutline(true);
            setElevation(dp(2));
            LinearLayout box = new LinearLayout(OverviewActivity.this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setPadding(dp(14), dp(14), dp(14), dp(14));
            addView(box, new FrameLayout.LayoutParams(-1, -2));

            LinearLayout head = new LinearLayout(OverviewActivity.this);
            head.setGravity(Gravity.CENTER_VERTICAL);
            box.addView(head);
            logo = OverviewActivity.this.logo("devin", 40);
            head.addView(logo);
            title = label("", 18, FGH, true);
            title.setMaxLines(2);
            title.setEllipsize(TextUtils.TruncateAt.END);
            title.setPadding(dp(12), 0, 0, 0);
            head.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
            close = new ImageView(OverviewActivity.this);
            close.setImageResource(R.drawable.ic_close);
            close.setColorFilter(FG3);
            close.setPadding(dp(10), dp(10), dp(10), dp(10));
            close.setOnClickListener(v -> { animateBoard(); openKey = null; render(); });
            head.addView(close, new LinearLayout.LayoutParams(dp(44), dp(44)));

            LinearLayout status = new LinearLayout(OverviewActivity.this);
            status.setGravity(Gravity.CENTER_VERTICAL);
            LinearLayout.LayoutParams stp = new LinearLayout.LayoutParams(-1, -2);
            stp.topMargin = dp(12);
            box.addView(status, stp);
            chip = OverviewActivity.this.chip("", FG4);
            status.addView(chip);
            meta = label("", 13, FG3, false);
            meta.setSingleLine(true);
            meta.setEllipsize(TextUtils.TruncateAt.END);
            meta.setPadding(dp(10), 0, 0, 0);
            status.addView(meta, new LinearLayout.LayoutParams(0, -2, 1));
            elapsed = label("", 13, FG3, false);
            status.addView(elapsed);

            body = new LinearLayout(OverviewActivity.this);
            body.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(-1, -2);
            bp.topMargin = dp(10);
            box.addView(body, bp);

            question = label("", 17, FG, false);
            body.addView(question);
            opts = new LinearLayout(OverviewActivity.this);
            opts.setOrientation(LinearLayout.VERTICAL);
            body.addView(opts);
            note = label(tr("请在完整对话中回复", "Answer this in the full conversation."), 13, FG3, false);
            body.addView(note);

            bar = new SegView(OverviewActivity.this);
            body.addView(bar, new LinearLayout.LayoutParams(-1, dp(8)));
            tasksLine = label("", 13, FG3, false);
            body.addView(tasksLine);
            tasksNow = label("", 13, FG2, false);
            body.addView(tasksNow);

            lastText = label("", 14, FG, false);
            lastText.setMaxLines(6);
            lastText.setEllipsize(TextUtils.TruncateAt.END);
            body.addView(lastText);

            accept = label("", 14, 0xFFFFFFFF, true);
            accept.setGravity(Gravity.CENTER);
            accept.setBackground(pill(ACC));
            accept.setPadding(dp(16), dp(10), dp(16), dp(10));
            body.addView(accept);

            replyRow = new LinearLayout(OverviewActivity.this);
            replyRow.setGravity(Gravity.CENTER_VERTICAL);
            body.addView(replyRow);
            reply = new EditText(OverviewActivity.this);
            reply.setHint(tr("回复 Agent…", "Reply to the Agent…"));
            reply.setHintTextColor(FG4);
            reply.setTextColor(FG);
            reply.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            reply.setSingleLine(true);
            reply.setImeOptions(EditorInfo.IME_ACTION_SEND);
            reply.setBackground(pill(S2));
            reply.setPadding(dp(16), dp(8), dp(16), dp(8));
            replyRow.addView(reply, new LinearLayout.LayoutParams(0, -2, 1));
            send = new ImageView(OverviewActivity.this);
            send.setImageResource(R.drawable.ic_send);
            send.setColorFilter(0xFFFFFFFF);
            send.setBackground(pill(ACC));
            send.setPadding(dp(10), dp(10), dp(10), dp(10));
            LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(dp(40), dp(40));
            sp.leftMargin = dp(8);
            replyRow.addView(send, sp);

            full = label(tr("完整对话 →", "Full conversation →"), 14, ACC, true);
            full.setPadding(0, dp(12), 0, 0);
            box.addView(full);
        }

        void bind(Comp c, JSONObject s) {
            comp = c;
            sess = s;
            k = key(c.id, s);
            int st = stateOf(k, s);
            logo.setImageResource(logoFor(s.optString("app")));
            String t = s.optString("title");
            if (t.isEmpty()) t = s.optString("project");
            title.setText(t);
            setChip(chip, chipText(s, st), stateColor(st), st == ST_RUN);
            String compName = compFilter == null ? " · " + c.name : "";
            meta.setText(s.optString("project") + " · " + appName(s.optString("app")) + compName);
            elapsed.setText(st == ST_DONE && finished.get(k) != null ? ago(finished.get(k)) : elapsed(s.optLong("startedAt"), c.offset));
            boolean devin = s.optBoolean("devin");
            boolean wait = st == ST_WAIT;

            question.setVisibility(wait ? VISIBLE : GONE);
            question.setText(s.optString("waitingText"));
            opts.removeAllViews();
            opts.setVisibility(GONE);
            note.setVisibility(GONE);
            bar.setVisibility(GONE);
            tasksLine.setVisibility(GONE);
            tasksNow.setVisibility(GONE);
            lastText.setVisibility(GONE);
            accept.setVisibility(GONE);
            // Set once below: hiding the row even briefly drops the reply field's focus on every poll.
            boolean showReply = devin && (wait || !s.optBoolean("busy"));

            if (wait) {
                JSONArray actions = s.optJSONArray("actions");
                if (devin && actions != null && actions.length() > 0) {
                    opts.setVisibility(VISIBLE);
                    for (int i = 0; i < actions.length(); i++) {
                        JSONObject a = actions.optJSONObject(i);
                        if (a == null) continue;
                        final int idx = optIndex(a.optString("id"));
                        TextView b = label(a.optString("label"), 15, FGH, false);
                        b.setGravity(Gravity.CENTER);
                        b.setBackground(pill(S2));
                        b.setPadding(dp(16), dp(12), dp(16), dp(12));
                        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
                        lp.topMargin = dp(8);
                        opts.addView(b, lp);
                        b.setOnClickListener(v -> act(s, c, "opt", idx, null));
                    }
                }
                if (!devin) note.setVisibility(VISIBLE);
            } else {
                JSONObject tasks = s.optJSONObject("tasks");
                if (tasks != null) {
                    bar.setVisibility(VISIBLE);
                    int total = tasks.optInt("total"), done = tasks.optInt("done");
                    bar.setCounts(new int[]{done, Math.max(0, total - done)}, new int[]{stateColor(st), S3});
                    tasksLine.setVisibility(VISIBLE);
                    tasksLine.setText(tr("共 " + total + " 个任务，已完成 " + done, done + " of " + total + " tasks"));
                    String cur = tasks.optString("current");
                    if (!cur.isEmpty()) { tasksNow.setVisibility(VISIBLE); tasksNow.setText(cur); }
                }
                String last = s.optString("last");
                if (!last.isEmpty()) {
                    lastText.setVisibility(VISIBLE);
                    lastText.setText(last);
                }
                String changeAction = s.optString("changeAction", "Accept all");
                if (devin && !s.optBoolean("busy") && s.optInt("changed") > 0 && !changeAction.isEmpty()) {
                    accept.setVisibility(VISIBLE);
                    accept.setText("Accept all".equals(changeAction)
                            ? tr("接受全部改动 (" + s.optInt("changed") + ")", "Accept all changes (" + s.optInt("changed") + ")")
                            : changeAction + " (" + s.optInt("changed") + ")");
                    accept.setOnClickListener(v -> act(s, c, "acceptAll", -1, null));
                }
            }
            replyRow.setVisibility(showReply ? VISIBLE : GONE);
            send.setOnClickListener(v -> {
                String text = reply.getText().toString().trim();
                if (text.isEmpty()) return;
                act(s, c, "reply", -1, text);
            });
            reply.setOnEditorActionListener((v, id, e) -> {
                if (id == EditorInfo.IME_ACTION_SEND) { send.performClick(); return true; }
                return false;
            });
            full.setOnClickListener(v -> {
                Intent i = new Intent(OverviewActivity.this, MainActivity.class);
                i.putExtra("win", s.optString("win"));
                i.putExtra("computer", c.id);
                i.putExtra("windowId", s.optString("windowId"));
                i.putExtra("threadId", s.optString("threadId"));
                startActivity(i);
            });
            setControls(!inFlight);
        }

        private void act(JSONObject s, Comp c, String act, int index, String text) {
            inFlight = true;
            setControls(false);
            pool.execute(() -> {
                String err = null;
                try {
                    JSONObject body = new JSONObject()
                            .put("win", s.optString("win"))
                            .put("windowId", s.optString("windowId"))
                            .put("threadId", s.optString("threadId"))
                            .put("question", s.optString("waiting"))
                            .put("act", act);
                    if (index >= 0) body.put("index", index);
                    if (text != null) body.put("text", text);
                    OverviewClient.act(c.cfg, body);
                } catch (Exception e) {
                    err = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                }
                final String msg = err;
                ui.post(() -> {
                    inFlight = false;
                    setControls(true);
                    if (msg == null) {
                        reply.setText("");
                        InputMethodManager im = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                        if (im != null) im.hideSoftInputFromWindow(reply.getWindowToken(), 0);
                        Toast.makeText(OverviewActivity.this, tr("已发送", "Sent"), Toast.LENGTH_SHORT).show();
                        animateBoard();
                        openKey = null;
                        render();
                    } else Toast.makeText(OverviewActivity.this, msg, Toast.LENGTH_LONG).show();
                });
            });
        }

        private void setControls(boolean on) {
            send.setEnabled(on);
            accept.setEnabled(on);
            for (int i = 0; i < opts.getChildCount(); i++) opts.getChildAt(i).setEnabled(on);
        }
    }

    private class CompTile extends Tile {
        final ImageView icon;
        final LinearLayout chip;
        final TextView name, sub, active;
        final SegView seg;
        Comp comp;

        CompTile() {
            super(OverviewActivity.this);
            LinearLayout box = new LinearLayout(OverviewActivity.this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setPadding(dp(14), dp(14), dp(14), dp(14));
            addView(box, new FrameLayout.LayoutParams(-1, -1));
            LinearLayout head = new LinearLayout(OverviewActivity.this);
            head.setGravity(Gravity.TOP);
            box.addView(head);
            icon = new ImageView(OverviewActivity.this);
            icon.setImageResource(R.drawable.ic_monitor);
            icon.setColorFilter(FG2);
            GradientDrawable bg = new GradientDrawable();
            bg.setShape(GradientDrawable.OVAL);
            bg.setColor(S2);
            icon.setBackground(bg);
            int p = dp(8);
            icon.setPadding(p, p, p, p);
            head.addView(icon, new LinearLayout.LayoutParams(dp(38), dp(38)));
            Space sp = new Space(OverviewActivity.this);
            head.addView(sp, new LinearLayout.LayoutParams(0, 1, 1));
            chip = OverviewActivity.this.chip("", FG4);
            head.addView(chip);
            name = label("", 18, FGH, true);
            name.setMaxLines(2);
            name.setEllipsize(TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(-1, -2);
            np.topMargin = dp(12);
            box.addView(name, np);
            sub = label("", 13, FG3, false);
            sub.setMaxLines(2);
            sub.setEllipsize(TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams sp2 = new LinearLayout.LayoutParams(-1, -2);
            sp2.topMargin = dp(4);
            box.addView(sub, sp2);
            Space mid = new Space(OverviewActivity.this);
            box.addView(mid, new LinearLayout.LayoutParams(-1, 0, 1));
            LinearLayout foot = new LinearLayout(OverviewActivity.this);
            foot.setGravity(Gravity.CENTER_VERTICAL);
            box.addView(foot);
            seg = new SegView(OverviewActivity.this);
            foot.addView(seg, new LinearLayout.LayoutParams(0, dp(8), 1));
            active = label("", 13, FG3, false);
            active.setPadding(dp(8), 0, 0, 0);
            foot.addView(active);
        }

        void bind(Comp c) {
            comp = c;
            setBackground(tileBg(ST_IDLE));
            setClipToOutline(true);
            setElevation(dp(1));
            boolean bad = !"ok".equals(c.status) && !"loading".equals(c.status);
            int[] n = counts(c.sessions, c);
            String text;
            int color;
            if ("loading".equals(c.status)) { text = tr("加载中…", "Loading…"); color = FG4; }
            else if ("offline".equals(c.status) || "unauthorized".equals(c.status)) { text = tr("离线", "Offline"); color = FG4; }
            else if (n[ST_WAIT] > 0) { text = n[ST_WAIT] + tr(" 个等你处理", " need you"); color = AMB; }
            else if (bad) { text = tr("加载失败", "Failed to load"); color = ERR; }
            else if (n[ST_RUN] > 0) { text = n[ST_RUN] + tr(" 个进行中", " running"); color = ACC; }
            else { text = tr("空闲", "Idle"); color = FG4; }
            if ("unavailable".equals(c.status)) { text = tr("不可用", "Unavailable"); color = FG4; }
            setChip(chip, text, color, n[ST_RUN] > 0 && !bad);
            name.setText(c.name);
            if ("loading".equals(c.status)) sub.setText(tr("加载中…", "Loading…"));
            else if ("unauthorized".equals(c.status)) sub.setText(tr("打开完整应用重新连接", "Open the full app to reconnect"));
            else if ("unavailable".equals(c.status)) sub.setText(tr("另一个中继实例正在负责监控", "Another relay instance owns the watcher"));
            else if (bad) sub.setText(c.error.isEmpty() ? c.status : c.error);
            else if (c.sessions.isEmpty()) sub.setText(tr("没有打开中的 Agent 窗口", "No agent windows open"));
            else {
                int wins = 0;
                List<String> seen = new ArrayList<>();
                for (JSONObject s : c.sessions) {
                    String w = s.optString("win") + "|" + s.optString("windowId");
                    if (!seen.contains(w)) { seen.add(w); wins++; }
                }
                sub.setText(wins + tr(" 个窗口", wins == 1 ? " window" : " windows") + " · " + c.sessions.size() + tr(" 个会话", c.sessions.size() == 1 ? " session" : " sessions"));
            }
            seg.setCounts(n, new int[]{AMB, ACC, OK, FG4});
            int act = n[ST_WAIT] + n[ST_RUN];
            active.setText(act > 0 ? act + tr(" 个活跃", " active") : "");
            setAlpha(bad ? 0.55f : 1f);
        }
    }

    private class ProjTile extends Tile {
        final ImageView logo;
        final LinearLayout chip;
        final TextView title, sub, active;
        final SegView seg;

        ProjTile() {
            super(OverviewActivity.this);
            LinearLayout box = new LinearLayout(OverviewActivity.this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setPadding(dp(14), dp(14), dp(14), dp(14));
            addView(box, new FrameLayout.LayoutParams(-1, -1));
            LinearLayout head = new LinearLayout(OverviewActivity.this);
            head.setGravity(Gravity.TOP);
            box.addView(head);
            logo = OverviewActivity.this.logo("devin", 38);
            head.addView(logo);
            Space sp = new Space(OverviewActivity.this);
            head.addView(sp, new LinearLayout.LayoutParams(0, 1, 1));
            chip = OverviewActivity.this.chip("", FG4);
            head.addView(chip);
            title = label("", 18, FGH, true);
            title.setMaxLines(2);
            title.setEllipsize(TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(-1, -2);
            tp.topMargin = dp(12);
            box.addView(title, tp);
            sub = label("", 13, FG3, false);
            sub.setSingleLine(true);
            sub.setEllipsize(TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams sp2 = new LinearLayout.LayoutParams(-1, -2);
            sp2.topMargin = dp(4);
            box.addView(sub, sp2);
            Space mid = new Space(OverviewActivity.this);
            box.addView(mid, new LinearLayout.LayoutParams(-1, 0, 1));
            LinearLayout foot = new LinearLayout(OverviewActivity.this);
            foot.setGravity(Gravity.CENTER_VERTICAL);
            box.addView(foot);
            seg = new SegView(OverviewActivity.this);
            foot.addView(seg, new LinearLayout.LayoutParams(0, dp(8), 1));
            active = label("", 13, FG3, false);
            active.setPadding(dp(8), 0, 0, 0);
            foot.addView(active);
        }

        @SuppressWarnings("unchecked")
        void bind(Comp c, String group, List<JSONObject> sessions) {
            setBackground(tileBg(ST_IDLE));
            setClipToOutline(true);
            setElevation(dp(1));
            if (sessions.isEmpty()) {
                logo.setImageResource(R.drawable.ic_monitor);
                setChip(chip, "loading".equals(c.status) ? tr("加载中…", "Loading…") : "offline".equals(c.status) || "unauthorized".equals(c.status) ? tr("离线", "Offline") : tr("空闲", "Idle"), FG4, false);
                title.setText(c.name);
                if ("loading".equals(c.status)) sub.setText(tr("加载中…", "Loading…"));
                else if ("unauthorized".equals(c.status)) sub.setText(tr("打开完整应用重新连接", "Open the full app to reconnect"));
                else if (!"ok".equals(c.status)) sub.setText(c.error.isEmpty() ? c.status : c.error);
                else sub.setText(tr("没有打开中的 Agent 窗口", "No agent windows open"));
                seg.setCounts(new int[4], new int[]{AMB, ACC, OK, FG4});
                active.setText("");
                setAlpha(!"ok".equals(c.status) && !"loading".equals(c.status) ? 0.55f : 1f);
                setFill(0, 0);
                return;
            }
            setAlpha(1f);
            JSONObject first = sessions.get(0);
            logo.setImageResource(logoFor(first.optString("app")));
            int[] n = counts(sessions, c);
            String text;
            int color;
            if (n[ST_WAIT] > 0) { text = n[ST_WAIT] + tr(" 个等你处理", " need you"); color = AMB; }
            else if (n[ST_RUN] > 0) { text = n[ST_RUN] + tr(" 个进行中", " running"); color = ACC; }
            else { text = tr("空闲", "Idle"); color = FG4; }
            setChip(chip, text, color, n[ST_RUN] > 0);
            title.setText(first.optString("project"));
            String compPart = compFilter == null ? c.name + " · " : "";
            sub.setText(compPart + sessions.size() + tr(" 个会话", sessions.size() == 1 ? " session" : " sessions"));
            seg.setCounts(n, new int[]{AMB, ACC, OK, FG4});
            int act = n[ST_WAIT] + n[ST_RUN];
            active.setText(act > 0 ? act + tr(" 个活跃", " active") : "");
        }
    }

    // The colored count bar at the bottom of computer and project tiles.
    private class SegView extends View {
        private int[] counts = new int[4];
        private int[] colors = {AMB, ACC, OK, FG4};
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF r = new RectF();

        SegView(Context c) {
            super(c);
        }

        void setCounts(int[] n, int[] cols) {
            counts = n;
            colors = cols;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            int total = 0;
            for (int n : counts) total += n;
            float x = 0, w = getWidth(), h = getHeight(), rad = h / 2;
            if (total <= 0) {
                p.setColor(S3);
                r.set(0, 0, w, h);
                canvas.drawRoundRect(r, rad, rad, p);
                return;
            }
            for (int i = 0; i < counts.length; i++) {
                if (counts[i] == 0) continue;
                float seg = w * counts[i] / total;
                p.setColor(colors[i]);
                r.set(x, 0, x + seg, h);
                canvas.drawRoundRect(r, rad, rad, p);
                x += seg;
            }
        }
    }

    private View createTile(Item it) {
        View v;
        switch (it.kind) {
            case 0: v = new SessTile(); break;
            case 1: v = new CompTile(); break;
            case 2: v = new ProjTile(); break;
            case 5: v = new OpenTile(); break;
            case 4: {
                TextView t = label(it.text, 14, FG3, true);
                t.setGravity(Gravity.CENTER_VERTICAL | Gravity.LEFT);
                t.setPadding(dp(6), dp(10), dp(6), dp(10));
                v = t;
                break;
            }
            default: {
                TextView t = label(it.text, 13, it.color != 0 ? it.color : FG4, true);
                t.setPadding(dp(6), dp(8), dp(6), dp(8));
                v = t;
            }
        }
        v.setTag(it.kind);
        return v;
    }

    @SuppressWarnings("unchecked")
    private void bindTile(Item it, View v) {
        switch (it.kind) {
            case 0: {
                Object[] d = (Object[]) it.data;
                SessTile t = (SessTile) v;
                t.bind((Comp) d[0], (JSONObject) d[1]);
                final Comp c = (Comp) d[0];
                final String k = t.k;
                v.setOnClickListener(x -> { animateBoard(); openKey = k; render(); });
                break;
            }
            case 1: {
                CompTile t = (CompTile) v;
                Comp c = (Comp) it.data;
                t.bind(c);
                v.setOnClickListener(x -> { compFilter = c.id; projFilter = null; level = LEVEL_PROJECTS; render(); });
                v.setOnLongClickListener(x -> {
                    new AlertDialog.Builder(this)
                            .setMessage(tr("从概览移除？", "Remove from overview?"))
                            .setPositiveButton(tr("移除", "Remove"), (dlg, w) -> {
                                OverviewStore.remove(this, c.id);
                                comps.remove(c.id);
                                if (c.id.equals(compFilter)) { compFilter = null; projFilter = null; level = LEVEL_COMPUTERS; }
                                render();
                            })
                            .setNegativeButton(tr("取消", "Cancel"), null)
                            .show();
                    return true;
                });
                break;
            }
            case 2: {
                Object[] d = (Object[]) it.data;
                ProjTile t = (ProjTile) v;
                t.bind((Comp) d[0], (String) d[1], (List<JSONObject>) d[2]);
                String group = (String) d[1];
                Comp c = (Comp) d[0];
                if (!group.isEmpty()) {
                    v.setOnClickListener(x -> { compFilter = c.id; projFilter = group; level = LEVEL_SESSIONS; render(); });
                } else v.setOnClickListener(null);
                break;
            }
            case 4: {
                ((TextView) v).setText(it.text + (idleShown ? " ▾" : " ▸"));
                v.setOnClickListener(x -> { animateBoard(); idleShown = !idleShown; render(); });
                break;
            }
            case 5: {
                Object[] d = (Object[]) it.data;
                ((OpenTile) v).bind((Comp) d[0], (JSONObject) d[1]);
                v.setOnClickListener(null);
                v.setClickable(true); // swallow taps inside the expanded tile
                break;
            }
            default: {
                TextView t = (TextView) v;
                t.setText(it.text);
                if (it.color != 0) t.setTextColor(it.color);
                v.setOnClickListener(null);
            }
        }
    }
}
