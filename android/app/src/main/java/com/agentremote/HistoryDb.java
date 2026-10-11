package com.agentremote;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

// The phone's copy of every Devin session: one JSON blob per session plus a plain-text index of the messages
// for searching. Lives in app-private storage, so a WebView storage clean-up cannot take it away.
class HistoryDb extends SQLiteOpenHelper {
    HistoryDb(Context c) {
        super(c, "history.db", null, 1);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE sess (k TEXT PRIMARY KEY, data TEXT NOT NULL, n INTEGER, bytes INTEGER, updated INTEGER)");
        db.execSQL("CREATE TABLE msg (k TEXT NOT NULL, id TEXT NOT NULL, role TEXT, body TEXT, PRIMARY KEY (k, id))");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int from, int to) {}

    synchronized String get(String k) {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT data FROM sess WHERE k = ?", new String[]{k})) {
            return c.moveToFirst() ? c.getString(0) : "";
        }
    }

    synchronized String meta(String k) {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT n, bytes, updated FROM sess WHERE k = ?", new String[]{k})) {
            if (!c.moveToFirst()) return "";
            try {
                return new JSONObject().put("n", c.getLong(0)).put("bytes", c.getLong(1)).put("updated", c.getLong(2)).toString();
            } catch (Exception e) {
                return "";
            }
        }
    }

    // meta: {"n","bytes","updated"}; msgs: [{"id","role","body"}] (plain text, for search).
    synchronized boolean put(String k, String data, String meta, String msgs) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            JSONObject m = new JSONObject(meta);
            ContentValues v = new ContentValues();
            v.put("k", k);
            v.put("data", data);
            v.put("n", m.optLong("n"));
            v.put("bytes", m.optLong("bytes"));
            v.put("updated", m.optLong("updated"));
            db.insertWithOnConflict("sess", null, v, SQLiteDatabase.CONFLICT_REPLACE);
            db.delete("msg", "k = ?", new String[]{k});
            JSONArray a = new JSONArray(msgs);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                ContentValues r = new ContentValues();
                r.put("k", k);
                r.put("id", o.getString("id"));
                r.put("role", o.optString("role"));
                r.put("body", o.optString("body"));
                db.insertWithOnConflict("msg", null, r, SQLiteDatabase.CONFLICT_REPLACE);
            }
            db.setTransactionSuccessful();
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            db.endTransaction();
        }
    }

    synchronized void delete(String k) {
        SQLiteDatabase db = getWritableDatabase();
        db.delete("sess", "k = ?", new String[]{k});
        db.delete("msg", "k = ?", new String[]{k});
    }

    synchronized String keys() {
        JSONArray a = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT k FROM sess ORDER BY updated DESC", null)) {
            while (c.moveToNext()) a.put(c.getString(0));
        }
        return a.toString();
    }

    // Messages containing the text (case-insensitive), newest sessions first; each hit carries a short snippet.
    synchronized String search(String q, int limit) {
        JSONArray out = new JSONArray();
        if (q == null || q.trim().isEmpty()) return out.toString();
        String like = "%" + q.trim().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
        String sql = "SELECT msg.k, msg.id, msg.role, msg.body FROM msg JOIN sess ON sess.k = msg.k WHERE msg.body LIKE ? ESCAPE '\\' ORDER BY sess.updated DESC LIMIT ?";
        String needle = q.trim().toLowerCase();
        try (Cursor c = getReadableDatabase().rawQuery(sql, new String[]{like, String.valueOf(Math.max(1, Math.min(limit, 100)))})) {
            while (c.moveToNext()) {
                String body = c.getString(3);
                int at = Math.max(0, body.toLowerCase().indexOf(needle));
                int from = Math.max(0, at - 40);
                String snip = body.substring(from, Math.min(body.length(), at + needle.length() + 80)).replace('\n', ' ');
                try {
                    out.put(new JSONObject().put("k", c.getString(0)).put("id", c.getString(1)).put("role", c.getString(2)).put("snip", (from > 0 ? "…" : "") + snip));
                } catch (Exception ignored) {}
            }
        }
        return out.toString();
    }
}
