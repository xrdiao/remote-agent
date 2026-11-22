package com.agentremote;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

public final class PhoneAccessibilityService extends AccessibilityService {
    private static final int MAX_NODES = 160;
    private static final int MAX_OBSERVATION_BYTES = 48 * 1024;
    private static PhoneAccessibilityService connected;
    private Snapshot latest, previous;

    private record Target(AccessibilityNodeInfo info, String label) {}
    private record Visit(AccessibilityNodeInfo info, int parent) {}
    private record Snapshot(int revision, int window, String app, String layout, List<Target> nodes) {
        void recycle() { for (Target target : nodes) target.info.recycle(); }
    }

    static PhoneAccessibilityService current() { return connected; }

    @Override protected void onServiceConnected() {
        connected = this;
        PhoneProjectionService.accessibilityChanged();
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        PhoneProjectionService.accessibilityChanged();
    }

    @Override public void onInterrupt() { invalidate(); }

    @Override public void onDestroy() {
        invalidate();
        if (connected == this) {
            connected = null;
            PhoneProjectionService.accessibilityChanged();
        }
        super.onDestroy();
    }

    void invalidate() {
        if (latest != null) latest.recycle();
        if (previous != null) previous.recycle();
        latest = previous = null;
    }

    JSONObject snapshot(int version, boolean detailed) throws JSONException {
        JSONArray entries = new JSONArray();
        JSONArray elements = new JSONArray();
        AccessibilityNodeInfo root = getRootInActiveWindow();
        int window = root == null ? -1 : root.getWindowId();
        String app = root == null ? "" : bounded(root.getPackageName());
        List<Target> nodes = new ArrayList<>();
        ArrayDeque<Visit> queue = new ArrayDeque<>();
        if (root != null) queue.add(new Visit(root, -1));
        boolean truncated = false;
        int bytes = 0;
        try {
            for (int visited = 0; visited < 600 && !queue.isEmpty() && nodes.size() < MAX_NODES; visited++) {
                Visit visit = queue.remove();
                AccessibilityNodeInfo node = visit.info;
                try {
                    if (protectedNode(node)) continue;
                    int actionId = -1, parent = visit.parent;
                    JSONArray actions = new JSONArray();
                    if (node.isVisibleToUser() && node.isEnabled()) {
                        for (AccessibilityNodeInfo.AccessibilityAction item : node.getActionList()) {
                            String name = actionName(item.getId());
                            if (name != null) actions.put(name);
                        }
                        if (actions.length() > 0) {
                            String title = label(node);
                            actionId = nodes.size();
                            entries.put(new JSONObject().put("id", actionId).put("label", title).put("actions", actions));
                            nodes.add(new Target(AccessibilityNodeInfo.obtain(node), title));
                        }
                    }
                    if (detailed && node.isVisibleToUser()) {
                        JSONObject element = describe(node, parent, actionId, actions);
                        int size = element.toString().getBytes(StandardCharsets.UTF_8).length + 1;
                        if (bytes + size <= MAX_OBSERVATION_BYTES) {
                            parent = elements.length();
                            elements.put(element);
                            bytes += size;
                        } else truncated = true;
                    }
                    for (int i = 0; i < node.getChildCount() && queue.size() < 600; i++) {
                        AccessibilityNodeInfo child = node.getChild(i);
                        if (child != null) queue.add(new Visit(child, parent));
                    }
                } finally { node.recycle(); }
            }
        } finally {
            truncated |= !queue.isEmpty();
            while (!queue.isEmpty()) queue.remove().info.recycle();
        }
        JSONObject observation = detailed ? new JSONObject().put("window", window).put("windows", windows())
                .put("elements", elements).put("truncated", truncated) : null;
        String layout = detailed ? entries.toString() + observation : entries.toString();
        Snapshot next = new Snapshot(version, window, app, layout, nodes);
        if (latest != null && latest.window == window && latest.app.equals(app) && latest.layout.equals(layout) && latest.nodes.equals(nodes)) {
            next.recycle();
            return null;
        }
        if (previous != null) previous.recycle();
        previous = latest;
        latest = next;
        JSONObject tree = new JSONObject().put("type", "tree").put("revision", version).put("app", app).put("nodes", entries);
        if (detailed) tree.put("observation", observation);
        return tree;
    }

    private static JSONObject describe(AccessibilityNodeInfo node, int parent, int actionId, JSONArray actions) throws JSONException {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        JSONObject element = new JSONObject().put("parent", parent).put("role", bounded(node.getClassName()))
                .put("bounds", rect(bounds));
        addText(element, "text", node.getText());
        addText(element, "description", node.getContentDescription());
        addText(element, "resource", node.getViewIdResourceName());
        if (Build.VERSION.SDK_INT >= 26) addText(element, "hint", node.getHintText());
        if (actionId >= 0) element.put("id", actionId).put("label", label(node)).put("actions", actions);
        if (!node.isEnabled()) element.put("enabled", false);
        if (node.isSelected()) element.put("selected", true);
        if (node.isCheckable()) element.put("checked", node.isChecked());
        if (node.isFocused()) element.put("focused", true);
        if (node.isScrollable()) element.put("scrollable", true);
        if (Build.VERSION.SDK_INT >= 28 && node.isHeading()) element.put("heading", true);
        return element;
    }

