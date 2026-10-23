package com.agentremote;

import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

// One non-exportable key per WebView origin, shared only with this app's own background listener.
final class EntryAuth {
    private static String b64(byte[] data) {
        return Base64.encodeToString(data, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }
    private static synchronized KeyStore.PrivateKeyEntry key(String app) throws Exception {
        Uri uri = Uri.parse(app);
        String origin = uri.getScheme() + "://" + uri.getAuthority();
        String alias = "ra-entry-" + b64(MessageDigest.getInstance("SHA-256").digest(origin.getBytes(StandardCharsets.UTF_8)));
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(alias)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256).build());
            generator.generateKeyPair();
        }
        return (KeyStore.PrivateKeyEntry) store.getEntry(alias, null);
    }
    static String publicKey(String app) throws Exception {
        return b64(key(app).getCertificate().getPublicKey().getEncoded());
    }
    static String sign(String app, String payload) throws Exception {
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(key(app).getPrivateKey());
        signer.update(payload.getBytes(StandardCharsets.UTF_8));
        byte[] der = signer.sign(), raw = new byte[64];
        int pos = 2;
        for (int n = 0; n < 2; n++) {
            if (der[pos++] != 2) throw new IllegalArgumentException("Invalid ECDSA signature");
            int length = der[pos++] & 255;
            int start = pos;
            while (length > 32 && der[start] == 0) { start++; length--; }
            if (length > 32) throw new IllegalArgumentException("Invalid ECDSA integer");
            System.arraycopy(der, start, raw, n * 32 + 32 - length, length);
            pos = start + length;
        }
        return b64(raw);
    }
    static String proof(JSONObject config, String method, String path) throws Exception {
        long ts = System.currentTimeMillis();
        byte[] bytes = new byte[16]; new SecureRandom().nextBytes(bytes);
        String nonce = b64(bytes);
        String payload = "ra-entry-v1\n" + config.getString("id") + "\n" + config.getString("token") + "\n" + method + " " + path + "\n" + ts + "\n" + nonce;
        JSONObject proof = new JSONObject().put("ts", ts).put("nonce", nonce).put("signature", sign(config.getString("app"), payload));
        return b64(proof.toString().getBytes(StandardCharsets.UTF_8));
    }
}
