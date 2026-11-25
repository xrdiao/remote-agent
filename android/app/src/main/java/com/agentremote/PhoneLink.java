package com.agentremote;

import java.util.LinkedHashMap;

import okhttp3.WebSocket;

// Control and upload sockets share a lifecycle. Actions belong to one control generation.
final class PhoneLink {
    volatile WebSocket control, media;
    int generation;
    private long lastAction;
    private Action pending;
    private final LinkedHashMap<Long, String> replies = new LinkedHashMap<>();

    record Action(int generation, long id) {}

    boolean current(WebSocket socket, boolean video, int expected) {
        return generation == expected && socket == (video ? media : control);
    }

    Action begin(long id) {
        if (id <= lastAction) return null;
        lastAction = id;
        if (pending != null) return null;
        return pending = new Action(generation, id);
    }

    boolean isPending(long id) { return pending != null && pending.id == id; }

    String reply(long id) { return replies.get(id); }

    boolean finish(Action action, String reply) {
        if (pending != action || action.generation != generation) return false;
        pending = null;
        replies.put(action.id, reply);
        if (replies.size() > 32) replies.remove(replies.keySet().iterator().next());
        return true;
    }

    void abandonAction() { pending = null; }

    void close() {
        generation++;
        abandonAction();
        lastAction = 0;
        replies.clear();
        WebSocket host = control, video = media;
        control = null;
        media = null;
        if (host != null) host.close(1000, null);
        if (video != null) video.close(1000, null);
    }
}
