#!/usr/bin/env bash
#
# Post-deploy smoke test. Verifies the contract, not just that the port is open.
#
#   ./scripts/smoke.sh https://linkedin.viral-engine.ai [profile-url]

set -Eeuo pipefail

BASE="${1:?usage: smoke.sh <base-url> [profile-url]}"
PROFILE="${2:-https://www.linkedin.com/in/williamhgates/}"
AUTH=()
[[ -n "${API_KEY:-}" ]] && AUTH=(-H "x-api-key: ${API_KEY}")

pass() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

code() { curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$@"; }

[[ "$(code "${BASE}/healthz")" == "200" ]] || fail "liveness probe failed"
pass "liveness"

curl -s "${BASE}/health" | python3 -m json.tool >/dev/null || fail "health returned invalid JSON"
pass "health returns JSON"

[[ "$(code "${BASE}/docs")" == "200" ]] || fail "docs unreachable"
pass "openapi docs served"

[[ "$(code "${BASE}/v1/profile?url=https%3A%2F%2Fwww.linkedin.com%2Fcompany%2Fgoogle")" == "400" ]] \
  || fail "company URL should be rejected with 400"
pass "rejects non-profile URLs"

[[ "$(code "${BASE}/v1/profile")" == "400" ]] || fail "missing url should be 400"
pass "rejects missing url"

echo
echo "Fetching ${PROFILE} …"
RESPONSE="$(curl -s "${AUTH[@]}" --get --data-urlencode "url=${PROFILE}" "${BASE}/v1/profile")"
echo "$RESPONSE" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if not d.get("success"):
    print("  error:", json.dumps(d.get("error"), indent=2)); sys.exit(1)
p, m = d["data"], d["meta"]
print(f"  name:        {p.get(\"fullName\")}")
print(f"  headline:    {(p.get(\"headline\") or \"\")[:70]}")
print(f"  location:    {p[\"location\"].get(\"full\")}")
print(f"  experience:  {len(p[\"experience\"])} entries")
print(f"  education:   {len(p[\"education\"])} entries")
print(f"  skills:      {len(p[\"skills\"])}")
print(f"  source:      {m[\"source\"]}  cached={m[\"cached\"]}  {m[\"durationMs\"]}ms")
' || fail "profile fetch failed"
pass "profile fetch"

echo
echo "Re-fetching to confirm the cache serves it …"
curl -s "${AUTH[@]}" --get --data-urlencode "url=${PROFILE}" "${BASE}/v1/profile" \
  | python3 -c 'import sys,json; m=json.load(sys.stdin)["meta"]; assert m["cached"], "second request was not a cache hit"; print(f"  cached={m[\"cached\"]} age={m[\"ageSeconds\"]}s {m[\"durationMs\"]}ms")' \
  || fail "cache did not serve the repeat request"
pass "cache hit on repeat request"
