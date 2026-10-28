package com.agentremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.widget.FrameLayout;
import android.widget.ImageView;

import java.util.Collections;

// A native refresh button over the WebView, so the app can be recovered when the page itself is frozen.
public class RefreshBubble extends ImageView {
    private static final long IDLE_MS = 2000;
    private static final long MOVE_MS = 180;
    private static final float TUCKED_ALPHA = 0.2f;
    private static final float SHOWN_ALPHA = 0.9f;

    private final SharedPreferences prefs;
    private final Runnable onRefresh;
    private final GradientDrawable bg = new GradientDrawable();
    private final float density;
    private final FrameLayout parent;
    private final int size, margin, slop;
    private ImageView companion;
    private java.util.function.BooleanSupplier companionEnabled;
    private int compSize;
    private final Runnable idle = this::tuck;
    private boolean right = true;
    private boolean expanded;
    private boolean dragging;
    private int pw, ph;
    private float downRawX, downRawY, downX, downY;

    public RefreshBubble(Context c, FrameLayout parent, Runnable onRefresh) {
        super(c);
        this.onRefresh = onRefresh;
        prefs = c.getSharedPreferences("agent-remote", Context.MODE_PRIVATE);
        this.parent = parent;
        density = c.getResources().getDisplayMetrics().density;
        size = Math.round(44 * density);
        margin = Math.round(8 * density);
        slop = ViewConfiguration.get(c).getScaledTouchSlop();

        bg.setShape(GradientDrawable.OVAL);
        setBackground(bg);
        setElevation(6 * density);
        int pad = Math.round(10 * density);
        setPadding(pad, pad, pad, pad);
        setScaleType(ScaleType.FIT_CENTER);
        setImageResource(R.drawable.ic_refresh);
        setContentDescription(NotifyService.tr("刷新页面", "Refresh page"));
        setLayoutParams(new FrameLayout.LayoutParams(size, size, Gravity.TOP | Gravity.START));
        if (Build.VERSION.SDK_INT >= 29) setSystemGestureExclusionRects(Collections.singletonList(new Rect(0, 0, size, size)));
        setAlpha(TUCKED_ALPHA);
        setOnTouchListener((v, e) -> {
            onTouch(e);
            return true;
        });
        parent.addView(this);
        parent.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            if (r - l != pw || b - t != ph) {
                pw = r - l;
                ph = b - t;
                place();
            }
        });
    }

    public void setLight(boolean light) {
        bg.setColor(light ? 0xFFFFFFFF : 0xFF3C3C3C);
        setColorFilter(light ? 0xFF333333 : 0xFFFFFFFF);
        if (companion != null) {
            ((GradientDrawable) companion.getBackground()).setColor(light ? 0xFFFFFFFF : 0xFF3C3C3C);
            companion.setColorFilter(light ? 0xFF333333 : 0xFFFFFFFF);
        }
    }

    // A secondary button that appears beside the expanded bubble (e.g. back to the overview).
    public void setCompanion(int iconRes, String description, java.util.function.BooleanSupplier enabled, Runnable action) {
        companionEnabled = enabled;
        compSize = Math.round(36 * density);
        companion = new ImageView(getContext());
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(prefs.getBoolean("light", false) ? 0xFFFFFFFF : 0xFF3C3C3C);
        companion.setBackground(g);
        companion.setColorFilter(prefs.getBoolean("light", false) ? 0xFF333333 : 0xFFFFFFFF);
        companion.setElevation(getElevation());
        int pad = Math.round(9 * density);
        companion.setPadding(pad, pad, pad, pad);
        companion.setScaleType(ScaleType.FIT_CENTER);
        companion.setImageResource(iconRes);
        companion.setContentDescription(description);
        companion.setLayoutParams(new FrameLayout.LayoutParams(compSize, compSize, Gravity.TOP | Gravity.START));
        companion.setOnClickListener(v -> action.run());
        companion.setVisibility(GONE);
        parent.addView(companion);
    }

    private void showCompanion(float targetX, float targetY) {
        if (companion == null || !companionEnabled.getAsBoolean()) return;
        companion.setX(right ? targetX - compSize - margin : targetX + size + margin);
        companion.setY(targetY + size / 2f - compSize / 2f);
        companion.setVisibility(VISIBLE);
        companion.setAlpha(0f);
        companion.animate().cancel();
        companion.animate().alpha(SHOWN_ALPHA).setDuration(MOVE_MS).start();
    }

    private void hideCompanion(boolean animate) {
        if (companion == null) return;
        companion.animate().cancel();
        if (animate && companion.getVisibility() == VISIBLE) {
            companion.animate().alpha(0f).setDuration(MOVE_MS).withEndAction(() -> companion.setVisibility(GONE)).start();
        } else companion.setVisibility(GONE);
    }

    private void onTouch(MotionEvent e) {
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downRawX = e.getRawX();
                downRawY = e.getRawY();
                downX = getX();
                downY = getY();
                dragging = false;
                break;
            case MotionEvent.ACTION_MOVE:
                float dx = e.getRawX() - downRawX;
                float dy = e.getRawY() - downRawY;
                if (!dragging && Math.hypot(dx, dy) > slop) {
                    dragging = true;
                    hideCompanion(true);
                    removeCallbacks(idle);
                    animate().cancel();
                    setRotation(0);
                }
                if (dragging) {
                    setX(Math.max(0, Math.min(downX + dx, pw - size)));
                    setY(clampY(downY + dy));
                    setAlpha(SHOWN_ALPHA);
                }
                break;
            case MotionEvent.ACTION_UP:
                if (dragging) snap();
                else if (expanded) refresh();
                else expand();
                break;
            case MotionEvent.ACTION_CANCEL:
                if (dragging) snap();
                break;
        }
    }

    private void expand() {
        expanded = true;
        float x = edgeX(true), y = clampY(getY());
        move(x, y, SHOWN_ALPHA);
        showCompanion(x, y);
        restartIdle();
    }

    private void refresh() {
        animate().rotationBy(360).setDuration(360).start();
        restartIdle();
        onRefresh.run();
    }

    private void snap() {
        right = getX() + size / 2f >= pw / 2f;
        float y = clampY(getY());
        prefs.edit().putBoolean("bubbleRight", right).putFloat("bubbleY", (y + size / 2f) / ph).apply();
        dragging = false;
        expanded = true;
        float x = edgeX(true);
        move(x, y, SHOWN_ALPHA);
        showCompanion(x, y);
        restartIdle();
    }

    private void tuck() {
        if (!expanded) return;
        expanded = false;
        hideCompanion(true);
        move(edgeX(false), getY(), TUCKED_ALPHA);
    }

    // Called on first layout and whenever the parent changes size; always resting at the saved edge and height.
    private void place() {
        right = prefs.getBoolean("bubbleRight", true);
        float fraction = prefs.getFloat("bubbleY", 0.6f);
        expanded = false;
        dragging = false;
        hideCompanion(false);
        animate().cancel();
        removeCallbacks(idle);
        setRotation(0);
        setX(edgeX(false));
        setY(clampY(fraction * ph - size / 2f));
        setAlpha(TUCKED_ALPHA);
    }

    private void move(float x, float y, float alpha) {
        animate().x(x).y(y).alpha(alpha).setDuration(MOVE_MS).start();
    }

    private void restartIdle() {
        removeCallbacks(idle);
        postDelayed(idle, IDLE_MS);
    }

    private float edgeX(boolean shown) {
        if (shown) return right ? pw - size - margin : margin;
        return right ? pw - size / 2f : -size / 2f;
    }

    private float clampY(float y) {
        return Math.max(margin, Math.min(y, ph - size - margin));
    }
}
