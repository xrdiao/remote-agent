package com.agentremote;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import android.view.ViewGroup;

// Rows pack children left to right over a fixed column count. Each child declares a column span and
// an aspect (height/width, or 0 for wrap-content height); a row's height is its tallest child.
public class OverviewGrid extends ViewGroup {
    private int cols = 2;
    private int gap;

    public OverviewGrid(Context c) {
        super(c);
        gap = Math.round(12 * c.getResources().getDisplayMetrics().density);
    }

    public void setCols(int n) {
        cols = Math.max(1, n);
    }

    public void setGapPx(int px) {
        gap = px;
    }

    public static class LP extends ViewGroup.LayoutParams {
        int span;
        float aspect;

        public LP(int span, float aspect) {
            super(WRAP_CONTENT, WRAP_CONTENT);
            this.span = span;
            this.aspect = aspect;
        }
    }

    @Override
    protected ViewGroup.LayoutParams generateDefaultLayoutParams() {
        return new LP(1, 1);
    }

    @Override
    public ViewGroup.LayoutParams generateLayoutParams(AttributeSet a) {
        return new LP(1, 1);
    }

    @Override
    protected ViewGroup.LayoutParams generateLayoutParams(ViewGroup.LayoutParams p) {
        return new LP(1, 1);
    }

    @Override
    protected boolean checkLayoutParams(ViewGroup.LayoutParams p) {
        return p instanceof LP;
    }

    private int spanOf(View v) {
        ViewGroup.LayoutParams p = v.getLayoutParams();
        int s = p instanceof LP ? ((LP) p).span : 1;
        return Math.max(1, Math.min(s, cols));
    }

    private float aspectOf(View v) {
        ViewGroup.LayoutParams p = v.getLayoutParams();
        return p instanceof LP ? ((LP) p).aspect : 1;
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int w = MeasureSpec.getSize(widthMeasureSpec);
        int avail = w - getPaddingLeft() - getPaddingRight();
        int colW = Math.max(0, (avail - gap * (cols - 1)) / cols);
        int rowH = 0, used = 0, y = 0;
        for (int i = 0; i < getChildCount(); i++) {
            View v = getChildAt(i);
            if (v.getVisibility() == GONE) continue;
            int span = spanOf(v);
            if (used > 0 && used + span > cols) {
                y += rowH + gap;
                rowH = 0;
                used = 0;
            }
            int cw = colW * span + gap * (span - 1);
            float aspect = aspectOf(v);
            if (aspect > 0) {
                v.measure(MeasureSpec.makeMeasureSpec(cw, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(Math.round(cw * aspect), MeasureSpec.EXACTLY));
            } else {
                v.measure(MeasureSpec.makeMeasureSpec(cw, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
            }
            rowH = Math.max(rowH, v.getMeasuredHeight());
            used += span;
        }
        y += rowH;
        setMeasuredDimension(w, y + getPaddingTop() + getPaddingBottom());
    }

    @Override
    protected void onLayout(boolean changed, int l, int t, int r, int b) {
        int avail = r - l - getPaddingLeft() - getPaddingRight();
        int colW = Math.max(0, (avail - gap * (cols - 1)) / cols);
        // Same row packing as onMeasure; a pass finds each row's height, then children are placed.
        int x = getPaddingLeft(), y = getPaddingTop(), rowH = 0, used = 0;
        for (int i = 0; i < getChildCount(); i++) {
            View v = getChildAt(i);
            if (v.getVisibility() == GONE) continue;
            int span = spanOf(v);
            if (used > 0 && used + span > cols) {
                y += rowH + gap;
                x = getPaddingLeft();
                rowH = 0;
                used = 0;
            }
            int cw = colW * span + gap * (span - 1);
            v.layout(x, y, x + cw, y + v.getMeasuredHeight());
            x += cw + gap;
            rowH = Math.max(rowH, v.getMeasuredHeight());
            used += span;
        }
    }
}
