package app.chax.mesh;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Runs the very same JavaScript mesh node as the visible app, in a WebView that has no window. It is alive
 * only while the Activity is not: it shares localStorage and IndexedDB with the page (same origin), so history,
 * identity and encryption sessions carry over both ways. Page assets are served from the APK as https://localhost.
 */
@SuppressLint({ "SetJavaScriptEnabled", "AddJavascriptInterface" })
final class HeadlessHost implements BleEngine.Sink {
    private static final String ORIGIN = "https://localhost";

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<String> pending = new ArrayList<>(); // scripts waiting for the page to say it is ready
    private WebView web;
    private boolean ready;

    HeadlessHost(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    void start() {
        main.post(() -> {
            if (web != null) return;
            ready = false;
            web = new WebView(ctx);
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setMediaPlaybackRequiresUserGesture(true);
            web.addJavascriptInterface(new Bridge(), "ChaxNative");
            web.setWebViewClient(new WebViewClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                    return asset(r);
                }
            });
            web.onResume();
            web.loadUrl(ORIGIN + "/headless.html");
            BleEngine.get(ctx).setSink(this);
        });
    }

    void stop() {
        main.post(() -> {
            BleEngine.get(ctx).setSink(null);
            if (web == null) return;
            try {
                web.stopLoading();
                web.removeJavascriptInterface("ChaxNative");
                web.destroy();
            } catch (Exception ignored) {}
            web = null;
            ready = false;
            pending.clear();
        });
    }

    // ---- radio -> page --------------------------------------------------------------

    private void call(String script) {
        main.post(() -> {
            if (web == null) return;
            if (!ready) {
                if (pending.size() < 500) pending.add(script);
                return;
            }
            web.evaluateJavascript(script, null);
        });
    }

    @Override
    public void linkUp(String link) {
        call("window.__chax&&window.__chax.up(" + JSONObject.quote(link) + ")");
    }

    @Override
    public void linkDown(String link) {
        call("window.__chax&&window.__chax.down(" + JSONObject.quote(link) + ")");
    }

    @Override
    public void frame(String link, byte[] data) {
        call("window.__chax&&window.__chax.frame(" + JSONObject.quote(link) + ",'" + Base64.encodeToString(data, Base64.NO_WRAP) + "')");
    }

    @Override
    public void state(String message) {
        call("window.__chax&&window.__chax.error(" + JSONObject.quote(message) + ")");
    }

    // ---- page -> native --------------------------------------------------------------

    private final class Bridge {
        /** The page installed its handlers: deliver what the radio said meanwhile. */
        @JavascriptInterface
        public void ready() {
            main.post(() -> {
                if (web == null) return;
                ready = true;
                for (String s : pending) web.evaluateJavascript(s, null);
                pending.clear();
            });
        }

        @JavascriptInterface
        public boolean send(String link, String base64) {
            return BleEngine.get(ctx).send(link, Base64.decode(base64, Base64.NO_WRAP));
        }

        @JavascriptInterface
        public void notify(String key, String title, String body, boolean alert) {
            Notifier.post(ctx, key, title, body, alert);
        }

        @JavascriptInterface
        public void log(String line) {
            android.util.Log.i("ChaxHeadless", line);
        }
    }

    // ---- assets ----------------------------------------------------------------------

    private WebResourceResponse asset(WebResourceRequest r) {
        if (!"https".equals(r.getUrl().getScheme()) || !"localhost".equals(r.getUrl().getHost())) return null;
        String path = r.getUrl().getPath();
        if (path == null || path.equals("/")) path = "/headless.html";
        try {
            InputStream in = ctx.getAssets().open("public" + path);
            return new WebResourceResponse(mime(path), "utf-8", in);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, new ByteArrayInputStream(new byte[0]));
        }
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json") || path.endsWith(".webmanifest")) return "application/json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }
}
