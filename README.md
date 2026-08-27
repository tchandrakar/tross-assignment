# LinkedIn Profile API

A hosted HTTPS API that accepts a LinkedIn profile URL and returns the profile as structured JSON — name, headline, location, about, experience, education, skills, certifications, languages, images and more.

Data is read from LinkedIn's internal **Voyager API** (the same endpoints linkedin.com's own single-page app calls), not by parsing rendered HTML.

```bash
curl "https://<host>/v1/profile?url=https://www.linkedin.com/in/williamhgates/"
```

**Live:** `<DEPLOYED_URL>` · **Interactive docs:** `<DEPLOYED_URL>/docs` · **Health:** `<DEPLOYED_URL>/health`

---

## Contents

- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API documentation](#api-documentation)
- [Approach](#approach)
- [Design decisions](#design-decisions)
- [Deployment](#deployment)
- [Known limitations](#known-limitations)
- [Legal](#legal)

---

## Quick start

**Requirements:** Node.js ≥ 20 (developed on 25), and a LinkedIn account you're willing to use for the session cookie.

```bash
git clone https://github.com/tchandrakar/tross-assignment.git
cd tross-assignment
npm install
cp .env.example .env
```

Then fill in `LI_AT` and `LI_JSESSIONID` (see below) and run:

```bash
npm run dev
```

The API is on `http://localhost:8080`, with interactive docs at `http://localhost:8080/docs`.

```bash
npm test          # 86 unit tests, no network access required
npm run typecheck # strict tsc
npm run build     # compile to dist/
```

### Getting the session cookies

The API authenticates as a logged-in LinkedIn member. Two cookies are needed:

1. Log in to `linkedin.com` in a browser.
2. Open DevTools → **Application** → **Cookies** → `https://www.linkedin.com`.
3. Copy two values:

| Cookie | Looks like | Used as |
|---|---|---|
| `li_at` | `AQEDAS8...` (long opaque string) | The session itself |
| `JSESSIONID` | `"ajax:1234567890123456789"` | The CSRF token — **strip the surrounding quotes** |

```bash
LI_AT=AQEDAS8...
LI_JSESSIONID=ajax:1234567890123456789
```

`li_at` is a bearer credential for the entire account. Treat it exactly like a password: it is never committed, never logged (the logger redacts `cookie` headers), and in production it lives in Secret Manager rather than in the service config.

---

## Configuration

Every option is in [`.env.example`](.env.example). The ones that matter:

| Variable | Default | Purpose |
|---|---|---|
| `LINKEDIN_IDENTITIES` | — | JSON array of `{label, liAt, jsessionId, proxy?}`. The multi-account form. |
| `LI_AT` / `LI_JSESSIONID` | — | Single-account shorthand, used only when `LINKEDIN_IDENTITIES` is empty. |
| `PROXY_URLS` | — | Comma-separated proxy URLs, assigned round-robin to identities. |
| `PROXY_STICKY_TEMPLATE` | — | Proxy URL template with `{session}` for sticky-session providers. |
| `GCS_BUCKET` | — | Blob-storage cache bucket. Falls back to an in-process LRU when unset. |
| `CACHE_TTL_SECONDS` | `604800` (7d) | How long a cached profile is served before re-scraping. `0` = never expire. |
| `SCRAPE_RATE_PER_MINUTE` | `5` | **Hard ceiling** on live LinkedIn fetches per minute. |
| `API_KEYS` | — | Comma-separated keys required as `x-api-key`. Unauthenticated when empty. |
| `ENABLE_BROWSER_FALLBACK` | `true` | Whether to fall back to headless Chromium when Voyager is blocked. |

---

## API documentation

Interactive OpenAPI docs are served at **`/docs`**, and the raw spec at **`/docs/json`**. The spec is generated from the same Zod schemas the code validates against, so it cannot drift from the implementation.

### `GET /v1/profile`

| Parameter | In | Required | Description |
|---|---|---|---|
| `url` | query | yes | A LinkedIn profile URL, or a bare vanity name. |
| `refresh` | query | no | `true` bypasses the cache and forces a live scrape. |

All of these resolve to the same profile:

```
https://www.linkedin.com/in/williamhgates/
https://linkedin.com/in/williamhgates
https://in.linkedin.com/in/williamhgates?originalSubdomain=in
www.linkedin.com/in/williamhgates/en
williamhgates
```

`/company/…` and `/school/…` URLs are rejected with `400` rather than silently misinterpreted.

### `POST /v1/profile`

```json
{ "url": "https://www.linkedin.com/in/williamhgates/", "refresh": false }
```

### `DELETE /v1/profile/{publicId}/cache`

Evicts one cached profile. Returns `{ "success": true, "evicted": true|false }`.

### `GET /health`

Unauthenticated. Reports identity-pool state, cache reachability and remaining scrape budget — without exposing cookies or proxy credentials.

### `GET /healthz`

Liveness only. Deliberately touches no dependency, so an upstream block can never cause the platform to recycle a healthy container.

### Response

```jsonc
{
  "success": true,
  "data": {
    "publicId": "williamhgates",
    "profileUrl": "https://www.linkedin.com/in/williamhgates/",
    "urn": "urn:li:fs_profile:ACoAAA8BYqEB...",

    "firstName": "Bill",
    "lastName": "Gates",
    "fullName": "Bill Gates",
    "headline": "Co-chair, Bill & Melinda Gates Foundation",
    "about": "Co-chair of the Bill & Melinda Gates Foundation…",
    "location": {
      "full": "Seattle, Washington, United States",
      "city": "Seattle",
      "country": "United States",
      "countryCode": "US"
    },
    "industry": "Philanthropy",
    "pronouns": null,

    "connectionCount": 500,
    "followerCount": 36000000,
    "isPremium": true,
    "isInfluencer": true,
    "isOpenToWork": false,
    "isHiring": false,

    "profilePicture": {
      "url": "https://media.licdn.com/dms/image/…/profile.jpg",
      "width": 800, "height": 800,
      "expiresAt": "2026-09-24T00:00:00.000Z"
    },
    "backgroundImage": { "…": "same shape" },

    "experience": [
      {
        "title": "Co-chair",
        "employmentType": "Full time",
        "company": "Bill & Melinda Gates Foundation",
        "companyLinkedinUrl": "https://www.linkedin.com/company/bill-&-melinda-gates-foundation/",
        "companyLogo": { "url": "…", "width": 200, "height": 200, "expiresAt": "…" },
        "location": "Seattle, Washington",
        "workplaceType": "On-site",
        "description": "…",
        "dates": {
          "start": { "day": null, "month": 1, "year": 2000 },
          "end": null,
          "current": true,
          "durationMonths": 319
        },
        "skills": []
      }
    ],
    "education":      [ { "school": "…", "degree": "…", "fieldOfStudy": "…", "grade": null,
                          "activities": null, "description": null, "schoolLinkedinUrl": "…",
                          "schoolLogo": { "…": "" }, "dates": { "…": "" } } ],
    "skills":         [ { "name": "Philanthropy", "endorsementCount": 42 } ],
    "certifications": [ { "name": "…", "issuer": "…", "issuerLogo": null, "issuedAt": { "…": "" },
                          "expiresAt": null, "credentialId": "…", "credentialUrl": "…" } ],
    "languages":      [ { "name": "English", "proficiency": "Native or bilingual proficiency" } ],
    "projects":       [], "publications": [], "honors": [], "volunteering": []
  },
  "meta": {
    "cached": false,
    "source": "voyager-profile-view",
    "scrapedAt": "2026-08-27T01:42:11.238Z",
    "ageSeconds": 0,
    "durationMs": 1284,
    "missingSections": ["publication", "honor"]
  }
}
```

Two response-header shortcuts: `x-cache: HIT|MISS` and `x-source`.

#### Schema conventions

These are deliberate, and consistent throughout:

- **`null` means "we looked and LinkedIn didn't have it."** Arrays are always present, possibly empty — a caller never has to branch on `undefined`.
- **Dates are structured, not formatted.** LinkedIn genuinely only stores month + year for most entries (and sometimes only a year), so `{ day, month, year }` with nullable parts reports exactly the precision that exists. Formatting is the caller's business, and a pre-formatted `"Jan 2020"` would destroy information.
- **No LinkedIn vocabulary in the contract.** No URNs in required fields, no `com.linkedin.voyager.*` type names, no `$recipeType` leakage. `urn` is exposed because it's genuinely useful — it's stable even when a member changes their vanity name — but nothing depends on it.
- **`meta.missingSections` distinguishes "empty" from "failed."** An empty `certifications` array could mean the member has none, or that the certifications card failed to load. `missingSections` tells you which.
- **Enums are humanised.** `FULL_TIME` → `"Full time"`, `NATIVE_OR_BILINGUAL` → `"Native or bilingual proficiency"`.

### Errors

```json
{ "success": false, "error": { "code": "SCRAPE_THROTTLED", "message": "…", "retryAfterSeconds": 47 } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_URL` | 400 | Not a parseable LinkedIn member profile URL. |
| `UNAUTHORIZED` | 401 | Missing or invalid `x-api-key`. |
| `PROFILE_PRIVATE` | 403 | The profile exists but isn't visible to the configured session. |
| `PROFILE_NOT_FOUND` | 404 | No profile at that identifier. |
| `RATE_LIMITED` | 429 | Per-caller API rate limit (60/min). |
| `SCRAPE_THROTTLED` | 429 | Live-scrape budget exhausted. **Cached profiles still resolve.** |
| `AUTH_FAILED` | 502 | LinkedIn rejected the session cookie — it has expired. |
| `PARSE_FAILED` | 502 | Every extraction strategy ran but none produced a profile. |
| `UPSTREAM_BLOCKED` | 503 | LinkedIn flagged the request as automated. |
| `NO_IDENTITY_AVAILABLE` | 503 | All identities are cooling down or quarantined. |

`429` and `503` responses carry a `retry-after` header wherever a wait time is known.

---

## Approach

### 1. Voyager, not HTML

linkedin.com is a single-page app. The rendered DOM is a lossy projection of JSON the browser already fetched, and its class names are minified and rotate on every deploy — so a DOM scraper is both less complete and more brittle than reading the API underneath it.

That API is **Voyager**, at `https://www.linkedin.com/voyager/api/…`. It's authenticated purely by cookie:

```http
GET /voyager/api/identity/profiles/williamhgates/profileView
Cookie: li_at=<session>; JSESSIONID="ajax:1234567890123456789"
csrf-token: ajax:1234567890123456789        ← the JSESSIONID value, unquoted
x-restli-protocol-version: 2.0.0
accept: application/vnd.linkedin.normalized+json+2.1
```

Three details are load-bearing, and each one is a silent failure if you get it wrong:

- **`csrf-token` is literally the `JSESSIONID` value with the quotes stripped.** Not derived from it — the same string. Send it quoted and every request 403s.
- **`x-restli-protocol-version: 2.0.0`** switches Rest.li into its compact encoding. Omit it and array/URN parameters are parsed differently, producing empty results rather than errors.
- **The `normalized+json` Accept header** is what makes LinkedIn flatten the object graph (below). Without it you get a deeply nested response with a different shape entirely.

### 2. Rehydrating the normalized graph

With that Accept header, Voyager doesn't nest objects — it returns a flattened graph:

```jsonc
{
  "data":     { "*elements": ["urn:li:fsd_profile:ABC"] },
  "included": [
    { "entityUrn": "urn:li:fsd_profile:ABC", "firstName": "Bill", "*profilePicture": "urn:li:image:XYZ" },
    { "entityUrn": "urn:li:image:XYZ", "rootUrl": "https://media.licdn.com/…", "artifacts": [ … ] }
  ]
}
```

Any key starting with `*` holds a URN pointing into `included[]` instead of the value. This exists so LinkedIn can send one company object even when forty positions reference it.

[`normalize.ts`](src/linkedin/normalize.ts) rebuilds the real object tree once, up front: index `included` by `entityUrn`, then walk the graph replacing `*key` references with resolved objects (exposing the raw URN alongside as `keyUrn`). Reference cycles are real — company → employee → company — so resolution carries a seen-set and marks cycles rather than recursing forever.

Every parser downstream then works against ordinary nested objects.

### 3. A strategy chain, in order of reliability

LinkedIn's GraphQL endpoints are addressed by `queryId` — an opaque hash of a persisted query, like `voyagerIdentityDashProfileCards.2fdaa6b0…`. **Those hashes change whenever LinkedIn ships a new web build**, and a hardcoded hash is the single most common reason a scraper like this dies quietly.

So extraction runs three strategies, most-reliable first:

| # | Strategy | Endpoint | Why this order |
|---|---|---|---|
| 1 | `voyager-profile-view` | `/identity/profiles/{id}/profileView` | Legacy REST. One call returns *every* section. **Takes no queryId**, so there's no hash to rotate. Predates the GraphQL migration and has never been removed. |
| 2 | `voyager-graphql` | `/identity/dash/profiles` + `/graphql` profile cards | What the current web client actually uses. Survives when (1) is disabled for an account. Returns *rendering instructions* rather than data, so it needs more interpretation. |
| 3 | `browser` | Headless Chromium on the public profile page | Real TLS fingerprint and JS execution. Slow and memory-hungry, so it's last. |

The chain distinguishes two failure modes, which matters more than it sounds:

- A strategy that **fails to parse** falls through to the next one.
- A strategy that gets **blocked** (`999`/`429`/`403`) aborts the chain immediately. Trying the next strategy on an identity LinkedIn just flagged only deepens the block.

Every `queryId` is overridable by environment variable (`QID_PROFILE_CARDS`, …), so a rotation is a config change rather than a redeploy.

#### The browser fallback doesn't scrape the DOM either

LinkedIn server-renders its Voyager responses into the page as inline `<code id="bpr-guid-…">` blobs, which the SPA hydrates from. So Chromium is used purely to *obtain* those payloads — with a real browser fingerprint — and then **the exact same parsers run over them**.

That matters for maintenance: there is one parsing implementation, not two. A LinkedIn schema change can't leave the fallback silently producing different results from the primary path.

### 4. Cache-first read path

```
request ──▶ parse URL ──▶ GCS blob cache ──HIT (fresh)──▶ respond   (no LinkedIn traffic)
                              │
                             MISS
                              ▼
                       scrape limiter (5/min, hard)
                              │
                              ▼
                   identity pool ──▶ strategy chain ──▶ write blob ──▶ respond
```

A profile is scraped **once**. Every later request for the same profile is served from `gs://<bucket>/profiles/<publicId>.json` without touching LinkedIn.

Concurrent requests for the same profile are collapsed into a single scrape ([`profile-service.ts`](src/service/profile-service.ts)). Without that, ten simultaneous requests for one profile would burn ten of the five-per-minute slots doing identical work.

Cache failures degrade rather than propagate: a failed read falls through to a live scrape, and a failed write still returns the response.

---

## Design decisions

### Rate limiting — two different limiters, protecting two different things

| | `SCRAPE_RATE_PER_MINUTE` (5) | `@fastify/rate-limit` (60/min) |
|---|---|---|
| Protects | **The LinkedIn account** | The service |
| Counts | Live LinkedIn fetches only | All HTTP requests |
| Cache hits count? | **No** | Yes |

Conflating them would be a mistake: a cache hit costs LinkedIn nothing, so charging it against the scrape budget would throttle traffic that isn't the risk.

The scrape limiter is a **sliding window**, not a token bucket. A bucket refills continuously and permits a 2× burst across a window boundary — precisely the pattern that gets an account flagged. A sliding window makes "no more than 5 in *any* 60 seconds" literally true.

> **This is why Cloud Run is pinned to `--max-instances=1`.** The limiter and the identity cooldowns are per-process. A second instance would silently double the rate actually reaching LinkedIn while both instances believed they were within budget. Scaling out requires moving the limiter to shared state (Redis) first — see [Known limitations](#known-limitations).

### Proxy rotation — rotate identities, not IPs

The naive design is a pool of proxies with requests round-robined across them. **That design actively burns accounts.** A LinkedIn session cookie whose requests arrive from a different IP every time looks exactly like a stolen cookie being replayed, which is what LinkedIn's security checkpoint is built to catch.

So the unit of rotation here is an **identity** — a session cookie married to a fixed egress IP:

```
identity = { li_at cookie + JSESSIONID }  ⟷  { sticky proxy session }
```

The pairing is permanent for the process lifetime, and the sticky session id is **derived from a hash of the cookie** rather than randomly generated — so an identity keeps the same egress IP across restarts and redeploys, which a random id would silently defeat.

Each identity carries independent health state ([`pool.ts`](src/identity/pool.ts)):

- **Selection** is least-recently-used among healthy identities, so load spreads evenly rather than hammering whichever is first.
- **A block** triggers exponential backoff — 1 min, 2, 4, 8… capped at 1 hour — with ±20% jitter so multiple instances don't retry in lockstep.
- **Five consecutive blocks quarantines** the identity outright. Continuing to retry a cookie LinkedIn has already flagged is how a temporary restriction becomes a permanent ban.
- **Transient network errors don't trigger cooldown.** Only genuine push-back (`999`/`429`/`403`/`401`) does.
- `GET /health` exposes per-identity state with proxy credentials stripped.

The proxy layer is deliberately **provider-agnostic** — everything is a standard `http://user:pass@host:port` URL, the lowest common denominator across Webshare, IPRoyal, Decodo, Bright Data and self-hosted. For sticky sessions, `PROXY_STICKY_TEMPLATE` substitutes `{session}`:

```bash
PROXY_STICKY_TEMPLATE=http://USER-session-{session}:PASS@gate.decodo.com:7000
```

> **Residential proxies are close to mandatory in production.** Cloud Run egresses from Google datacenter IP ranges, which LinkedIn flags aggressively — the service will work far longer through residential IPs than without.

### Why blob storage rather than a database

The access pattern is a pure key/value get-or-scrape. There is no query surface, no joins, no transactions. A bucket needs no connection pool on cold start, costs nothing when idle (which matters when Cloud Run scales to zero), and gives object lifecycle rules for free. Cache entries are schema-versioned, so a breaking change to the response shape invalidates old blobs automatically instead of serving stale-shaped JSON.

### Security

- Secrets live in Secret Manager and are mounted at runtime — never in the repo, the service config, or build logs.
- The logger redacts `cookie`, `x-api-key` and `authorization` headers.
- `/health` reports proxy *hostnames* only; credentials are stripped by `redactProxy()`.
- API keys are compared in constant time.
- The cache bucket has public-access prevention and uniform bucket-level access.
- The service account holds `objectAdmin` on **one bucket** and `secretAccessor` on **named secrets** — not project-wide roles.
- The container runs as non-root (`pwuser`).
- `publicId` is validated against a strict charset and URL-encoded before use as an object path, so a crafted vanity name can't escape the bucket prefix.

---

## Deployment

Deployed to **Google Cloud Run** (asia-south1). One command, idempotent:

```bash
./scripts/deploy.sh
```

It enables the required APIs, creates the Artifact Registry repo, the cache bucket and a least-privilege service account, builds the container with Cloud Build, and deploys.

Create the secret first (this is the one step the script won't do for you, because it's the one that touches credentials):

```bash
printf '%s' '[{"label":"primary","liAt":"AQEDA...","jsessionId":"ajax:1234567890123456789"}]' \
  | gcloud secrets create linkedin-identities --data-file=-
```

Optional secrets — attached automatically when present: `proxy-urls`, `proxy-sticky-template`, `api-keys`.

Then verify the deployment against its actual contract:

```bash
./scripts/smoke.sh https://<host>
```

### Running with Docker

```bash
docker build -t linkedin-profile-api .
docker run -p 8080:8080 --env-file .env linkedin-profile-api
```

### When LinkedIn rotates a queryId

Symptom: strategy 1 works, strategy 2 returns empty. Fix without redeploying code:

1. Open a LinkedIn profile in a browser with DevTools → Network, filtered to `graphql`.
2. Copy the `queryId` query parameter from the profile-cards request.
3. `gcloud run services update linkedin-profile-api --update-env-vars QID_PROFILE_CARDS=<new-id>`

---

## Known limitations

**Fundamental to the approach**

- **This violates LinkedIn's Terms of Service.** The account whose cookie is used can be restricted or permanently banned. See [Legal](#legal).
- **Session cookies expire.** `li_at` lasts roughly 12 months but is invalidated early by a password change, an explicit logout, or a security challenge. Expiry surfaces as `AUTH_FAILED` (502) and needs a manual cookie refresh — there is no automated re-login, deliberately, since automating login is what triggers CAPTCHA challenges most reliably.
- **`queryId` hashes rotate** with LinkedIn web builds and will eventually break strategy 2. Mitigated by ordering the queryId-free endpoint first and by env-var overrides, not eliminated.
- **Datacenter IPs get blocked fast.** Without residential proxies, expect `999` responses from Cloud Run within tens of requests.

**Data completeness**

- **You only see what your account can see.** LinkedIn's visibility rules apply to the API exactly as they do in the browser: 3rd-degree connections show truncated experience, out-of-network profiles may show almost nothing, and some members hide sections entirely. An empty section is often a privacy setting, not a parsing bug — `meta.missingSections` is there to make that distinguishable.
- **Recommendations, endorsement details, contact info and post activity are not extracted.** Each needs its own endpoint; the brief's field list doesn't include them.
- **Skill endorsement counts are frequently `null`** — `profileView` returns skills without counts, and fetching them needs a per-skill call that isn't worth the rate-limit budget.
- **Image URLs are signed and expire** (typically ~30 days). `expiresAt` is reported; callers needing permanence must re-host the bytes.
- **Company and school logos come from whichever entity LinkedIn attached** — a position at a company with no LinkedIn page has no logo.
- **Nested multi-role positions** (several roles at one employer) are flattened into standalone entries with the company inherited. The grouping itself is not preserved.

**Operational**

- **Single instance only.** The scrape limiter and identity cooldowns are in-process, so `--max-instances=1` is required for the 5/min ceiling to be real. Horizontal scaling needs the limiter moved to Redis first.
- **In-memory cache when `GCS_BUCKET` is unset** — fine for local dev, useless across containers.
- **Cold starts are slow** (~3-6s) because the image carries Chromium. Set `--min-instances=1` to trade cost for latency.
- **The browser fallback is memory-hungry** (~300 MB RSS) and needs the 2 GiB Cloud Run allocation.
- **No pagination on long profiles.** Profiles with very many positions may be truncated by LinkedIn's own card pagination; only the first page of each section is read.

---

## Legal

This project was built for the Tross engineering hiring challenge, which explicitly asks for reverse-engineered LinkedIn API access using the developer's own credentials.

Scraping LinkedIn violates the [LinkedIn User Agreement](https://www.linkedin.com/legal/user-agreement) §8.2, regardless of whether the data is public. *hiQ Labs v. LinkedIn* established that scraping public data isn't a CFAA violation in the US — but that's a criminal-liability finding, not permission. LinkedIn can and does terminate accounts, and enforces its ToS contractually.

Practically, that means: use an account you can afford to lose, keep the rate limit low, and don't redistribute scraped personal data. Profile data about identifiable people is personal data under GDPR/DPDP — collecting it engages those regimes independently of what LinkedIn permits.

This code is for evaluation. Don't run it at scale against real people.

---

## Project layout

```
src/
├── index.ts                    entrypoint, graceful shutdown
├── server.ts                   Fastify app, auth, error handling
├── config.ts                   env parsing — the only module that reads secrets
├── errors.ts                   error taxonomy → HTTP status mapping
├── openapi.ts                  OpenAPI doc generated from the Zod schemas
├── schema/profile.ts           the public response contract
├── linkedin/
│   ├── url.ts                  profile URL → publicId
│   ├── voyager-client.ts       authenticated Voyager transport
│   ├── endpoints.ts            endpoint catalogue + queryId overrides
│   ├── normalize.ts            normalized-graph rehydration
│   ├── scraper.ts              the strategy chain
│   └── parse/
│       ├── common.ts           dates, images, union unwrapping
│       ├── profile-view.ts     legacy REST parser
│       └── dash-cards.ts       GraphQL card parser
├── identity/
│   ├── pool.ts                 identity rotation + health
│   └── proxy.ts                provider-agnostic proxy plumbing
├── cache/{gcs,memory}.ts       blob cache + local fallback
├── ratelimit/scrape-limiter.ts sliding-window scrape ceiling
├── fallback/browser.ts         Playwright fallback
├── service/profile-service.ts  cache-first read path, single-flight
└── routes/                     HTTP layer
```
