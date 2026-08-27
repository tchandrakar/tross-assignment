#!/usr/bin/env bash
#
# Runs ON the VM. Copied there by CI along with docker-compose.yml, Caddyfile
# and the rendered .env, then executed over SSH.
#
# It lives in a file rather than inline in the workflow because the inline
# version needed three levels of shell quoting to interpolate GitHub
# expressions, which is how the previous revision shipped two silent bugs.

set -Eeuo pipefail

APP_DIR=/opt/linkedin-api
STAGING="${HOME}/deploy-staging"
REGISTRY_HOST="${1:?usage: rollout.sh <registry-host>}"

log() { printf '  → %s\n' "$*"; }

log "installing deployment files"
sudo mkdir -p "$APP_DIR"
# `cp -a src/.` copies dotfiles too. A plain `*` glob silently skips .env,
# which then fails later with a confusing "no such file" on chmod.
sudo cp -a "${STAGING}/." "$APP_DIR/"
# Deliberately NOT removing "$STAGING" here: this script is executing from it,
# and bash reads a script incrementally — deleting it mid-run can truncate
# execution. CI clears staging before each copy instead.
sudo chown -R root:root "$APP_DIR"
sudo chmod 600 "${APP_DIR}/.env"

cd "$APP_DIR"

log "authenticating docker to ${REGISTRY_HOST}"
# `gcloud auth configure-docker` writes to the *invoking* user's config, which
# `sudo docker` never reads. Hand root a short-lived token instead.
gcloud auth print-access-token \
  | sudo docker login -u oauth2accesstoken --password-stdin "https://${REGISTRY_HOST}" >/dev/null

log "pulling images"
sudo docker compose pull --quiet

log "starting containers"
sudo docker compose up -d --remove-orphans

log "pruning old images"
sudo docker image prune -f >/dev/null

log "containers:"
sudo docker compose ps
