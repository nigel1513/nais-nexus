# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@nais/web..."

FROM deps AS build
# NEXT_PUBLIC_* are inlined at build time: mock mode is a build switch (compose passes WEB_API_MOCKING).
ARG NEXT_PUBLIC_API_MOCKING=enabled
ARG NEXT_PUBLIC_API_BASE=/api/v1
ENV NEXT_PUBLIC_API_MOCKING=$NEXT_PUBLIC_API_MOCKING NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
COPY packages/contracts/ts packages/contracts/ts
COPY packages/ui packages/ui
COPY apps/web apps/web
RUN pnpm --filter @nais/web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S nais && adduser -S nais -G nais
COPY --from=build --chown=nais:nais /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nais:nais /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nais:nais /repo/apps/web/public ./apps/web/public
USER nais
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
