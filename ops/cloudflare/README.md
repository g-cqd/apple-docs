# Cloudflare configuration (Free Plan)

This is the manual companion to `Caddyfile.tpl` and the build pipeline. Every
rule below is created via the Cloudflare dashboard against the
`apple-docs.everest.mt` zone — Free Plan does not expose a Workers/KV/R2
control plane, but Cache Rules, Transform Rules, and one WAF Rate-Limit rule
are enough to make the deployment cache-friendly and security-hardened.

Apply rules in this order. Each section names the dashboard path, the
matcher, and the action. Names are suggestions — pick whatever you like, but
keep them recognisable so a future operator can spot drift.

---

## 1. Cache Rules

> Caching → Cache Rules → Create rule

Free Plan allows up to 10 cache rules. We use 8.

| # | Name | If (custom expression / path matcher) | Eligible for cache | Edge TTL | Browser TTL | Notes |
|---|---|---|---|---|---|---|
| 1 | `assets-immutable` | URI Path matches `/assets/*` | Yes | Override: 1 year | Override: 1 year | Versioned by `?v=...`, see `siteConfig.assetVersion`. |
| 2 | `worker-immutable` | URI Path matches `/worker/*` | Yes | Override: 1 year | Override: 1 year | Same lifecycle as `/assets/*`. |
| 3 | `hashed-data-immutable` | URI Path matches `/data/search/*` AND URI Path contains `.json` | Yes | Override: 1 year | Override: 1 month | Content-hashed filenames, e.g. `title-index.{10-hex}.json`. |
| 4 | `framework-data-immutable` | URI Path matches `/data/frameworks/*` | Yes | Override: 1 year | Override: 1 month | Per-framework metadata + tree.{hash}.json. |
| 5 | `docs-edge-day` | URI Path matches `/docs/*` | Yes | Override: 1 day | Override: 1 hour | Origin advertises `stale-while-revalidate=604800`. |
| 6 | `api-search-filters` | URI Path starts with `/api/search` OR URI Path starts with `/api/filters` | Yes | Respect origin | Respect origin | Origin emits `Cache-Control: public, max-age=300, stale-while-revalidate=3600`; deploy scripts purge after corpus changes. |
| 7 | `home-and-static` | URI Path matches `/` OR `/sitemap.xml` OR `/robots.txt` OR `/llms.txt` OR URI Path matches `/sitemaps/*` | Yes | Override: 5 minutes | Override: 5 minutes | Cheap to revalidate. |
| 8 | `live-no-store-bypass` | Custom expression: `http.request.uri.path in {"/healthz" "/readyz" "/data/search/search-manifest.json"} or (starts_with(http.request.uri.path, "/api/") and not starts_with(http.request.uri.path, "/api/search") and not starts_with(http.request.uri.path, "/api/filters"))` | **No — Bypass cache** | — | — | Health/readiness + dynamic API. Forces an edge bypass so a transient origin slip (e.g. a 404 without `no-store`) can't be cached and mask live status. Non-overlapping with rule 6, so order-independent. |

> Caching → Configuration → tick **Use stale while updating**.
> Caching → Configuration → tick **Always Online™**.
> Speed → Optimization → enable **Early Hints** (free, no code change required).

Rule 8 explicitly bypasses the edge cache for the live no-store paths
(`/healthz`, `/readyz`, the search manifest, and dynamic `/api/*` other than
search/filters). It is belt-and-suspenders on top of Cloudflare's default
no-store bypass: the app already emits `no-store` for these, but the explicit
rule guarantees a transient origin slip — e.g. a 404 page that forgot
`no-store`, the exact failure that made `/readyz` look stale before it was
routed to Bun — can never be cached and mask live status. Generic 404s still
rely on the default `no-store` / `no-cache` / `private` bypass.

---

## 2. Transform Rules → Modify Response Header

> Rules → Transform Rules → Modify Response Header → Create rule

Free Plan allows up to 10 modify-response-header rules. We use 5.

Each rule's matcher is `(http.host eq "apple-docs.everest.mt")` so it doesn't
leak onto the MCP subdomain. Use **Set static** unless noted.

### 2.1 `hsts`
- **Header**: `Strict-Transport-Security`
- **Value**: `max-age=63072000; includeSubDomains; preload`

### 2.2 `permissions-policy`
- **Header**: `Permissions-Policy`
- **Value**: `interest-cohort=(), browsing-topics=(), accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()`

### 2.3 `cross-origin-opener-policy`
- **Header**: `Cross-Origin-Opener-Policy`
- **Value**: `same-origin`

