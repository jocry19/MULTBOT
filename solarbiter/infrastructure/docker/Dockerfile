# syntax=docker/dockerfile:1.7
# SOLARBITER image (API + worker + static dashboard). Build from the solarbiter/ directory:
#   docker build -f infrastructure/docker/Dockerfile -t solarbiter .
# Behind a TLS-intercepting proxy, pass its CA (optional build secret):
#   docker build --secret id=extra_ca,src=/path/to/ca.crt --build-arg HTTPS_PROXY=$HTTPS_PROXY …

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
ENV NODE_USE_ENV_PROXY=1
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile
# typed build of every package, the API, the worker and the static dashboard export
RUN pnpm run build
# runtime dependencies only
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi; \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/web/.next \
 && pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    WEB_DIST_DIR=/app/apps/web/out \
    LOG_DIR=/app/logs
WORKDIR /app
RUN groupadd -r -g 10001 solarbiter && useradd -r -u 10001 -g solarbiter -d /app solarbiter \
 && mkdir -p /app/logs /app/secrets && chown solarbiter:solarbiter /app/logs /app/secrets
COPY --from=build --chown=solarbiter:solarbiter /app /app
USER solarbiter
EXPOSE 8788
# default: API; the worker overrides the command (see docker-compose.yml)
CMD ["node", "apps/api/dist/main.js"]
