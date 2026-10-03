# syntax=docker/dockerfile:1.7
#
# MULTBOT — production image (API server + research worker + dashboard).
# Secrets are never baked into the image: API keys come from the environment, the wallet keystore
# and its passphrase from a mounted volume (see docker-compose.yml and README).

# base image is configurable (e.g. a registry mirror): --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /src

# dependency layer (cached until a manifest or the lockfile changes)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# Behind a TLS-intercepting proxy, pass its CA without baking it into the image:
#   docker build --secret id=extra_ca,src=/path/to/ca.crt .
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,id=pnpm,target=/pnpm/store \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi \
 && pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,id=pnpm,target=/pnpm/store \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi \
 && pnpm build \
 && pnpm --filter @multbot/server deploy --prod --legacy /out \
 && cp -r apps/web/dist /out/web

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8787 \
    WEB_DIST_DIR=/app/web \
    LOG_DIR=/app/logs \
    WALLET_KEYSTORE_PATH=/app/secrets/bot-wallet.keystore.json
WORKDIR /app
# application code stays root-owned (read-only for the runtime user); only logs/ and secrets/ belong to "node"
COPY --from=build /out /app
RUN mkdir -p /app/logs /app/secrets && chown node:node /app/logs /app/secrets && chmod 700 /app/secrets
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]