### 2.4 `cross-origin-resource-policy`
- **Header**: `Cross-Origin-Resource-Policy`
- **Value**: `same-origin`

The app emits its own CSP and related security headers. Use Cloudflare header
rules as edge defense-in-depth, but do not set a conflicting enforced CSP. If
you want to test a stricter edge policy, start with report-only:

### 2.5 `csp-report-only` (optional)
- **Header**: `Content-Security-Policy-Report-Only`
- **Value**:
  ```
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; manifest-src 'self'
  ```

After running for ~1 week with no violations from real traffic (check the
Security → Events tab), promote only if the value still matches the app's
HTML, inline-script hash policy, and asset paths:

### 2.5b `csp` (enforced)
- Same value as 2.5, but header name `Content-Security-Policy`.

The app's CSP includes a hash for the one inline 404-page script and keeps
JSON data blocks as `type="application/json"`, which browsers do not execute.

---

## 3. WAF Custom Rules + Rate Limiting

> Security → WAF → Custom rules → Create rule

Free Plan allows up to 5 custom rules and 1 rate-limiting rule.

### 3.1 Rate limit `/api/search` (rate-limiting tab)
- **If**: URI Path equals `/api/search`
- **Then**: Block (or Managed Challenge) when more than **60 requests in 60 seconds** from the same IP.
- **Mitigation timeout**: 60 seconds.

This protects the only public high-frequency path that touches the SQLite
query plan before the edge cache is warm. HTML, sitemaps, search artifacts,
and repeated search/filter responses are CDN-cached after warmup.

### 3.2 (Optional) Custom rule `block-empty-ua`
- **If**: HTTP User-Agent contains the empty string (i.e. UA is missing) AND URI Path does not start with `/healthz` AND URI Path does not start with `/readyz`
- **Then**: Block.

Both probe paths are exempt because load balancers and uptime checks often
send no `User-Agent`; without the `/readyz` carve-out this rule would block
readiness probes.

Most legitimate crawlers identify themselves; this is a cheap floor that
costs nothing under normal traffic.

---

## 4. Bot management notes

The operator chose to **welcome AI bots** (see `/robots.txt` content-signals:
`search=yes, ai-input=yes, ai-train=yes` and `/llms.txt`). On Free Plan we
therefore **leave Bot Fight Mode off** — turning it on would auto-challenge
GPTBot / ClaudeBot / PerplexityBot etc. and contradict the policy.

If the corpus ever needs throttling per-bot:
- Add a Custom Rule matching the relevant `cf.client.bot` or `User-Agent`
  predicate and apply Managed Challenge.
- Or add a CF Worker (paid plan) that classifies and rate-limits.

---

## 5. Verification

After applying every rule, run:

```sh
# Headers
curl -sI https://apple-docs.everest.mt/                | grep -iE 'strict-transport|permissions-policy|cross-origin|content-security|cache-control|cf-cache-status'
curl -sI https://apple-docs.everest.mt/assets/style.css?v=test | grep -iE 'cache-control|cf-cache-status'
curl -sI https://apple-docs.everest.mt/docs/swiftui/view/ | grep -iE 'cache-control|cf-cache-status'

# Health/readiness must reach the origin live and never cache
# (expect cf-cache-status: DYNAMIC or BYPASS, Cache-Control: no-store)
curl -sI https://apple-docs.everest.mt/readyz  | grep -iE 'cache-control|cf-cache-status'
curl -s  https://apple-docs.everest.mt/readyz  # live JSON: {"ok":...,"db":...,"readerPool":...}

# Sitemap discovery
curl -s https://apple-docs.everest.mt/sitemap.xml | head
curl -s https://apple-docs.everest.mt/sitemaps/swiftui.xml.gz | gunzip | head -10
curl -s https://apple-docs.everest.mt/robots.txt
curl -s https://apple-docs.everest.mt/llms.txt
curl -s https://apple-docs.everest.mt/.well-known/security.txt

# Cache HIT after warmup (run twice)
for i in 1 2; do
  curl -sI https://apple-docs.everest.mt/docs/swiftui/ | grep cf-cache-status
done

# CSP violations (after week-1 of report-only)
# Open dashboard → Security → Events → filter for action = "report"
```

External grading:
- `https://securityheaders.com/?q=apple-docs.everest.mt` — target grade A
- `https://www.ssllabs.com/ssltest/analyze.html?d=apple-docs.everest.mt` — target A+
- Submit the sitemap-index to Google Search Console and Bing Webmaster Tools.
