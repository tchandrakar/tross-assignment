# LinkedIn Profile API

An HTTPS service that accepts a LinkedIn profile URL and returns the profile as structured JSON — name, headline, location, summary, positions, education, skills, certifications, languages and media.

Data is read from LinkedIn's internal **Voyager API** — the same endpoints linkedin.com's own single-page application calls — rather than by parsing rendered HTML.

```bash
curl -s --get \
  --data-urlencode "url=https://www.linkedin.com/in/williamhgates/" \
  https://linkedin.viral-engine.ai/v1/profile
```

| | |
|---|---|
| **Base URL** | `https://linkedin.viral-engine.ai` |
| **Interactive docs** | [`/docs`](https://linkedin.viral-engine.ai/docs) · OpenAPI 3.0 at [`/docs/json`](https://linkedin.viral-engine.ai/docs/json) |
| **Health** | [`/health`](https://linkedin.viral-engine.ai/health) |
| **Postman** | [`postman/`](postman/) — importable collection with assertions and saved examples |
| **Source** | [github.com/tchandrakar/tross-assignment](https://github.com/tchandrakar/tross-assignment) |

---

## Contents

- [API contract](#api-contract)
- [Rate limits](#rate-limits)
- [How it works](#how-it-works)
- [Design decisions](#design-decisions)
- [Running it yourself](#running-it-yourself)
- [Deployment](#deployment)
- [Known limitations](#known-limitations)
- [Legal and compliance](#legal-and-compliance)
- [Project layout](#project-layout)

---

## API contract

All responses are `application/json`. Every response carries a boolean `success`
discriminator, so a client can branch on one field before reading anything else.

### `GET /v1/profile`

| Parameter | In | Required | Type | Description |
|---|---|---|---|---|
| `url` | query | yes | string | A LinkedIn profile URL, or a bare vanity name |
| `refresh` | query | no | boolean | Bypass the cache and force a live fetch. Defaults to `false` |

Accepted input forms — all resolve to the same profile:

```
https://www.linkedin.com/in/williamhgates/
https://linkedin.com/in/williamhgates
https://in.linkedin.com/in/williamhgates?originalSubdomain=in
www.linkedin.com/in/williamhgates/en
williamhgates
```

`/company/…` and `/school/…` URLs are rejected with `400` rather than
misinterpreted as member profiles.

### `POST /v1/profile`

```json
{ "url": "https://www.linkedin.com/in/williamhgates/", "refresh": false }
```

Identical semantics to `GET`; provided for clients that prefer not to place
identifiers in query strings.

### `DELETE /v1/profile/{publicId}/cache`

Evicts a single cached profile. Returns `{ "success": true, "publicId": "…", "evicted": true }`.

### `GET /health`

Service status, dependency health, and remaining quota across all three rate
limit tiers. Never rate limited — the endpoint that reports remaining quota must
stay reachable precisely when a caller is being throttled.

### `POST /v1/admin/session/challenge`

```json
{ "code": "123456" }
```

Submits a verification code for a pending upstream challenge.

LinkedIn challenges an unattended sign-in from an unfamiliar network, and the
challenge's hidden form fields are bound to the cookie jar that received them —
discarding that jar and signing in again simply produces another challenge. The
service therefore keeps the jar and reports the pending challenge on `/health`;
this endpoint delivers the code to it. On success the resulting session is
stored and the service is authenticated again with no further action.

A mistyped code leaves the challenge open so it can be retried. Unanswered
challenges are reaped after 20 minutes.

### `POST /v1/admin/session/reset`

Clears the automatic-login circuit breaker and drops live browser sessions, so
the next request re-establishes the upstream session from scratch. Intended for
recovery after a corrected credential, so that fixing configuration takes effect
immediately rather than after a timeout or a redeploy. Protected by the API key
when one is configured.

### `GET /healthz`

Liveness only. Touches no dependency, so an upstream problem cannot cause the
platform to recycle an otherwise healthy container.

### Response headers

| Header | Values | Meaning |
|---|---|---|
| `x-cache` | `HIT` \| `MISS` | Whether the response came from the cache |
| `x-source` | `voyager-dash` \| `voyager-profile-view` \| `cache` | Which extraction path produced the data |
| `retry-after` | seconds | Present on every `429` and on `503` where a wait is known |

### Success response

```jsonc
{
  "success": true,
  "data": {
    "publicId": "williamhgates",
    "profileUrl": "https://www.linkedin.com/in/williamhgates/",
    "urn": "urn:li:fsd_profile:ACoAAA8BYqEB…",

    "firstName": "Bill",
    "lastName": "Gates",
    "fullName": "Bill Gates",
    "headline": "Chair, Gates Foundation and Founder, Breakthrough Energy",
    "about": "Chair of the Gates Foundation. Founder of Breakthrough Energy…",
    "location": {
      "full": "Seattle, Washington, United States",
      "city": "Seattle",
      "country": "United States",
      "countryCode": "US"
    },
    "industry": "Philanthropy",
    "pronouns": null,

    "connectionCount": null,
    "followerCount": null,
    "isPremium": true,
    "isInfluencer": true,
    "isOpenToWork": false,
    "isHiring": false,

    "profilePicture": {
      "url": "https://media.licdn.com/dms/image/v2/…/profile-displayphoto-shrink_800_800/…",
      "width": 800,
      "height": 800,
      "expiresAt": "2026-09-17T00:00:00.000Z"
    },
    "backgroundImage": { "url": "…", "width": 1584, "height": 396, "expiresAt": "…" },

    "experience": [
      {
        "title": "Co-chair",
        "employmentType": null,
        "company": "Gates Foundation",
        "companyLinkedinUrl": "https://www.linkedin.com/company/gates-foundation/",
        "companyLogo": { "url": "…", "width": 200, "height": 200, "expiresAt": "…" },
        "location": null,
        "workplaceType": null,
        "description": null,
        "dates": {
          "start": { "day": null, "month": null, "year": 2000 },
          "end": null,
          "current": true,
          "durationMonths": 319
        },
        "skills": []
      }
    ],

    "education": [
      {
        "school": "Harvard University",
        "schoolLinkedinUrl": "https://www.linkedin.com/school/harvard-university/",
        "schoolLogo": { "url": "…", "width": 200, "height": 200, "expiresAt": "…" },
        "degree": null,
        "fieldOfStudy": null,
        "grade": null,
        "activities": null,
        "description": null,
        "dates": {
          "start": { "day": null, "month": null, "year": 1973 },
          "end":   { "day": null, "month": null, "year": 1975 },
          "current": false,
          "durationMonths": 35
        }
      }
    ],

    "skills":         [ { "name": "Digital Marketing", "endorsementCount": null } ],
    "certifications": [ {
      "name": "HubSpot Sales Hub Certification",
      "issuer": "HubSpot",
      "issuerLogo": { "url": "…", "width": 200, "height": 200, "expiresAt": "…" },
      "issuedAt": { "day": null, "month": 4, "year": 2023 },
      "expiresAt": null,
      "credentialId": null,
      "credentialUrl": "https://app.hubspot.com/academy/achievements/…"
    } ],
    "languages":      [ { "name": "English", "proficiency": "Full professional proficiency" } ],
    "projects":       [],
    "publications":   [],
    "honors":         [ { "title": "Employee of the Month", "issuer": "…", "description": "…", "issuedAt": { "day": null, "month": 8, "year": 2014 } } ],
    "volunteering":   []
  },

  "meta": {
    "cached": false,
    "source": "voyager-dash",
    "scrapedAt": "2026-08-27T04:12:44.201Z",
    "ageSeconds": 0,
    "durationMs": 6989,
    "missingSections": ["projects", "publications", "volunteering"]
  }
}
```

### Schema conventions

These hold everywhere in the response, and each exists for a reason:

- **`null` means "we looked and LinkedIn did not have it."** Every array is
  always present, possibly empty, so a client never has to branch on
  `undefined` before iterating.
- **Dates are structured, not formatted.** LinkedIn stores month + year for most
  entries and sometimes only a year. `{ day, month, year }` with nullable parts
  reports exactly the precision that exists; a pre-formatted `"Jan 2020"` would
  destroy information and impose one locale on every consumer.
- **`durationMonths` is computed, not copied.** LinkedIn renders tenure as
  display text; a number is what callers actually want to sort and aggregate on.
- **No LinkedIn vocabulary in the contract.** No `com.linkedin.voyager.*` type
  names, no `$recipeType`, no URNs in required fields. `urn` is exposed because
  it is genuinely useful — it remains stable when a member changes their vanity
  name — but nothing else depends on it.
- **Enumerations are humanised.** `FULL_TIME` becomes `"Full time"`;
  `NATIVE_OR_BILINGUAL` becomes `"Native or bilingual proficiency"`.
- **`meta.missingSections` distinguishes "empty" from "not retrieved."** An
  empty `certifications` array could mean the member has none, or that the
  section could not be read. This field tells you which, so a consumer never
  silently records an absence that was really a failure.

### Error response

```json
{
  "success": false,
  "error": {
    "code": "SCRAPE_THROTTLED",
    "message": "Live scrape budget exhausted: at most 5 new profiles are fetched from LinkedIn per minute. Already-scraped profiles are still served instantly from cache.",
    "details": { "limitPerMinute": 5 },
    "retryAfterSeconds": 47
  }
}
```

| Code | HTTP | Meaning | Client action |
|---|---|---|---|
| `INVALID_URL` | 400 | Not a parseable LinkedIn member profile URL | Fix the input |
| `UNAUTHORIZED` | 401 | Missing or invalid `x-api-key` | Supply a valid key |
| `PROFILE_PRIVATE` | 403 | Profile exists but is not visible to the service's account | Not retryable |
| `PROFILE_NOT_FOUND` | 404 | No profile at that identifier | Not retryable |
| `RATE_LIMITED` | 429 | Caller or service request limit reached | Retry after `retryAfterSeconds` |
| `SCRAPE_THROTTLED` | 429 | Live-fetch budget exhausted. **Cached profiles still resolve** | Retry, or request a cached profile |
| `AUTH_FAILED` | 502 | The upstream session is no longer valid | Operator action; see `details.needsHuman` |
| `PARSE_FAILED` | 502 | Every extraction strategy ran but none produced a profile | Retry once, then report |
| `ENDPOINT_RETIRED` | 502 | LinkedIn has withdrawn an endpoint | Operator action |
| `UPSTREAM_BLOCKED` | 503 | LinkedIn rejected the request | Retry after `retryAfterSeconds` |
| `NO_IDENTITY_AVAILABLE` | 503 | All upstream identities are cooling down or quarantined | Retry later |

`GET /health` reports two operator-facing fields:

- **`loginHealth`** — non-empty means automatic re-authentication is failing.
  `suspended: true` means the circuit breaker has tripped.
- **`pendingChallenges`** — non-empty means the upstream is waiting on a
  verification code. Submit it to `POST /v1/admin/session/challenge`.

---

## Rate limits

Three independent tiers. They are separate because they protect different
things, and conflating them would throttle traffic that carries no risk.

| Tier | Limit | Scope | Counts | Purpose |
|---|---|---|---|---|
| **New profile fetches** | 5 / min | Service-wide | Live LinkedIn fetches only | Protects the upstream account |
| **Per caller** | 10 / min | Per API key, else client IP | All requests | Stops one caller consuming the service |
| **Service total** | 20 / min | All callers combined | All requests | Bounds total load |

**A cache hit costs the upstream nothing, so it never consumes the fetch
budget.** A caller can therefore retrieve already-known profiles at the full
10/min even while the fetch budget is exhausted.

The per-caller limit is evaluated first: when one caller is responsible for
saturating the service, that caller should be the one told to slow down rather
than everyone else.

All three are **sliding windows**, not token buckets. A bucket refills
continuously and therefore admits close to a 2× burst across a window boundary —
N requests at the end of one window and N more at the start of the next. A
sliding window makes "no more than N in *any* 60 seconds" literally true, which
is the guarantee the upstream limit actually needs.

Current quota is always readable:

```bash
curl -s https://linkedin.viral-engine.ai/health | jq .rateLimits
```

```json
{
  "scrapesPerMinute":   { "limitPerMinute": 5,  "usedInWindow": 0,  "remaining": 5,  "resetInSeconds": 0 },
  "requestsPerMinute":  { "limitPerMinute": 20, "usedInWindow": 10, "remaining": 10, "resetInSeconds": 60 },
  "perClientPerMinute": { "limitPerMinute": 10, "activeClients": 1 }
}
```

---

## How it works

### Voyager, not HTML

linkedin.com is a single-page application. Its rendered DOM is a lossy
projection of JSON the browser has already fetched, and its class names are
minified and change on every deploy. A DOM scraper is therefore both less
complete and more brittle than reading the API underneath it.

That API is **Voyager**, at `https://www.linkedin.com/voyager/api/…`,
authenticated purely by cookie:

```http
GET /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=williamhgates
    &decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-102
Cookie: li_at=<session>; JSESSIONID="ajax:1234567890123456789"
csrf-token: ajax:1234567890123456789
x-restli-protocol-version: 2.0.0
accept: application/vnd.linkedin.normalized+json+2.1
```

Three details are load-bearing, and each fails silently rather than loudly if
you get it wrong:

- **`csrf-token` is the `JSESSIONID` value with the quotes stripped** — the same
  string, not something derived from it. Send it quoted and every request 403s.
- **`x-restli-protocol-version: 2.0.0`** selects Rest.li's compact encoding.
  Omit it and array and URN parameters are interpreted differently, producing
  empty results rather than errors.
- **The `normalized+json` Accept header** is what makes LinkedIn flatten the
  object graph. Without it the response has an entirely different shape.

### One request returns the whole profile

The `FullProfileWithEntities-102` decoration returns the **entire profile graph
in a single call** — the Profile record plus PositionGroups, Positions,
Educations, Companies, Schools, Industries and Geos — with the Profile
referencing every remaining section (`*profileSkills`, `*profileCertifications`,
`*profileLanguages`, and so on).

This matters more than it first appears. LinkedIn's GraphQL endpoints are
addressed by `queryId`, an opaque hash of a persisted query such as
`voyagerIdentityDashProfileCards.2fdaa6b0…`. **Those hashes change with every
LinkedIn web build**, and a hardcoded hash is the most common reason a service
like this stops working. The endpoint above is plain REST addressed by
`decorationId` — part of LinkedIn's published Rest.li model, and far more
stable. Choosing it removes that fragility rather than working around it.

### Rehydrating the normalized graph

With the `normalized+json` Accept header, Voyager does not nest objects. It
returns a flattened graph:

```jsonc
{
  "data":     { "*elements": ["urn:li:fsd_profile:ABC"] },
  "included": [
    { "entityUrn": "urn:li:fsd_profile:ABC", "firstName": "Bill", "*profilePicture": "urn:li:image:XYZ" },
    { "entityUrn": "urn:li:image:XYZ", "rootUrl": "https://media.licdn.com/…", "artifacts": [ … ] }
  ]
}
```

Any key beginning with `*` holds a URN pointing into `included[]` rather than
the value itself. This lets LinkedIn transmit one company object even when forty
positions reference it.

[`normalize.ts`](src/linkedin/normalize.ts) rebuilds the real object tree once,
up front: index `included` by `entityUrn`, then walk the graph replacing `*key`
references with resolved objects while preserving the raw URN alongside as
`keyUrn`. Reference cycles are real — company → employee → company — so
resolution carries a seen-set and marks cycles instead of recursing forever.
Every parser downstream then works against ordinary nested objects.

### Looking like a browser without being one

LinkedIn fingerprints considerably more than the User-Agent string, and a
default Node client gets three separate layers wrong.

**TLS (JA3).** The cipher suite list, its order, and the offered elliptic curves
form a fingerprint. Node's defaults differ from Chrome's, so the handshake alone
identifies the client before a single byte of HTTP is sent. The client declares
Chrome's cipher order and curve preference explicitly.

**Protocol.** Chrome negotiates HTTP/2. An HTTP/1.1-only client talking to a
host that offers h2 is itself a signal, so the client enables h2 and advertises
the same ALPN list.

**Header order.** Browsers emit headers in a stable, characteristic order, and
the `sec-fetch-*` family must be consistent with what the request actually is —
a document navigation and an XHR carry different values. `undici` preserves
insertion order, so the order declared in
[`http/client.ts`](src/linkedin/http/client.ts) is the order on the wire.

None of this defeats a determined detector. What it does is remove the cheap,
obvious tells, and combined with honouring cookie rotation it is what makes a
browser-free client viable.

> One consequence worth recording: advertising `accept-encoding: gzip, deflate,
> br` means responses arrive compressed, and `undici` does not decompress them.
> Dropping the header would avoid that but would also make the client look less
> like a browser, so the client decodes the body itself. Getting this wrong is
> quiet rather than loud — the body arrives as bytes, every parser silently
> matches nothing, and it reads like LinkedIn changed its markup.

### Signing in without a browser

LinkedIn's `/login` and `/uas/login` are a React application with no HTML form
to post: the inputs carry React-generated ids and no `name` attributes, so there
is nothing a plain HTTP client can submit.

`/checkpoint/lg/login` still serves the classic server-rendered form:

```html
<form method="post" action="/checkpoint/lg/login-submit">
  <input type="hidden" name="csrfToken"      value="ajax:…">
  <input type="hidden" name="loginCsrfParam" value="566bf1a5-…">
  <input name="session_key"      type="email">
  <input name="session_password" type="password">
```

Both hidden fields are bound to the cookies issued alongside the form, so the
GET and the POST must share a cookie jar — fetching the form and posting from a
fresh jar fails. A successful sign-in answers `303` with `location: /feed/` and
sets the session cookie.

A redirect into `/checkpoint/` instead means the credentials were accepted and
LinkedIn wants verification. That is recoverable: the jar holding the challenge
is kept, and the emailed code is submitted through
`POST /v1/admin/session/challenge`.

### Extraction strategies

Strategies run in order; the first to return a profile with a name wins.

| # | Strategy | Notes |
|---|---|---|
| 1 | `voyager-dash` | The profile graph. **One request returns the whole profile**, addressed by `decorationId` rather than a rotating GraphQL `queryId` |
| 2 | `voyager-profile-view` | Legacy REST. Returned every section in one call and took no identifier of any kind. **Withdrawn upstream — `410 Gone`**, retained because it costs one request to try and `410` is unambiguous |
| 3 | `public` | The public profile page, **no session at all**. Runs only when the authenticated path is unavailable. Substantially reduced — see below |

Failure handling distinguishes **three** cases, and the distinction is
load-bearing:

- **Blocked** (`999`/`429`/`403`/`401`) → abort the chain. Attempting the next
  strategy with an identity LinkedIn has just flagged only deepens the block.
- **Endpoint withdrawn** (`410`) → fall through immediately. The identity is
  healthy; this route no longer exists, and it must not count against identity
  health.
- **Parse failure** → fall through to the next strategy.

Collapsing the first two is a genuine defect, and this codebase had it: `410`
initially fell into the generic `>= 300` branch and was reported as
`AUTH_FAILED`, which aborted the chain and made a withdrawn endpoint
indistinguishable from an expired credential.

### The unauthenticated fallback

When no session is available, the service reads the public profile page instead
of failing. LinkedIn embeds a schema.org `Person` as `application/ld+json` on
every public profile, served without authentication.

It is marked, not disguised: `meta.source` is `public` and every unavailable
field appears in `meta.missingSections`, so a consumer can always tell degraded
data from complete data.

Two limits, both material:

**Most free text is masked.** LinkedIn replaces it with asterisks for logged-out
viewers:

```json
"jobTitle": ["*** ******* ******* * *********"],
"worksFor": [{ "name": "***", "location": "Ahmedabad, Gujarat, India" }]
```

A masked value carries no information, so it is reported as `null` rather than
passed through — returning the asterisks would be worse than returning nothing,
because a consumer would store them as the member's actual job title.

**Guest access is per-profile.** LinkedIn serves public figures and
SEO-indexed profiles to logged-out clients and answers `999` for many ordinary
ones. Measured from the deployment: `williamhgates` returns a full document,
another profile returns `999` from the same address seconds later. So the
fallback helps for some profiles and not others, and that is not something the
client controls.

What does survive: name, location, profile image, follower count, employer and
school names where unmasked, year-precision date ranges, languages and awards.
What never does: the summary, skills, certifications, projects, publications and
volunteering.

### Read path

```
request ─▶ parse URL ─▶ cache ──HIT (fresh)──▶ respond          no upstream traffic,
                          │                                      no fetch budget spent
                         MISS
                          ▼
                  fetch budget (5/min)
                          ▼
              identity pool ─▶ strategy chain ─▶ write cache ─▶ respond
```

A profile is fetched **once**. Every later request for the same profile is
served from object storage without contacting LinkedIn.

Concurrent requests for the same profile collapse into a single fetch
([`profile-service.ts`](src/service/profile-service.ts)). Without that, ten
simultaneous requests for one profile would consume ten of the five-per-minute
slots performing identical work.

Cache failures degrade rather than propagate: a failed read falls through to a
live fetch, and a failed write still returns the response.

---

## Design decisions

### Following session-token rotation

This is the single most consequential thing to understand about LinkedIn's
session handling, and getting it wrong looks like something else entirely.

**The session token is rotated on use.** LinkedIn issues a replacement via
`Set-Cookie` as you browse and invalidates the previous value. A client that
ignores `Set-Cookie` therefore replays a superseded token on every request —
which is exactly the signature of a credential lifted from a browser and
replayed elsewhere. LinkedIn responds by invalidating the session outright:

```http
HTTP/2 302
location: https://www.linkedin.com/voyager/api/me
set-cookie: li_at=delete me; Expires=Thu, 01-Jan-1970 00:00:00 GMT; Max-Age=0
```

That is neither a rate limit nor an expiry: the credential is unrecoverable, and
re-copying from the same browser session cannot produce a live one.

An earlier revision of this service sent a fixed cookie header and never read
responses back. Its sessions died within a handful of requests, and the symptom
was misread as TLS fingerprinting. It was not — it was replay.

[`http/cookie-jar.ts`](src/linkedin/http/cookie-jar.ts) absorbs every
`Set-Cookie`, reports which values changed, and the session manager persists the
jar whenever the token rotates. It also distinguishes an ordinary rotation from
LinkedIn actively clearing the session, because those need different responses:
one is routine, the other means the session is gone.

The CSRF token Voyager requires is read from the live jar rather than from
configuration, for the same reason — a token LinkedIn rotated mid-session stays
correct.

### Identity rotation: rotate identities, not addresses

The naive design is a pool of proxies with requests distributed across them.
**That design degrades credentials.** A session whose requests arrive from a
different address each time resembles a credential being replayed elsewhere,
which is precisely what upstream security checks exist to detect.

The unit of rotation here is therefore an **identity** — a session bound to a
fixed egress address:

```
identity = { session } ⟷ { sticky proxy session }
```

The binding is stable for the process lifetime, and the sticky session
identifier is **derived from a hash of the credential** rather than randomly
generated, so an identity keeps the same egress address across restarts and
redeploys. A random identifier would silently defeat this.

Each identity carries independent health state ([`pool.ts`](src/identity/pool.ts)):

- **Selection** is least-recently-used among healthy identities, so load spreads
  evenly rather than concentrating on whichever is first.
- **A block** triggers exponential backoff — 1, 2, 4, 8 minutes, capped at one
  hour — with ±20% jitter, so multiple instances do not retry in lockstep.
- **Five consecutive blocks quarantine** the identity. Continuing to retry a
  credential that has already been flagged is how a temporary restriction
  becomes a permanent one.
- **Transient network errors do not trigger backoff.** Only genuine upstream
  rejection (`999`/`429`/`403`/`401`) does.
- `GET /health` reports per-identity state with proxy credentials stripped.

The proxy layer is provider-agnostic: everything is a standard
`http://user:pass@host:port` URL, the lowest common denominator across
commercial providers and self-hosted alternatives. For providers offering sticky
sessions, `PROXY_STICKY_TEMPLATE` substitutes `{session}`:

```bash
PROXY_STICKY_TEMPLATE=http://USER-session-{session}:PASS@gateway.example.com:7000
```

Residential proxies are close to mandatory at any scale: datacenter address
ranges are flagged aggressively, and the service will operate considerably
longer through residential addresses than without.

### Object storage rather than a database

The access pattern is a pure key/value get-or-fetch. There is no query surface,
no joins and no transactions. Object storage needs no connection pool on cold
start, costs nothing when idle, and provides lifecycle expiry without additional
machinery. Cache entries are schema-versioned, so a breaking change to the
response shape invalidates prior entries automatically rather than serving
stale-shaped JSON.

### Security

- Credentials are held in the platform's secret store and injected at runtime;
  none are committed, and none appear in build logs.
- The logger redacts `cookie`, `x-api-key` and `authorization` headers.
- `/health` reports proxy *hostnames* only; credentials are stripped before
  serialisation, and this is covered by a test.
- API keys are compared in constant time.
- The storage bucket has public-access prevention and uniform bucket-level
  access.
- The service account holds object-level access to **one bucket** and read
  access to **named secrets** — not project-wide roles.
- The container runs as a non-root user.
- Identifiers are validated against a strict character set and URL-encoded
  before use as storage paths, so a crafted vanity name cannot escape the
  bucket prefix. This too is covered by a test.

---

## Running it yourself

**Requirements:** Node.js 20 or newer, and a LinkedIn account.

```bash
git clone https://github.com/tchandrakar/tross-assignment.git
cd tross-assignment
npm install
cp .env.example .env
```

Add credentials to `.env`, then establish a session:

```bash
npm run login
```

This signs in over HTTP — no browser — prompts for a verification code if
LinkedIn asks for one, confirms the result against the upstream API, and writes
the session to `.sessions/`.

The service does this for itself on first use. Running it by hand is useful for
two things the service cannot do alone: establishing the session from a network
LinkedIn already trusts (which avoids the challenge a first sign-in from a
datacenter address usually triggers), and answering a challenge at a prompt.

```bash
npm run dev
```

The service listens on `http://localhost:8080`, with documentation at `/docs`.

Once the session exists, `LI_PASSWORD` can be removed from `.env` for normal
operation — it is read only when no valid session is available.

> `.sessions/` contains a live session cookie jar. It is gitignored and written
> mode `0600`. Treat it as a credential.

```bash
npm test          # 126 unit tests, no network access required
npm run typecheck # strict tsc
npm run build     # compile to dist/
```

### Configuration

Full reference in [`.env.example`](.env.example). The significant options:

| Variable | Default | Purpose |
|---|---|---|
| `LI_EMAIL` / `LI_PASSWORD` | — | Used to establish a session when none exists |
| `SESSION_IDENTITIES` | — | Comma-separated identity labels whose sessions live in object storage. The production form: no credential in the service configuration at all |
| `IDENTITY_LABEL` | `primary` | Names the identity, and keys its stored session |
| `SESSION_STATE_DIR` | `.sessions` | Where session state is persisted locally |
| `LI_COOKIES` | — | A captured `cookie:` header, used as a one-time bootstrap seed |
| `ALLOW_AUTO_LOGIN` | `false` | Whether the instance may sign in itself. See [Session handling](#following-session-token-rotation) |
| `ENABLE_PUBLIC_FALLBACK` | `true` | Fall back to the public page when no session is available |
| `SCRAPE_RATE_PER_MINUTE` | `5` | New profile fetches per minute |
| `CLIENT_RATE_PER_MINUTE` | `10` | Requests per minute per caller |
| `GLOBAL_RATE_PER_MINUTE` | `20` | Total requests per minute |
| `CACHE_ENABLED` | `true` | Set `false` in development, where a cached copy would mask whether a parser change worked |
| `CACHE_TTL_SECONDS` | `604800` | Cache lifetime. `0` disables expiry |
| `GCS_BUCKET` | — | Object storage for the cache and session state. In-process LRU when unset |
| `API_KEYS` | — | Comma-separated keys required as `x-api-key`. Unauthenticated when empty |
| `PROXY_URLS` / `PROXY_STICKY_TEMPLATE` | — | Proxy pool configuration |

---

## Deployment

Deployed to a Compute Engine instance behind Caddy, which terminates TLS with
automatically provisioned and renewed certificates.

A virtual machine was chosen over a serverless runtime for two reasons specific
to this workload:

- **A stable egress address.** The upstream correlates a session with the
  address it was established from, so a fixed address is what the
  identity-binding design requires. Serverless runtimes egress from rotating
  address pools, which makes every request look like it came from somewhere new.
- **A persistent volume** for the session jar, so a redeploy does not discard an
  established session and force a sign-in — the most challenge-prone thing the
  service does.

The container is a plain `node:22-alpine` image at 289 MB. An earlier revision
of this service bundled Chromium and came to roughly 2 GB, needed 2 GB of
memory, and paid a multi-second browser launch on cold start.

The rate limiters and identity health are per-process, so the deployment runs a
single instance. Horizontal scaling requires moving that state to a shared store
first; this is a deliberate, documented trade-off rather than an oversight.

### Continuous deployment

`.github/workflows/deploy.yml` runs on every push to `main`:

```
test ─▶ build image ─▶ push to registry ─▶ publish session ─▶ roll out ─▶ verify
```

Verification checks container health on the host first, so a DNS or certificate
problem is reported as itself rather than as a failed rollout. The public HTTPS
check is non-fatal for the same reason.

```bash
./scripts/smoke.sh https://linkedin.viral-engine.ai
```

The smoke test verifies the contract rather than merely that a port is open:
liveness, health, OpenAPI availability, rejection of non-profile URLs, rejection
of a missing parameter, a full profile fetch, and a cache hit on repeat.

### Postman collection

A runnable collection lives in [`postman/`](postman/) — 12 requests with
assertions on every response and examples captured from the live service.

```bash
npm run postman
```

See [`postman/README.md`](postman/README.md) for import instructions and what
the assertions cover.

### Running under Docker

```bash
docker build -t linkedin-profile-api .
docker run -p 8080:8080 --env-file .env linkedin-profile-api
```

---

## Known limitations

Engineering limitations, with the reason and the consequence for a consumer of
the API.

### Data completeness

- **The service sees what its account can see.** Upstream visibility rules apply
  exactly as they do in a browser: distant connections show truncated
  experience, out-of-network profiles may show very little, and members can hide
  sections entirely. **An empty section is frequently a privacy setting rather
  than a defect** — `meta.missingSections` exists so a consumer can tell the two
  apart.
- **Connection and follower counts are `null`.** The endpoint that supplied
  them has been withdrawn (`410 Gone`), and the current profile decoration does
  not carry them. Reported as `null` rather than guessed.
- **Skill endorsement counts are usually `null`.** The profile graph returns
  skills without counts; obtaining them requires a request per skill, which is
  not a good use of the fetch budget.
- **Recommendations, contact details and post activity are not extracted.** Each
  requires its own endpoint and its own fetch budget.
- **Sections are limited to the first page.** Profiles with very many entries
  may be truncated by the upstream's own pagination; additional pages are not
  requested.
- **Grouped multi-role positions are flattened.** Several roles at one employer
  are returned as standalone entries with the company inherited; the grouping
  itself is not preserved in the response.
- **Media URLs are signed and expire**, typically after about 30 days.
  `expiresAt` is reported on every image. Consumers needing permanence must
  re-host the bytes.

### Operational

- **Single instance.** Rate limiters and identity health live in process memory,
  so the configured limits are only accurate for one instance. Horizontal
  scaling requires moving that state to Redis first.
- **Sign-ins are the risk, not requests.** A sign-in from a datacenter address
  is challenged nearly every time, and repeated challenged sign-ins are what
  gets an account restricted — as happened to the account used during
  development. The service therefore does **not** sign in by itself unless
  `ALLOW_AUTO_LOGIN=true`; it expects a session established from a trusted
  network and uploaded. Fetching profiles with an established session is far
  less risky than establishing one.
- **One process per session.** Two instances sharing stored session state would
  rotate the upstream token out from under each other — the same
  stale-replay failure described above, self-inflicted. This was observed
  directly during development when a local process and the deployed instance
  shared one session.
- **Unattended sign-in can be challenged.** Automatic sign-in works and is the
  normal recovery path, but the upstream challenges sign-ins from unfamiliar
  networks — which a datacenter address is by definition. When that happens the
  service keeps the cookie jar holding the challenge and reports it on
  `/health`; the emailed code is submitted to
  `POST /v1/admin/session/challenge`. A CAPTCHA cannot be answered over HTTP and
  needs a session established elsewhere and supplied via `LI_COOKIES`. A circuit
  breaker suspends automatic sign-in after repeated failures, because retrying a
  rejected credential cannot succeed and moves the account towards a lockout.
- **Cold start pays for a sign-in.** The first request after a restart
  establishes a session before it can fetch. Measured at 2.3s cold and under a
  second warm once the session is stored.
- **In-memory cache when object storage is unconfigured** — adequate for local
  development, not across instances.

### Upstream coupling

- **Endpoints are withdrawn without notice.** `/profileView` and `/networkinfo`
  returned complete data for years and now return `410 Gone`. The strategy chain
  limits the blast radius of any single withdrawal; it cannot prevent them.
- **Response shapes change without notice.** Parsers are written defensively —
  every field access is optional with fallbacks — and `meta.missingSections`
  surfaces partial extraction rather than hiding it. A shape change still
  requires a code change.
- **Automated access is actively detected.** Approaches that work today may stop
  working. TLS and header fidelity, cookie-rotation handling and identity
  binding substantially extend the useful life of a session, but none of it is
  permanent. A client that presents as a browser is still not one, and the gap
  is measurable if someone chooses to measure it.

---

## Legal and compliance

Automated collection of LinkedIn data is inconsistent with the
[LinkedIn User Agreement](https://www.linkedin.com/legal/user-agreement) §8.2,
irrespective of whether the data is publicly visible. *hiQ Labs v. LinkedIn*
established that scraping publicly accessible data is not a Computer Fraud and
Abuse Act violation in the United States, but that is a finding on criminal
liability, not authorisation: LinkedIn enforces its terms contractually and
terminates accounts.

Profile data concerning identifiable individuals is personal data under the GDPR
and India's DPDP Act. Collecting it engages those regimes independently of what
any platform permits, and a production deployment would require a lawful basis,
a retention policy and a subject-access process.

Accordingly, this service is built for evaluation. It uses a dedicated account,
enforces a conservative fetch ceiling, caches aggressively to minimise upstream
traffic, and is not intended for bulk collection or redistribution of personal
data.

---

## Project layout

```
src/
├── index.ts                      entrypoint, graceful shutdown
├── server.ts                     HTTP app, auth, rate limits, error handling
├── config.ts                     environment parsing — the only module reading secrets
├── errors.ts                     error taxonomy → HTTP status mapping
├── openapi.ts                    OpenAPI document generated from the Zod schemas
├── schema/profile.ts             the public response contract
├── linkedin/
│   ├── http/
│   │   ├── client.ts             Chrome-shaped transport: TLS, HTTP/2, header order
│   │   ├── cookie-jar.ts         session-token rotation and clearance detection
│   │   ├── login.ts              browser-free sign-in and challenge submission
│   │   └── session.ts            session lifecycle, keepalive, circuit breaker
│   ├── url.ts                    profile URL → identifier
│   ├── endpoints.ts              endpoint catalogue (no GraphQL queryIds)
│   ├── normalize.ts              normalized-graph rehydration
│   ├── scraper.ts                transport and the strategy chain
│   └── parse/
│       ├── common.ts             dates, media, union unwrapping
│       ├── dash-profile.ts       primary profile-graph parser
│       └── profile-view.ts       legacy REST parser
├── identity/
│   ├── pool.ts                   identity rotation, health, orchestration
│   └── proxy.ts                  provider-agnostic proxy plumbing
├── session/
│   ├── store.ts                  cookie-jar persistence (filesystem + object storage)
│   └── login-cli.ts              `npm run login`
├── cache/{gcs,memory}.ts         profile cache and local fallback
├── ratelimit/
│   ├── sliding-window.ts         shared limiter primitives
│   └── scrape-limiter.ts         upstream fetch ceiling
├── service/profile-service.ts    cache-first read path, request collapsing
└── routes/                       HTTP layer
```

