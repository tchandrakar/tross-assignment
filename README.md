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

**Requirements:** Node.js ≥ 20 (developed on 25), and a LinkedIn account you're willing to use.

```bash
git clone https://github.com/tchandrakar/tross-assignment.git
cd tross-assignment
npm install
npx playwright install chromium
cp .env.example .env
```

### Establishing a session

Put your account's credentials in `.env` and run the login helper:

```bash
npm run login
```

A **visible** browser opens, logs in with human-paced typing, pauses if LinkedIn
presents a CAPTCHA or emails you a code (clear it in the window), verifies the
result against `/voyager/api/me`, and writes the session to `.sessions/`.

Then start the API:

```bash
npm run dev
```

`http://localhost:8080`, docs at `/docs`.

Once the session file exists you can delete `LI_PASSWORD` from `.env` — **the
server never reads it.** Credentials are used only by the login helper, only to
fill LinkedIn's own form, and are never logged or written to disk.

> `.sessions/*.json` is a live logged-in session. It is gitignored and written
> mode `0600`. Treat it exactly like a password.

#### Why login rather than pasting a cookie

The obvious approach — copy `li_at` out of DevTools and use it forever — does
not work, and fails in a way that looks like something else.

**LinkedIn rotates `li_at` on use and invalidates the previous value.** A pasted
cookie is a point-in-time snapshot that goes stale within minutes. Replaying a
superseded token is the signature of a stolen cookie, and LinkedIn responds by
killing the session server-side:

```http
HTTP/2 302
location: https://www.linkedin.com/voyager/api/me
set-cookie: li_at=delete me; Expires=Thu, 01-Jan-1970 00:00:00 GMT; Max-Age=0
```

That is not a rate limit and not an expiry — the cookie is unrecoverable, and
re-copying from the same browser session cannot produce a live one. Observed
directly during development: a freshly-pasted jar authenticated successfully and
then returned `401` about a minute later from a new browser context, because the
first request had already rotated the token and the new value was discarded with
the context.

So the fix is *persistence*, not better headers. The API stores the browser's
storage state after every call and reloads it on the next one, following the
rotation instead of fighting it. Cookie pasting is still supported via
`LI_COOKIES` — it just acts as a one-time bootstrap seed rather than a
permanent credential.

```bash
npm test          # 100 unit tests, no network access required
npm run typecheck # strict tsc
npm run build     # compile to dist/
```

---

## Configuration

Every option is in [`.env.example`](.env.example). The ones that matter:

