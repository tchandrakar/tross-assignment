#!/usr/bin/env bash
#
# Idempotent deploy to Google Cloud Run. Safe to re-run.
#
#   ./scripts/deploy.sh
#
# Reads configuration from the environment (see the defaults below). Secrets are
# never passed as plain env vars — they are stored in Secret Manager and mounted
# into the service at runtime, so nothing sensitive lands in the service config,
# the build logs, or this repository.

set -Eeuo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-linkedin-profile-api}"
REPO="${REPO:-containers}"
BUCKET="${BUCKET:-${PROJECT_ID}-linkedin-profile-cache}"
SCRAPE_RATE_PER_MINUTE="${SCRAPE_RATE_PER_MINUTE:-5}"
CACHE_TTL_SECONDS="${CACHE_TTL_SECONDS:-604800}"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}"

log() { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ -n "$PROJECT_ID" ]] || die "PROJECT_ID is not set and no gcloud default project is configured."

log "Project: ${PROJECT_ID}   Region: ${REGION}   Service: ${SERVICE}"

# ─── 1. APIs ─────────────────────────────────────────────────────────────────
log "Enabling required APIs (no-op if already enabled)"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  --project "$PROJECT_ID" --quiet

# ─── 2. Artifact Registry ────────────────────────────────────────────────────
if ! gcloud artifacts repositories describe "$REPO" \
      --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  log "Creating Artifact Registry repository '${REPO}'"
  gcloud artifacts repositories create "$REPO" \
    --repository-format=docker --location "$REGION" \
    --description="Container images" --project "$PROJECT_ID" --quiet
fi

# ─── 3. Cache bucket ─────────────────────────────────────────────────────────
if ! gcloud storage buckets describe "gs://${BUCKET}" --project "$PROJECT_ID" >/dev/null 2>&1; then
  log "Creating cache bucket gs://${BUCKET}"
  # Uniform access + no public reads: scraped profile data is not world-readable.
  gcloud storage buckets create "gs://${BUCKET}" \
    --project "$PROJECT_ID" --location "$REGION" \
    --uniform-bucket-level-access --public-access-prevention --quiet
fi

# ─── 4. Secrets ──────────────────────────────────────────────────────────────
# LINKEDIN_IDENTITIES must already exist. Create it out-of-band with:
#   printf '%s' "$JSON" | gcloud secrets create linkedin-identities --data-file=-
require_secret() {
  gcloud secrets describe "$1" --project "$PROJECT_ID" >/dev/null 2>&1 \
    || die "Secret '$1' does not exist. See README §Deployment for how to create it."
}
require_secret linkedin-identities

SECRET_FLAGS="LINKEDIN_IDENTITIES=linkedin-identities:latest"

# Optional secrets — attached only when present.
for pair in "PROXY_URLS=proxy-urls" "PROXY_STICKY_TEMPLATE=proxy-sticky-template" "API_KEYS=api-keys"; do
  env_name="${pair%%=*}"; secret_name="${pair##*=}"
  if gcloud secrets describe "$secret_name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    log "Attaching optional secret '${secret_name}'"
    SECRET_FLAGS="${SECRET_FLAGS},${env_name}=${secret_name}:latest"
  fi
done

# ─── 5. Service account ──────────────────────────────────────────────────────
SA="${SERVICE}@${PROJECT_ID}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SA" --project "$PROJECT_ID" >/dev/null 2>&1; then
  log "Creating service account ${SA}"
  gcloud iam service-accounts create "$SERVICE" \
    --display-name "LinkedIn Profile API" --project "$PROJECT_ID" --quiet
fi

log "Granting least-privilege roles"
# Object-level access to the one cache bucket, not project-wide storage admin.
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA}" --role=roles/storage.objectAdmin \
  --project "$PROJECT_ID" --quiet >/dev/null

for secret in linkedin-identities proxy-urls proxy-sticky-template api-keys; do
  gcloud secrets describe "$secret" --project "$PROJECT_ID" >/dev/null 2>&1 || continue
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${SA}" --role=roles/secretmanager.secretAccessor \
    --project "$PROJECT_ID" --quiet >/dev/null
done

# ─── 6. Build ────────────────────────────────────────────────────────────────
TAG="$(date +%Y%m%d-%H%M%S)"
log "Building image ${IMAGE}:${TAG}"
gcloud builds submit --tag "${IMAGE}:${TAG}" --project "$PROJECT_ID" --quiet

# ─── 7. Deploy ───────────────────────────────────────────────────────────────
# --max-instances=1 is load-bearing, not a cost control: the scrape limiter and
# the identity cooldowns are per-process, so a second instance would silently
# double the rate actually hitting LinkedIn. See README §Rate limiting.
log "Deploying to Cloud Run"
gcloud run deploy "$SERVICE" \
  --image "${IMAGE}:${TAG}" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --platform managed \
  --allow-unauthenticated \
  --service-account "$SA" \
  --memory 2Gi \
  --cpu 2 \
  --timeout 120s \
  --concurrency 20 \
  --min-instances 0 \
  --max-instances 1 \
  --set-env-vars "NODE_ENV=production,GCS_BUCKET=${BUCKET},SCRAPE_RATE_PER_MINUTE=${SCRAPE_RATE_PER_MINUTE},CACHE_TTL_SECONDS=${CACHE_TTL_SECONDS},ENABLE_BROWSER_FALLBACK=true" \
  --set-secrets "$SECRET_FLAGS" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')"

# PUBLIC_BASE_URL is only known after the first deploy, so set it on a second pass.
gcloud run services update "$SERVICE" --region "$REGION" --project "$PROJECT_ID" \
  --update-env-vars "PUBLIC_BASE_URL=${URL}" --quiet >/dev/null

log "Deployed: ${URL}"
log "Docs:     ${URL}/docs"
log "Health:   ${URL}/health"
