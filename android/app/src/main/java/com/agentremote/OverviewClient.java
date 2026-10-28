package com.agentremote;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

// Blocking HTTP for the native overview; always called off the main thread.
// Kept separate from NotifyService's private helpers so that file stays untouched.
final class OverviewClient {
    static class Unauthorized extends Exception {}

    private static final long RELAY_TTL = 5 * 60 * 1000;
    private static final Map<String, String> relayCache = new HashMap<>();
    private static final Map<String, Long> relayAt = new HashMap<>();

    private static String relay(JSONObject cfg) throws Exception {
        String id = cfg.getString("id");
        synchronized (relayCache) {
            Long at = relayAt.get(id);
            String r = relayCache.get(id);
            if (r != null && at != null && System.currentTimeMillis() - at < RELAY_TTL) return r;
        }
        String r = NotifyService.resolveRelay(cfg.getString("app"), cfg.optString("key"));
        synchronized (relayCache) {
            relayCache.put(id, r);
            relayAt.put(id, System.currentTimeMillis());
        }
        return r;
    }

    private static void dropRelay(String id) {
        synchronized (relayCache) {
            relayCache.remove(id);
            relayAt.remove(id);
        }
    }

    static JSONObject fetch(JSONObject cfg) throws Exception {
        String id = cfg.getString("id");
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(relay(cfg) + "/api/overview").openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            c.setRequestProperty("Authorization", "Bearer " + cfg.getString("token"));
            c.setRequestProperty("X-RA-Proof", EntryAuth.proof(cfg, "GET", "/api/overview"));
            int code = c.getResponseCode();
            JSONObject out = null;
            try (InputStream in = code == 200 ? c.getInputStream() : c.getErrorStream()) {
                if (in != null) out = new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
            }
            c.disconnect();
            if (code == 401) throw new Unauthorized();
            if (code != 200) throw new Exception("HTTP " + code);
            return out == null ? new JSONObject() : out;
        } catch (Exception e) {
            dropRelay(id);
            throw e;
        }
    }

    static void act(JSONObject cfg, JSONObject body) throws Exception {
        String id = cfg.getString("id");
        try {
            HttpURLConnection h = (HttpURLConnection) new URL(relay(cfg) + "/api/act").openConnection();
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
                try (InputStream err = h.getErrorStream()) {
                    if (err != null) msg = new JSONObject(new String(readAll(err), StandardCharsets.UTF_8)).optString("error");
                } catch (Exception ignored) {}
            }
            h.disconnect();
            if (code != 200) throw new Exception(msg.isEmpty() ? "HTTP " + code : msg);
        } catch (Exception e) {
            dropRelay(id);
            throw e;
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private OverviewClient() {}
}
