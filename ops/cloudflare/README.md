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

Free Plan allows up to 10 cache rules. We use 6.

| # | Name | If (custom expression / path matcher) | Eligible for cache | Edge TTL | Browser TTL | Notes |
|---|---|---|---|---|---|---|
| 1 | `assets-immutable` | URI Path matches `/assets/*` | Yes | Override: 1 year | Override: 1 year | Versioned by `?v=…`, see `siteConfig.assetVersion`. |
| 2 | `worker-immutable` | URI Path matches `/worker/*` | Yes | Override: 1 year | Override: 1 year | Same lifecycle as `/assets/*`. |
| 3 | `hashed-data-immutable` | URI Path matches `/data/search/*` AND URI Path contains `.json` | Yes | Override: 1 year | Override: 1 month | Content-hashed filenames, e.g. `title-index.{10-hex}.json`. |
| 4 | `framework-data-immutable` | URI Path matches `/data/frameworks/*` | Yes | Override: 1 year | Override: 1 month | Per-framework metadata + (Phase 5) tree.{hash}.json. |
| 5 | `docs-edge-day` | URI Path matches `/docs/*` | Yes | Override: 1 day | Override: 1 hour | Origin advertises `stale-while-revalidate=604800`. |
| 6 | `home-and-static` | URI Path matches `/` OR `/sitemap.xml` OR `/robots.txt` OR `/llms.txt` OR URI Path matches `/sitemaps/*` | Yes | Override: 5 minutes | Override: 5 minutes | Cheap to revalidate. |

> Caching → Configuration → tick **Use stale while updating**.
> Caching → Configuration → tick **Always Online™**.
> Speed → Optimization → enable **Early Hints** (free, no code change required).

`/api/*`, `/healthz`, `/data/search/search-manifest.json`, and 404s should
**not** be cached. Cloudflare's default behavior is to bypass caching when
the response carries `Cache-Control: no-cache` or `private`, which `serve.js`
already emits for these paths — no rule needed.

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

### 2.5 `csp-report-only` (start here, then promote to enforced)
- **Header**: `Content-Security-Policy-Report-Only`
- **Value**:
  ```
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; manifest-src 'self'
  ```

After running for ~1 week with no violations from real traffic (check the
Security → Events tab), retire rule 2.5 and create:

### 2.5b `csp` (enforced)
- Same value as 2.5, but header name `Content-Security-Policy`.

The CSP is achievable as-is because:
- All `<script>` tags use `src=` (no inline JS); see `src/web/templates.js`.
- The framework page emits `<script type="application/json" id="tree-data">`,
  which is data, not code — browsers do not execute it.
- No inline `<style>` blocks; the only stylesheet is `/assets/style.css`.
- SVG icons in the header are inlined as `<svg>` markup, which CSP does not
  intercept.

---

## 3. WAF Custom Rules + Rate Limiting

> Security → WAF → Custom rules → Create rule

Free Plan allows up to 5 custom rules and 1 rate-limiting rule.

### 3.1 Rate limit `/api/search` (rate-limiting tab)
- **If**: URI Path equals `/api/search`
- **Then**: Block (or Managed Challenge) when more than **60 requests in 60 seconds** from the same IP.
- **Mitigation timeout**: 60 seconds.

This protects the only Bun-served path that touches the SQLite query plan.
HTML, sitemaps, and the title-index are all CDN-cached after warmup, so the
rest of the site is effectively free under traffic spikes.

### 3.2 (Optional) Custom rule `block-empty-ua`
- **If**: HTTP User-Agent contains the empty string (i.e. UA is missing) AND URI Path does not start with `/healthz`
- **Then**: Block.

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