| Variable | Default | Purpose |
|---|---|---|
| `LI_EMAIL` / `LI_PASSWORD` | — | Used **only** by `npm run login`. The server never reads them. |
| `IDENTITY_LABEL` | `primary` | Names the identity, and keys its stored session. |
| `SESSION_STATE_DIR` | `.sessions` | Where browser session state is persisted locally. |
| `LI_COOKIES` | — | A pasted `cookie:` header, used as a one-time bootstrap seed. |
| `LINKEDIN_IDENTITIES` | — | JSON array of `{label, liAt, jsessionId, cookies?, proxy?}` for multi-account setups. |
| `ENABLE_BROWSER_FALLBACK` | `true` | The browser transport. Leave on. |
| `ENABLE_HTTP_TRANSPORT` | `false` | Raw-HTTP Voyager. Off by default — it burns sessions (see [Approach](#approach)). |
| `PROXY_URLS` | — | Comma-separated proxy URLs, assigned round-robin to identities. |
| `PROXY_STICKY_TEMPLATE` | — | Proxy URL template with `{session}` for sticky-session providers. |
| `GCS_BUCKET` | — | Blob bucket for the profile cache *and* session state. In-process LRU when unset. |
| `CACHE_TTL_SECONDS` | `604800` (7d) | How long a cached profile is served before re-scraping. `0` = never expire. |
| `SCRAPE_RATE_PER_MINUTE` | `5` | **Hard ceiling** on live LinkedIn fetches. |
| `API_KEYS` | — | Comma-separated keys required as `x-api-key`. Unauthenticated when empty. |

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

| # | Strategy | Transport | Notes |
|---|---|---|---|
| 1 | `browser-voyager` | Voyager called from inside an authenticated Chromium page | **Default.** Same endpoints, same parsers — the request simply carries Chrome's real TLS fingerprint, header ordering and cookie jar, because it genuinely is Chrome making a same-origin request. |
| 2 | `voyager-graphql` | The same dash calls over raw HTTP (`undici`) | Faster and far cheaper, and the purest expression of "call the API directly". **Off by default** — see below. |
| 3 | `voyager-profile-view` | Legacy REST, raw HTTP | One call returned *every* section and took no `queryId`. **Returns `410 Gone` as of 2026-08.** Retained because it costs one call to try and 410 is unambiguous. |
| 4 | `browser` | Harvest payloads from the rendered profile page | Last resort. |

> **Why raw HTTP is opt-in.** An HTTP client is trivially distinguishable from a
> browser — different TLS/JA3 signature, different header ordering, no JS
> execution. In testing, a raw client authenticated fine and then had its session
> invalidated server-side within a handful of requests, while the browser
> transport making the *identical* API calls kept working. Raw HTTP is preserved
> behind `ENABLE_HTTP_TRANSPORT=true` because it is the more direct answer to
> "reverse engineer the API", but it is not the default because it destroys the
> credential it depends on.

> **Note on ordering.** `profileView` was originally strategy 1 — it is
> genuinely the better endpoint. Live testing showed LinkedIn now returns `410`
> for both `/profileView` and `/networkinfo`, so the chain was reordered around
> what actually works.

The chain distinguishes **three** failure modes, and the distinction is
load-bearing:

- **Blocked** (`999`/`429`/`403`/`401`) → abort the chain immediately. Trying the next strategy on an identity LinkedIn just flagged only deepens the block.
- **Endpoint retired** (`410`) → fall through at once. The identity is healthy; this route no longer exists, and it must not count against the identity's health.
- **Parse failure** → fall through to the next strategy.

Collapsing the first two is a real bug, and it was one this codebase had: before
live testing, `410` fell into the generic `>= 300` branch and was reported as
`AUTH_FAILED`, which aborted the chain and made a retired endpoint look exactly
like an expired cookie.

#### Cookie scoping, and a bug it caused

LinkedIn splits its cookies across two domains, and getting this wrong produces
an error that points nowhere near the cause. Straight off the wire, from the
`Set-Cookie` headers LinkedIn sends when invalidating a session:

```
li_at=delete me;   Domain=.www.linkedin.com
li_a="delete me";  Domain=.www.linkedin.com
liap=delete me;    Domain=.linkedin.com
```

Seeding every cookie on `.linkedin.com` — the obvious guess — means the browser
never sends `li_at` to `www.linkedin.com`. LinkedIn treats the navigation as
unauthenticated and answers with its "clear your cookies and retry" 302, which
the browser follows forever: `ERR_TOO_MANY_REDIRECTS`. Nothing about that error
suggests a cookie-scope bug. The API now scopes cookies per LinkedIn's own
domains and reports the redirect loop as an actionable `AUTH_FAILED`.

#### Header fidelity

`x-li-track` is built per identity from that identity's own cookies rather than
being a fixed constant, because LinkedIn cross-checks it. Sending
`timezone: UTC` while the account's `timezone` cookie says `Asia/Calcutta` is an
inconsistency a real browser never produces.

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

Establish the session locally first, then upload it — this is the one step the
script won't do for you, because it's the one that touches credentials:

```bash
npm run login
gcloud storage cp .sessions/primary.json gs://<bucket>/sessions/primary.json
```

On Cloud Run the session lives in the same bucket as the profile cache, because
the container filesystem is ephemeral: without that, every cold start would
replay a stale seed and re-trigger LinkedIn's replay detection.

An identity still needs to exist for the pool to hand out. With credentials-only
setup that is just a label:

```bash
printf '%s' 'primary' | gcloud secrets create identity-label --data-file=-
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
- **Sessions need occasional manual re-establishment.** Persistence follows token rotation, but a password change, an explicit logout elsewhere, or a security challenge still ends the session. That surfaces as `AUTH_FAILED` (502) and needs `npm run login` again. There is no automated re-login inside the server, deliberately: automating LinkedIn login is the most reliable way to trigger a CAPTCHA and lock the account, so it stays a supervised, human-present step.
- **Only one process may use a session at a time.** Two containers sharing stored state would rotate the token out from under each other — the same stale-replay problem, self-inflicted. Reinforces `--max-instances=1`.
- **Session cookies expire, and can be killed early.** `li_at` nominally lasts ~12 months, but is invalidated by a password change, an explicit logout, a security challenge — or by LinkedIn deciding the cookie is being replayed (see [Why the whole jar matters](#why-the-whole-jar-matters)). Both surface as `AUTH_FAILED` (502) and need a manual cookie refresh. There is no automated re-login, deliberately: automating LinkedIn login is the single most reliable way to trigger a CAPTCHA challenge and lock the account.
- **LinkedIn retires endpoints without notice.** `/profileView` and `/networkinfo` returned complete data for years and now return `410 Gone`. Nothing about this approach is stable by construction; the strategy chain limits the blast radius of any one retirement, it doesn't prevent them.
- **`queryId` hashes rotate** with LinkedIn web builds and will eventually break strategy 2. Mitigated by ordering the queryId-free endpoint first and by env-var overrides, not eliminated.
- **Datacenter IPs get blocked fast.** Without residential proxies, expect `999` responses from Cloud Run within tens of requests.

**Data completeness**

- **You only see what your account can see.** LinkedIn's visibility rules apply to the API exactly as they do in the browser: 3rd-degree connections show truncated experience, out-of-network profiles may show almost nothing, and some members hide sections entirely. An empty section is often a privacy setting, not a parsing bug — `meta.missingSections` is there to make that distinguishable.
- **Recommendations, endorsement details, contact info and post activity are not extracted.** Each needs its own endpoint; the brief's field list doesn't include them.
- **Skill endorsement counts are frequently `null`** — the card surface returns skills without counts, and fetching them needs a per-skill call that isn't worth the rate-limit budget.
- **Connection and follower counts may be `null`** — `/networkinfo` is retired (410), so these are read from the dash profile record where present.
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
├── browser/
│   ├── session.ts              warmed authenticated Chromium; in-page Voyager calls
│   ├── session-store.ts        storage-state persistence (file + GCS)
│   ├── login.ts                interactive login helper
│   └── login-cli.ts            `npm run login`
├── linkedin/
│   ├── url.ts                  profile URL → publicId
│   ├── voyager-client.ts       raw-HTTP Voyager transport
│   ├── endpoints.ts            endpoint catalogue + queryId overrides
│   ├── normalize.ts            normalized-graph rehydration
│   ├── scraper.ts              transports + the strategy chain
│   └── parse/
│       ├── common.ts           dates, images, union unwrapping
│       ├── profile-view.ts     legacy REST parser
│       └── dash-cards.ts       GraphQL card parser
├── identity/
│   ├── pool.ts                 identity rotation + health
│   └── proxy.ts                provider-agnostic proxy plumbing
├── cache/{gcs,memory}.ts       profile blob cache + local fallback
├── ratelimit/scrape-limiter.ts sliding-window scrape ceiling
├── service/profile-service.ts  cache-first read path, single-flight
└── routes/                     HTTP layer
```