    private JSONArray windows() throws JSONException {
        JSONArray output = new JSONArray();
        for (AccessibilityWindowInfo window : getWindows()) {
            try {
                if (output.length() >= 16) continue;
                Rect bounds = new Rect();
                window.getBoundsInScreen(bounds);
                JSONObject item = new JSONObject().put("id", window.getId()).put("type", window.getType())
                        .put("active", window.isActive()).put("focused", window.isFocused()).put("bounds", rect(bounds));
                if (Build.VERSION.SDK_INT >= 24) addText(item, "title", window.getTitle());
                output.put(item);
            } finally { window.recycle(); }
        }
        return output;
    }

    private static JSONArray rect(Rect bounds) {
        return new JSONArray().put(bounds.left).put(bounds.top).put(bounds.right).put(bounds.bottom);
    }

    private static void addText(JSONObject target, String key, CharSequence value) throws JSONException {
        if (value != null && value.length() > 0) target.put(key, bounded(value));
    }

    boolean launch(String app) {
        Intent intent = getPackageManager().getLaunchIntentForPackage(app);
        if (intent == null) return false;
        try { startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return true; }
        catch (ActivityNotFoundException | SecurityException error) { return false; }
    }

    JSONArray apps() throws JSONException {
        JSONArray apps = new JSONArray();
        HashSet<String> packages = new HashSet<>();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        for (ResolveInfo result : getPackageManager().queryIntentActivities(launcher, 0)) {
            if (result.activityInfo == null || !packages.add(result.activityInfo.packageName)) continue;
            apps.put(new JSONObject().put("app", result.activityInfo.packageName)
                    .put("name", bounded(result.loadLabel(getPackageManager()))));
            if (apps.length() == 220) break;
        }
        return apps;
    }

    boolean nodeAction(int version, int index, String action, String text) {
        Snapshot target = latest != null && latest.revision == version ? latest : previous;
        if (target == null || target.revision != version || index < 0 || index >= target.nodes.size()) return false;
        if (!isActiveWindow(target.window, target.app)) return false;
        Target selected = target.nodes.get(index);
        AccessibilityNodeInfo node = selected.info;
        if (!node.refresh() || !node.isVisibleToUser() || !node.isEnabled() || protectedNode(node) || !selected.label.equals(label(node))) return false;
        for (AccessibilityNodeInfo.AccessibilityAction item : node.getActionList()) {
            if (!action.equals(actionName(item.getId()))) continue;
            if (!"text".equals(action)) return node.performAction(item.getId());
            Bundle input = new Bundle();
            input.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            return node.performAction(item.getId(), input);
        }
        return false;
    }

    boolean isActiveWindow(int window, String app) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return false;
        try { return root.getWindowId() == window && app.equals(bounded(root.getPackageName())); }
        finally { root.recycle(); }
    }

    boolean systemAction(String action) {
        return switch (action) {
            case "back" -> performGlobalAction(GLOBAL_ACTION_BACK);
            case "home" -> performGlobalAction(GLOBAL_ACTION_HOME);
            case "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS);
            default -> false;
        };
    }

    void gesture(float x, float y, float toX, float toY, int duration, Consumer<Boolean> result) {
        Path path = new Path();
        path.moveTo(x, y);
        if (x != toX || y != toY) path.lineTo(toX, toY);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, duration)).build();
        if (!dispatchGesture(gesture, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription g) { result.accept(true); }
            @Override public void onCancelled(GestureDescription g) { result.accept(false); }
        }, null)) result.accept(false);
    }

    private static String actionName(int id) {
        return switch (id) {
            case AccessibilityNodeInfo.ACTION_CLICK -> "click";
            case AccessibilityNodeInfo.ACTION_LONG_CLICK -> "longClick";
            case AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> "scrollForward";
            case AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> "scrollBackward";
            case AccessibilityNodeInfo.ACTION_SET_TEXT -> "text";
            default -> null;
        };
    }

    private static boolean protectedNode(AccessibilityNodeInfo node) {
        return node.isPassword() || Build.VERSION.SDK_INT >= 34 && node.isAccessibilityDataSensitive();
    }

    private static String label(AccessibilityNodeInfo node) {
        CharSequence text = node.getContentDescription();
        if (text == null || text.length() == 0) {
            if (node.isEditable() && Build.VERSION.SDK_INT >= 26) text = node.getHintText();
            else text = node.getText();
        }
        if (text == null || text.length() == 0) text = node.getViewIdResourceName();
        if (text == null || text.length() == 0) text = node.getClassName();
        return bounded(text);
    }

    private static String bounded(CharSequence text) {
        return text == null ? "" : text.subSequence(0, Math.min(160, text.length())).toString();
    }
}
