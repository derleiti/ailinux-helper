package me.ailinux.workspace;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Stores workspace credentials encrypted with a non-exportable AndroidKeyStore key. */
final class SecureCredentialStore {
    private static final String PREFS = "workspace_credentials_secure";
    private static final String KEY_ALIAS = "ailinux_workspace_credentials_v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private final SharedPreferences prefs;

    SecureCredentialStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized void put(String name, String value) {
        String normalized = value == null ? "" : value;
        if (normalized.isEmpty()) {
            remove(name);
            return;
        }
        try {
            SecretKey key = getOrCreateKey();
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] ciphertext = cipher.doFinal(normalized.getBytes(StandardCharsets.UTF_8));
            String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
            String body = Base64.encodeToString(ciphertext, Base64.NO_WRAP);
            if (!prefs.edit().putString(name + ".iv", iv).putString(name + ".ct", body).commit()) {
                throw new IllegalStateException("secure credential commit failed");
            }
        } catch (Exception e) {
            throw new IllegalStateException("secure credential write failed", e);
        }
    }

    synchronized String get(String name) {
        String iv = prefs.getString(name + ".iv", "");
        String body = prefs.getString(name + ".ct", "");
        if (iv == null || body == null || iv.isEmpty() || body.isEmpty()) return "";
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            java.security.Key key = ks.getKey(KEY_ALIAS, null);
            if (!(key instanceof SecretKey)) throw new IllegalStateException("credential key unavailable");
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, (SecretKey) key,
                new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            byte[] clear = cipher.doFinal(Base64.decode(body, Base64.NO_WRAP));
            return new String(clear, StandardCharsets.UTF_8);
        } catch (Exception e) {
            // Fail closed: never return ciphertext, stale plaintext, or a guessed value.
            return "";
        }
    }

    synchronized void remove(String name) {
        if (!prefs.edit().remove(name + ".iv").remove(name + ".ct").commit()) {
            throw new IllegalStateException("secure credential removal failed");
        }
    }

    synchronized void clear() {
        if (!prefs.edit().clear().commit()) {
            throw new IllegalStateException("secure credential clear failed");
        }
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        java.security.Key existing = ks.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }
}
