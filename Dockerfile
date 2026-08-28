# ─── Build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN npm prune --omit=dev

# ─── Runtime ─────────────────────────────────────────────────────────────────
# A plain Node image. The service talks to LinkedIn over HTTP and launches no
# browser, so there is no Chromium and none of the system libraries it drags in
# — roughly 1.5 GB of image and ~300 MB of resident memory that an earlier,
# browser-based revision of this service required.
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Owned by the app user so the mounted session volume is writable after the
# privilege drop.
RUN mkdir -p /app/.sessions && chown -R node:node /app/.sessions

USER node

EXPOSE 8080

# Liveness only — deliberately touches no dependency, so an upstream problem
# cannot cause the platform to recycle an otherwise healthy container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
