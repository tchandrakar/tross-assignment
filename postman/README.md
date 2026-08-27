# Postman collection

A runnable collection for the LinkedIn Profile API: 12 requests across three
folders, with assertions on every response and saved examples captured from the
live service.

| File | Purpose |
|---|---|
| `LinkedIn-Profile-API.postman_collection.json` | The collection (Postman v2.1) |
| `LinkedIn-Profile-API.postman_environment.json` | `baseUrl`, `profileUrl`, `apiKey` |

## Import

Postman → **Import** → drop both files in → select the
**LinkedIn Profile API — Production** environment.

`baseUrl` defaults to `https://linkedin.viral-engine.ai`. Point it at
`http://localhost:8080` to run against a local instance; nothing else changes.

`apiKey` is stored as a **secret** variable, so Postman masks it and leaves it
out of exports. It is only needed when the deployment is configured with API
keys.

## Run from the command line

```bash
npm run postman
```

Uses [Newman](https://github.com/postmanlabs/newman), Postman's own CLI runner,
so the collection is verified the same way in CI and in the app.

`--delay-request 7000` is not cosmetic. The service allows 10 requests per
minute per caller and 5 new profile fetches per minute; running the collection
flat out would trip its own rate limit and report working endpoints as failures.
A single folder runs faster:

```bash
npx newman run postman/LinkedIn-Profile-API.postman_collection.json \
  -e postman/LinkedIn-Profile-API.postman_environment.json \
  --folder Operations
```

## What it covers

**Profile** — retrieval by URL and by bare vanity name, forced live fetch,
`POST` parity, typed rejection of a company URL, and cache eviction.

**Operations** — health with all three rate limit tiers, the liveness probe,
verification-code submission, and session reset.

**Reference** — the OpenAPI document, and a request that demonstrates the
per-caller rate limit without consuming any fetch budget (its URL is invalid on
purpose, so nothing reaches LinkedIn).

## What the assertions check

Beyond status codes, the tests assert the parts of the contract a client
actually depends on:

- Every array is present even when empty, so a client never has to branch on
  `undefined` before iterating.
- Dates are structured objects rather than preformatted strings.
- `x-cache` agrees with `meta.cached` — a disagreement would mean the header and
  the body were telling a client different things.
- `meta.source` is one of the documented extraction paths.
- Every `429` carries `retry-after`, because a client that has to guess a
  backoff is how a limiter turns into a retry storm.

Three paths sit outside the `success`/`data`/`meta` envelope by design, and the
collection-level test excludes them explicitly: `/health` and `/healthz` are
probes for orchestrators rather than API clients, and `/docs/json` is an
OpenAPI document whose shape the specification dictates.
