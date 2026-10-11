package com.agentremote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// A button or the reply field of an Agent notification: forwards it to the relay without opening the app.
public class ActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        PendingResult pending = goAsync();
        Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                NotifyService.handleAction(app, intent);
            } finally {
                pending.finish();
            }
        }, "agent-remote-action").start();
    }
}
