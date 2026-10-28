package com.agentremote;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

// Entry credentials the paired page hands to MainActivity.Bridge.setOverview; one JSON config per computer.
final class OverviewStore {
    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("agent-remote", Context.MODE_PRIVATE);
    }

    static void save(Context c, String json) {
        try {
            JSONObject cfg = new JSONObject(json);
            String id = cfg.optString("id");
            if (id.isEmpty() || cfg.optString("token").isEmpty() || !cfg.optString("app").startsWith("https://")) return;
            SharedPreferences p = prefs(c);
            p.edit().putString("overview:" + id, cfg.toString()).apply();
            JSONArray ids = new JSONArray(p.getString("overview:ids", "[]"));
            boolean have = false;
            for (int i = 0; i < ids.length(); i++) if (id.equals(ids.optString(i))) have = true;
            if (!have) {
                ids.put(id);
                p.edit().putString("overview:ids", ids.toString()).apply();
            }
        } catch (Exception ignored) {}
    }

    static List<JSONObject> all(Context c) {
        List<JSONObject> out = new ArrayList<>();
        try {
            SharedPreferences p = prefs(c);
            JSONArray ids = new JSONArray(p.getString("overview:ids", "[]"));
            for (int i = 0; i < ids.length(); i++) {
                String json = p.getString("overview:" + ids.optString(i), null);
                if (json != null) out.add(new JSONObject(json));
            }
        } catch (Exception ignored) {}
        return out;
    }

    static boolean any(Context c) {
        return !all(c).isEmpty();
    }

    static void remove(Context c, String id) {
        SharedPreferences p = prefs(c);
        try {
            JSONArray ids = new JSONArray(p.getString("overview:ids", "[]")), keep = new JSONArray();
            for (int i = 0; i < ids.length(); i++) if (!id.equals(ids.optString(i))) keep.put(ids.get(i));
            p.edit().putString("overview:ids", keep.toString()).remove("overview:" + id).remove("overview:name:" + id).apply();
        } catch (Exception ignored) {}
    }

    static String name(Context c, String id) {
        return prefs(c).getString("overview:name:" + id, id);
    }

    static void setName(Context c, String id, String name) {
        prefs(c).edit().putString("overview:name:" + id, name).apply();
    }

    private OverviewStore() {}
}
