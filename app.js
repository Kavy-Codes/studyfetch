/* StudyFetch frontend — resolve a SelfStudys page URL → direct PDF link.
 * Flow: validate → Worker (primary) → public CORS proxies (fallback)
 *        → extract sitepdfs token client-side → render result.
 * The PDF itself is never proxied: the download button links straight
 * to selfstudys.com, which needs no CORS for navigation/download. */
(function () {
  "use strict";

  var DEFAULT_WORKER =
    (typeof STUDYFETCH_WORKER_URL === "string" && STUDYFETCH_WORKER_URL.trim()) || "";
  var FALLBACKS =
    (typeof STUDYFETCH_FALLBACK_PROXIES !== "undefined" && STUDYFETCH_FALLBACK_PROXIES) || [];
  var SAMPLE =
    (typeof STUDYFETCH_SAMPLE_URL === "string" && STUDYFETCH_SAMPLE_URL) ||
    "https://www.selfstudys.com/cuet/mathematics/online/exam/notes/3-matrices";

  var LS_HISTORY = "studyfetch.history";

  // ── DOM ──
  function $(id) { return document.getElementById(id); }
  var form = $("fetchForm"), input = $("urlInput"), clearBtn = $("clearBtn");
  var pasteBtn = $("pasteBtn"), submitBtn = $("submitBtn"), submitLabel = $("submitLabel");
  var sampleBtn = $("sampleBtn");
  var statusCard = $("statusCard"), statusTitle = $("statusTitle"), statusDetail = $("statusDetail");
  var errorCard = $("errorCard"), errorTitle = $("errorTitle"), errorDetail = $("errorDetail");
  var retryBtn = $("retryBtn"), openOriginalBtn = $("openOriginalBtn");
  var resultCard = $("resultCard"), fileName = $("fileName"), fileSub = $("fileSub");
  var downloadBtn = $("downloadBtn"), openPdfBtn = $("openPdfBtn"), copyBtn = $("copyBtn");
  var historySection = $("historySection"), historyList = $("historyList"), clearHistoryBtn = $("clearHistoryBtn");

  function workerUrl() {
    return DEFAULT_WORKER ? DEFAULT_WORKER.replace(/\/+$/, "") : "";
  }

  // ── Validation ──
  function normalizePageUrl(raw) {
    var s = (raw || "").trim();
    if (!s) return { error: "Please paste a link first." };
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    var u;
    try { u = new URL(s); } catch (e) { return { error: "That doesn't look like a valid URL." }; }
    var host = u.hostname.toLowerCase();
    if (host !== "selfstudys.com" && host !== "www.selfstudys.com") {
      return { error: "Only selfstudys.com page links are supported." };
    }
    // /advance-pdf-viewer serves the same file; canonicalise to parent.
    u.pathname = u.pathname.replace(/\/advance-pdf-viewer\/?$/, "");
    u.hash = "";
    return { url: u.toString() };
  }

  // ── Extraction (mirrors worker.js patterns) ──
  var PATTERNS = [
    /source="(https:\/\/www\.selfstudys\.com\/sitepdfs\/[^"]+)"/i,
    /pdf_path:\s*"(https:\/\/www\.selfstudys\.com\/sitepdfs\/[^"]+)"/i,
    /var\s+pdfPath\s*=\s*"(https:\/\/www\.selfstudys\.com\/sitepdfs\/[^"]+)"/i,
    /downloadFile\("(https:\/\/www\.selfstudys\.com\/sitepdfs\/[^"]+)"\)/i,
    /"(https:\/\/www\.selfstudys\.com\/sitepdfs\/[A-Za-z0-9_\-]+)"/i,
    /(https:\/\/www\.selfstudys\.com\/sitepdfs\/[A-Za-z0-9_\-]+)/i
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
      var path = new URL(pageUrl).pathname;
      var segs = path.split("/").filter(Boolean);
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

  // ── Resolver ──
  function fetchWithTimeout(url, ms) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms || 20000);
    return fetch(url, { signal: ctrl.signal }).finally(function () { clearTimeout(t); });
  }

  function resolveViaWorker(pageUrl) {
    var w = workerUrl();
    if (!w) return Promise.reject(new Error("NO_WORKER"));
    return fetchWithTimeout(w + "/?url=" + encodeURIComponent(pageUrl), 25000).then(function (r) {
      if (!r.ok) throw new Error("Worker responded " + r.status);
      return r.json();
    }).then(function (data) {
      if (!data || !data.ok || !data.pdfUrl) {
        throw new Error((data && data.error) || "Resolver found no PDF on that page.");
      }
      return { pdfUrl: data.pdfUrl, title: data.title || "", via: "worker" };
    });
  }

  function resolveViaFallback(pageUrl, onStep) {
    var seq = Promise.reject(new Error("no-fallback-yet"));
    FALLBACKS.forEach(function (build, idx) {
      seq = seq.catch(function () {
        onStep("Trying alternative route…");
        return fetchWithTimeout(build(pageUrl), 25000).then(function (r) {
          if (!r.ok) throw new Error("Fallback " + (idx + 1) + " responded " + r.status);
          return r.text();
        }).then(function (html) {
          if (!/sitepdfs/i.test(html)) throw new Error("Fallback " + (idx + 1) + " returned no PDF pointer.");
          var pdf = extractPdfUrl(html);
          if (!pdf) throw new Error("Could not find the PDF link in that page.");
          return { pdfUrl: pdf, title: extractTitle(html), via: "fallback-" + (idx + 1) };
        });
      });
    });
    return seq;
  }

  // ── UI state ──
  function hideAll() {
    statusCard.hidden = true; errorCard.hidden = true; resultCard.hidden = true;
  }
  function showStatus(title, detail) {
    hideAll(); statusCard.hidden = false;
    statusTitle.textContent = title; statusDetail.textContent = detail || "";
    submitBtn.disabled = true; submitLabel.textContent = "Working…";
  }
  function showError(title, detail, pageUrl) {
    hideAll(); errorCard.hidden = false;
    errorTitle.textContent = title; errorDetail.textContent = detail || "";
    try { openOriginalBtn.href = pageUrl || input.value.trim(); } catch (e) {}
    submitBtn.disabled = false; submitLabel.textContent = "Get PDF →";
  }
  function showResult(pageUrl, pdfUrl, filename, title) {
    hideAll(); resultCard.hidden = false;
    fileName.textContent = filename;
    fileSub.textContent = title
      ? (title.length > 80 ? title.slice(0, 80) + "…" : title)
      : "Direct PDF link ready";
    downloadBtn.href = pdfUrl;
    downloadBtn.setAttribute("download", filename);
    openPdfBtn.href = pdfUrl;
    copyBtn.textContent = "⧉ Copy link";
    submitBtn.disabled = false; submitLabel.textContent = "Get PDF →";
    // Shareable URL
    try {
      var u = new URL(window.location.href);
      u.searchParams.set("url", pageUrl);
      window.history.replaceState(null, "", u.toString());
    } catch (e) {}
    pushHistory(pageUrl, filename);
    resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  var lastRequest = null;
  function resolve(pageUrl) {
    lastRequest = pageUrl;
    showStatus("Resolving…", "Reading the notes page…");
    resolveViaWorker(pageUrl).then(function (res) {
      if (lastRequest !== pageUrl) return;
      finishResolve(pageUrl, res);
    }).catch(function (wErr) {
      if (lastRequest !== pageUrl) return;
      if (wErr && wErr.message === "NO_WORKER") {
        showError("Resolver not configured", "The site owner hasn't set a resolver yet. Please try again later.", pageUrl);
        return;
      }
      showStatus("Resolving…", "Trying alternative route…");
      resolveViaFallback(pageUrl, function (step) {
        showStatus("Resolving…", step);
      }).then(function (res) {
        if (lastRequest !== pageUrl) return;
        finishResolve(pageUrl, res);
      }).catch(function (fErr) {
        if (lastRequest !== pageUrl) return;
        var msg = (fErr && fErr.message) || "Unknown error.";
        showError(
          "Couldn't resolve that link",
          msg + " Make sure it's a notes page that loads without login, then hit Retry.",
          pageUrl
        );
      });
    });
  }

  function finishResolve(pageUrl, res) {
    var filename = deriveFilename(pageUrl, res.title);
    showResult(pageUrl, res.pdfUrl, filename, res.title);
  }

  // ── History ──
  function getHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HISTORY) || "[]"); }
    catch (e) { return []; }
  }
  function pushHistory(pageUrl, filename) {
    try {
      var h = getHistory().filter(function (x) { return x.url !== pageUrl; });
      h.unshift({ url: pageUrl, name: filename, at: Date.now() });
      localStorage.setItem(LS_HISTORY, JSON.stringify(h.slice(0, 5)));
      renderHistory();
    } catch (e) {}
  }
  function renderHistory() {
    var h = getHistory();
    historySection.hidden = h.length === 0;
    historyList.innerHTML = "";
    h.forEach(function (item) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "./?url=" + encodeURIComponent(item.url);
      a.textContent = item.name;
      a.title = item.url;
      var again = document.createElement("button");
      again.className = "ghost-btn"; again.textContent = "↻";
      again.title = "Resolve again";
      again.onclick = function () { input.value = item.url; syncClear(); resolve(item.url); };
      li.appendChild(a); li.appendChild(again);
      historyList.appendChild(li);
    });
  }

  // ── Events ──
  function syncClear() { clearBtn.hidden = !input.value; }
  input.addEventListener("input", syncClear);
  clearBtn.addEventListener("click", function () {
    input.value = ""; syncClear(); input.focus();
    try {
      var u = new URL(window.location.href);
      u.searchParams.delete("url");
      window.history.replaceState(null, "", u.pathname + u.search);
    } catch (e) {}
  });
  pasteBtn.addEventListener("click", function () {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (t) {
        if (t) { input.value = t.trim(); syncClear(); }
        input.focus();
      }).catch(function () { input.focus(); });
    } else input.focus();
  });
  sampleBtn.addEventListener("click", function () {
    input.value = SAMPLE; syncClear();
    resolve(SAMPLE);
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var n = normalizePageUrl(input.value);
    if (n.error) { showError("Check the link", n.error + " It should look like https://www.selfstudys.com/…"); return; }
    input.value = n.url; syncClear();
    resolve(n.url);
  });
  retryBtn.addEventListener("click", function () {
    var n = normalizePageUrl(input.value);
    if (!n.error) resolve(n.url);
  });
  copyBtn.addEventListener("click", function () {
    var link = openPdfBtn.href;
    function done() { copyBtn.textContent = "✓ Copied"; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done).catch(function () { fallbackCopy(link); done(); });
    } else { fallbackCopy(link); done(); }
  });
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta);
    ta.select(); try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }

  // ── Init ──
  renderHistory();
  syncClear();

  // Shared ?url= links prefill the input but NEVER auto-resolve —
  // the user always presses the button explicitly.
  try {
    var q = new URL(window.location.href).searchParams.get("url");
    if (q) {
      var n = normalizePageUrl(q);
      input.value = n.error ? q : n.url;
      syncClear();
    }
  } catch (e) {}
})();
