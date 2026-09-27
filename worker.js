/* ─────────────────────────────────────────────────────────────
 * StudyFetch resolver — Cloudflare Worker
 * ─────────────────────────────────────────────────────────────
 * Paste this ENTIRE file into a Cloudflare Worker (see README.md),
 * deploy, and copy the https://<name>.<you>.workers.dev URL into
 * the StudyFetch site (config.js or the gear menu).
 *
 * What it does:
 *   GET /?url=<selfstudys page url>
 *     → validates host is selfstudys.com (abuse protection)
 *     → fetches the page server-side (no CORS problem)
 *     → extracts the embedded sitepdfs/… PDF pointer
 *     → returns JSON { ok, pdfUrl, filename, title, source }
 *
 * It NEVER proxies PDF bytes — the frontend links straight to
 * selfstudys.com, so Worker bandwidth stays near zero (free tier).
 * ───────────────────────────────────────────────────────────── */

var ALLOWED_HOSTS = ["selfstudys.com", "www.selfstudys.com"];
var MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB cap
var FETCH_TIMEOUT_MS = 12000;
var CACHE_TTL_SECONDS = 3600;

var PATTERNS = [
  /source="(https:\/\/www\.selfstudys\.com\/sitepdfs\/[^"]+)"/i,
  /pdf_path:\s*"(https:\/\/www\.selfstudys\.com\/sitepdfs\/[^"]+)"/i,
  /var\s+pdfPath\s*=\s*"(https:\/\/www\.selfstudys\.com\/sitepdfs\/[^"]+)"/i,
  /downloadFile\("(https:\/\/www\.selfstudys\.com\/sitepdfs\/[^"]+)"\)/i,
  /"(https:\/\/www\.selfstudys\.com\/sitepdfs\/[A-Za-z0-9_\-]+)"/i,
  /(https:\/\/www\.selfstudys\.com\/sitepdfs\/[A-Za-z0-9_\-]+)/i,
];

function extractPdfUrl(html) {
  for (var i = 0; i < PATTERNS.length; i++) {
    var m = html.match(PATTERNS[i]);
    if (m) return m[1] || m[0];
  }
  return null;
}

function extractTitle(html) {
  var m = html.match(/<title>([^<]{4,200})<\/title>/i);
  return m ? m[1].trim() : "";
}

// Port of the extension's background.js naming rules.
function deriveFilename(pageUrl, title) {
  try {
    var segs = new URL(pageUrl).pathname.split("/").filter(Boolean);
    var name = "selfstudy_document";
    if (segs.indexOf("cuet") !== -1) {
      var ni = segs.indexOf("notes");
      if (ni !== -1 && segs[ni + 1]) name = "cuet_" + segs.slice(ni + 1).join("_");
      else name = "cuet_" + (segs[1] || "exam") + "_" + (segs[segs.length - 1] || "notes");
    } else {
      var ci = -1;
      for (var i = 0; i < segs.length; i++) {
        if (segs[i].indexOf("class-") === 0) { ci = i; break; }
      }
      if (ci !== -1 && segs[ci + 2]) name = segs[ci] + "_" + segs[ci + 1] + "_" + segs[ci + 2];
      else if (segs.length >= 2) name = segs[segs.length - 2] + "_" + segs[segs.length - 1];
      else if (segs.length === 1) name = segs[0];
      else if (title) name = title;
    }
    name = name.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9\-_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    return (name || "selfstudy_document").slice(0, 120) + ".pdf";
  } catch (e) {
    return "selfstudy_document.pdf";
  }
}

function json(data, status, cacheSeconds) {
  var headers = {
    "content-type": "application/json;charset=UTF-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-max-age": "86400",
  };
  if (cacheSeconds) headers["cache-control"] = "public, max-age=" + cacheSeconds;
  else headers["cache-control"] = "no-store";
  return new Response(JSON.stringify(data), { status: status || 200, headers: headers });
}

function fetchWithTimeout(url, ms) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, ms);
  return fetch(url, {
    signal: ctrl.signal,
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-IN,en;q=0.9",
    },
  }).finally(function () { clearTimeout(timer); });
}

export default {
  async fetch(request, env, ctx) {
    var origin = new URL(request.url).origin;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }
    if (request.method !== "GET") {
      return json({ ok: false, error: "Use GET /?url=<selfstudys page URL>." }, 405);
    }

    var target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return json(
        { ok: true, service: "studyfetch-resolver", usage: "GET /?url=https://www.selfstudys.com/…/notes/…" },
        200
      );
    }

    var pageUrl;
    try {
      pageUrl = new URL(target);
    } catch (e) {
      return json({ ok: false, error: "Invalid url parameter." }, 400);
    }
    if (pageUrl.protocol !== "https:" && pageUrl.protocol !== "http:") {
      return json({ ok: false, error: "URL must be http(s)." }, 400);
    }
    if (ALLOWED_HOSTS.indexOf(pageUrl.hostname.toLowerCase()) === -1) {
      return json({ ok: false, error: "Only selfstudys.com page links are supported." }, 400);
    }
    // Canonicalise HD-viewer URLs to their parent (same file either way).
    pageUrl.pathname = pageUrl.pathname.replace(/\/advance-pdf-viewer\/?$/, "");
    pageUrl.hash = "";

    // Serve cached resolutions to cut load + latency.
    var cacheKey = new Request(origin + "/resolve?url=" + encodeURIComponent(pageUrl.toString()));
    try {
      var cache = caches.default;
      var hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (e) {}

    var html;
    try {
      var upstream = await fetchWithTimeout(pageUrl.toString(), FETCH_TIMEOUT_MS);
      if (!upstream.ok) {
        return json({ ok: false, error: "Source page responded " + upstream.status + "." }, 502);
      }
      var ct = upstream.headers.get("content-type") || "";
      if (ct && ct.indexOf("text/html") === -1) {
        return json({ ok: false, error: "That URL did not return a notes page." }, 502);
      }
      var buf = new Uint8Array(await upstream.arrayBuffer());
      if (buf.length > MAX_HTML_BYTES) {
        return json({ ok: false, error: "Source page too large." }, 502);
      }
      html = new TextDecoder("utf-8").decode(buf);
    } catch (e) {
      var reason = e && e.name === "AbortError" ? "Source page timed out." : "Could not fetch the source page.";
      return json({ ok: false, error: reason }, 502);
    }

    var pdfUrl = extractPdfUrl(html);
    if (!pdfUrl) {
      return json(
        { ok: false, error: "No PDF pointer found on that page. Is it a notes/document page that loads without login?" },
        422
      );
    }
    var title = extractTitle(html);
    var res = json(
      { ok: true, pdfUrl: pdfUrl, filename: deriveFilename(pageUrl.toString(), title), title: title, source: "sitepdfs" },
      200,
      CACHE_TTL_SECONDS
    );
    try {
      ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
    } catch (e) {}
    return res;
  },
};
