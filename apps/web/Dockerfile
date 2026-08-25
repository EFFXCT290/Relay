# syntax=docker/dockerfile:1.7

# ─── deps ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --filter @relay/web... --frozen-lockfile

# ─── build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /repo/packages/contracts/node_modules ./packages/contracts/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts
COPY design ./design
COPY mocks ./mocks
RUN cd apps/web && pnpm build

# ─── runtime ─────────────────────────────────────────────────────────────────
# WORKDIR stays /repo (not /app) and the apps/packages layout is preserved so
# pnpm's workspace symlink to packages/contracts (and its own node_modules
# pointing back into the root .pnpm store) still resolves at runtime.
FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production
RUN apk add --no-cache tini
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /repo/apps/web/.next ./apps/web/.next
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/apps/web/package.json ./apps/web/package.json
COPY --from=build /repo/packages/contracts ./packages/contracts
WORKDIR /repo/apps/web
EXPOSE 3000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
