package com.cursorremote.lite;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// Restarts the notification listener after a reboot or an app update.
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        NotifyService.start(c);
    }
}
