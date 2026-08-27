# ─── Build ───────────────────────────────────────────────────────────────────
# The Playwright base image is used for both stages: it already carries the
# Chromium system libraries, and matching the image tag to the `playwright`
# npm version is what keeps the bundled browser and the client in step.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Re-resolve to production dependencies only.
RUN npm prune --omit=dev

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--enable-source-maps \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The base image ships a non-root `pwuser`; Cloud Run has no reason to run as root.
USER pwuser

EXPOSE 8080

# Liveness only — deliberately does not touch LinkedIn or GCS, so an upstream
# block can never make the platform recycle a healthy container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
