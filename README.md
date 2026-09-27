# StudyFetch — paste a SelfStudys link, get the PDF

Static site (GitHub Pages) + tiny Cloudflare Worker resolver. Free hosting on both.
No build step, no dependencies.

```
studyfetch/
├── index.html   — UI (hero, form, result, how-it-works, FAQ, footer)
├── styles.css   — theme
├── app.js       — validation → Worker → fallback proxies → render
├── config.js    — Worker URL default + fallback list + sample link
├── worker.js    — Cloudflare Worker source (deploy separately, NOT to Pages)
├── favicon.svg
└── .nojekyll
```

## How it works

1. User pastes a `selfstudys.com` notes URL.
2. `app.js` calls your Worker: `GET <worker>/?url=<page>`.
3. The Worker fetches the page server-side, extracts the embedded
   `sitepdfs/…` PDF pointer (same one the viewer loads), and returns
   `{ ok, pdfUrl, filename, title }` as JSON.
4. The site shows a clean filename (ported from the extension's naming
   rules, e.g. `cuet_3-matrices.pdf`) with **Download / Open / Copy**.
5. If the Worker is missing/unreachable, the site falls back to public
   CORS proxies (rate-limited, best-effort).

The PDF itself is never proxied — the download button points directly at
`selfstudys.com`, so Worker bandwidth stays ~zero.

## Part 1 — Put the site on GitHub Pages (your part, ~10 min)

1. Create a **new public repo** on GitHub, e.g. `studyfetch`.
2. Upload everything in this folder **except `worker.js` and this README**
   (`index.html`, `styles.css`, `app.js`, `config.js`, `favicon.svg`, `.nojekyll`)
   to the repo root (drag-drop on github.com works).
3. Repo → **Settings → Pages** → Source: **Deploy from a branch** →
   Branch: **main**, folder **/ (root)** → Save.
4. Wait 1–2 min. Your site is live at:
   `https://<your-username>.github.io/studyfetch/`
5. Open it, paste the sample Matrices link, and confirm you at least get
   the form + fallback attempt. (Fast reliable results need Part 2.)

> Custom domain (optional): Settings → Pages → Custom domain → add your
> domain → add the shown CNAME at your DNS provider → enforce HTTPS.

## Part 2 — Create the Worker, get the Worker URL (your part, ~5 min)

The site needs this because browsers block one site from reading another
site's pages (CORS). The Worker does that read server-side.

1. Go to **https://dash.cloudflare.com** → sign up / log in (free, no card).
2. Left sidebar → **Workers & Pages** → **Create** → **Create Worker** →
   give it a name like `studyfetch-resolver` → **Deploy** (ignores starter code).
3. Click **Edit code** (or **Code**), **select-all + delete** the starter code,
   paste the **entire contents of `worker.js`** from this folder, then
   **Save and Deploy** / **Deploy**.
4. Copy the URL shown on the Worker page — it looks like:
   `https://studyfetch-resolver.<your-name>.workers.dev`
   Test it in a browser tab like this:
   `https://studyfetch-resolver.<your-name>.workers.dev/?url=https://www.selfstudys.com/cuet/mathematics/online/exam/notes/3-matrices`
   You should get JSON containing `"ok":true` and a `sitepdfs` URL.
5. **Give that URL to me** (paste it in chat). I will wire it into
   `config.js` as the default so every visitor uses it automatically.
   (Self-serve alternative: open your live site → gear **⚙ Resolver** →
   paste the Worker URL → **Save**. Stored in that browser only — fine for
   testing, but doing step 5 makes it work for everyone with zero setup.)

### Worker limits & safety (already coded)

- Only `selfstudys.com` hosts accepted; everything else → HTTP 400.
- 2 MB HTML cap, 12 s upstream timeout, 1 h edge cache.
- PDF bytes never pass through the Worker (link-only).
- Free tier ≈ 100k requests/day — plenty for this use.

## Part 3 — Verify end-to-end

1. Open `https://<you>.github.io/studyfetch/?url=<a selfstudys notes link>`.
2. Expect: spinner → green **✓ Ready** card → filename like
   `cuet_3-matrices.pdf` → **Download PDF** saves the file.
3. Click gear ⚙ → **Test** → expect "Working ✓".
4. Try one CUET link, one regular class-notes link, and one
   `…/advance-pdf-viewer` link (all three resolve to the same mechanism).

## If something breaks later

- "No PDF pointer found" on every page → SelfStudys likely changed markup.
  Update the `PATTERNS` regexes in **both** `worker.js` and `app.js`
  (search the page HTML for `sitepdfs` to find the new shape), redeploy the
  Worker (paste → Deploy), re-upload `app.js`.
- Worker URL leaked/abused → Cloudflare dashboard → Worker → delete or
  rename; update `config.js` / gear setting.

## Disclaimer

Content belongs to its owners (e.g. SelfStudys). This tool only resolves
the already-public direct file link for personal study use. Respect the
source site's terms. Not affiliated with SelfStudys.
