# Docs site (docs.anycrawl.dev). Build from the repository root:
#   docker build -f apps/docs/Dockerfile -t anycrawl-docs .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /usr/src/app
COPY . .
# Only the docs package's dependencies; the api/scrape toolchain is not needed.
RUN --mount=type=cache,id=pnpm-docs,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter docs
ENV DOCS_STANDALONE=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter docs build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

LABEL org.opencontainers.image.source=https://github.com/any4ai/AnyCrawl
LABEL org.opencontainers.image.description="AnyCrawl documentation site"
LABEL org.opencontainers.image.licenses=MIT

# The standalone output mirrors the monorepo layout (tracing root = repo root).
COPY --from=build --chown=node:node /usr/src/app/apps/docs/.next/standalone ./
COPY --from=build --chown=node:node /usr/src/app/apps/docs/.next/static ./apps/docs/.next/static
COPY --from=build --chown=node:node /usr/src/app/apps/docs/public ./apps/docs/public
COPY --from=build --chown=node:node /usr/src/app/apps/docs/openapi.json ./apps/docs/openapi.json

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/en/general').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/docs/server.js"]
