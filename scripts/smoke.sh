#!/usr/bin/env bash
#
# Post-deploy smoke test. Verifies the contract, not just that the port is open.
#
#   ./scripts/smoke.sh https://linkedin.viral-engine.ai [profile-url]

set -Eeuo pipefail

BASE="${1:?usage: smoke.sh <base-url> [profile-url]}"
PROFILE="${2:-https://www.linkedin.com/in/williamhgates/}"
# Expanded as "${AUTH[@]:-}" everywhere: under `set -u`, bash 3.2 (still the
# default on macOS) treats "${AUTH[@]}" on an empty array as an unbound
# variable and aborts.
AUTH=()
if [[ -n "${API_KEY:-}" ]]; then AUTH=(-H "x-api-key: ${API_KEY}"); fi
auth_args() { if [[ ${#AUTH[@]} -gt 0 ]]; then printf '%s\n' "${AUTH[@]}"; fi; }

pass() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# The service enforces a per-caller rate limit, and this script is a caller like
# any other. Rather than tripping it and reporting a false failure, honour it:
# on a 429, wait for the retry-after the service itself supplied.
MAX_RETRIES=6

code() {
  local attempt status
  for ((attempt = 1; attempt <= MAX_RETRIES; attempt++)); do
    if [[ ${#AUTH[@]} -gt 0 ]]; then
      status=$(curl -s -o /dev/null -D /tmp/.smoke-hdr -w '%{http_code}' "${AUTH[@]}" "$@")
    else
      status=$(curl -s -o /dev/null -D /tmp/.smoke-hdr -w '%{http_code}' "$@")
    fi
    [[ "$status" != "429" ]] && { printf '%s' "$status"; return; }
    sleep "$(retry_after)"
  done
  printf '%s' "$status"
}

get() {
  local attempt out
  for ((attempt = 1; attempt <= MAX_RETRIES; attempt++)); do
    if [[ ${#AUTH[@]} -gt 0 ]]; then
      out=$(curl -s -D /tmp/.smoke-hdr "${AUTH[@]}" "$@")
    else
      out=$(curl -s -D /tmp/.smoke-hdr "$@")
    fi
    if ! grep -qi '^HTTP/[0-9.]* 429' /tmp/.smoke-hdr 2>/dev/null; then
      printf '%s' "$out"
      return
    fi
    sleep "$(retry_after)"
  done
  printf '%s' "$out"
}

# Seconds to wait, taken from the response the service just sent.
retry_after() {
  local value
  value=$(grep -i '^retry-after:' /tmp/.smoke-hdr 2>/dev/null | tr -d '\r' | awk '{print $2}' | head -1)
  [[ "$value" =~ ^[0-9]+$ ]] && printf '%s' "$((value + 1))" || printf '5'
}

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
RESPONSE="$(get --max-time 240 --get --data-urlencode "url=${PROFILE}" "${BASE}/v1/profile")"
echo "$RESPONSE" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if not d.get("success"):
    print("  error:", json.dumps(d.get("error"), indent=2))
    sys.exit(1)
p, m = d["data"], d["meta"]
rows = [
    ("name",        p.get("fullName")),
    ("headline",    (p.get("headline") or "")[:70]),
    ("location",    p["location"].get("full")),
    ("experience",  "{} entries".format(len(p["experience"]))),
    ("education",   "{} entries".format(len(p["education"]))),
    ("skills",      len(p["skills"])),
    ("certs",       len(p["certifications"])),
    ("languages",   len(p["languages"])),
    ("images",      "profile={} background={}".format(bool(p["profilePicture"]), bool(p["backgroundImage"]))),
    ("source",      "{} cached={} {}ms".format(m["source"], m["cached"], m["durationMs"])),
]
for k, v in rows:
    print("  {:<12} {}".format(k + ":", v))
' || fail "profile fetch failed"
pass "profile fetch"

echo
echo "Re-fetching to confirm the cache serves it …"
get --max-time 120 --get --data-urlencode "url=${PROFILE}" "${BASE}/v1/profile" \
  | python3 -c '
import sys, json
m = json.load(sys.stdin)["meta"]
if not m["cached"]:
    print("  second request was NOT a cache hit:", json.dumps(m))
    sys.exit(1)
print("  cached={} age={}s {}ms".format(m["cached"], m["ageSeconds"], m["durationMs"]))
' || fail "cache did not serve the repeat request"
pass "cache hit on repeat request"
