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
    private final int size, margin, slop;
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
        float density = c.getResources().getDisplayMetrics().density;
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
        move(edgeX(true), clampY(getY()), SHOWN_ALPHA);
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
        move(edgeX(true), y, SHOWN_ALPHA);
        restartIdle();
    }

    private void tuck() {
        if (!expanded) return;
        expanded = false;
        move(edgeX(false), getY(), TUCKED_ALPHA);
    }

    // Called on first layout and whenever the parent changes size; always resting at the saved edge and height.
    private void place() {
        right = prefs.getBoolean("bubbleRight", true);
        float fraction = prefs.getFloat("bubbleY", 0.6f);
        expanded = false;
        dragging = false;
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
