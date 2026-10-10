package com.agentremote;

import android.content.Context;

final class BuildConfigVersion {
    static String name(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1";
        }
    }
}
