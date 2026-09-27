// ─────────────────────────────────────────────
// StudyFetch — configuration
// ─────────────────────────────────────────────
// 1. Deploy worker.js on Cloudflare (see README.md), then paste
//    your Worker URL below, e.g.:
//    const STUDYFETCH_WORKER_URL = "https://studyfetch-resolver.yourname.workers.dev";
//    This is owner-configured only — end users have no way to change it.
// ─────────────────────────────────────────────
const STUDYFETCH_WORKER_URL = "https://studyfetch-resolver.kavyatiwari-me.workers.dev";

// Public CORS proxies used ONLY as a fallback when the Worker is
// unreachable or not configured. Each entry is a function that maps
// a target page URL → proxied fetch URL returning raw HTML.
const STUDYFETCH_FALLBACK_PROXIES = [
  (t) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(t),
  (t) => "https://corsproxy.io/?url=" + encodeURIComponent(t),
];

const STUDYFETCH_SAMPLE_URL =
  "https://www.selfstudys.com/cuet/mathematics/online/exam/notes/3-matrices";
