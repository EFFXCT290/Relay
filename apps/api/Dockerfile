# syntax=docker/dockerfile:1.7

# ─── deps ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --filter @relay/api... --frozen-lockfile

# ─── build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /repo/packages/contracts/node_modules ./packages/contracts/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages/contracts ./packages/contracts
RUN cd apps/api && pnpm prisma generate && pnpm build

# ─── runtime ─────────────────────────────────────────────────────────────────
# WORKDIR stays /repo (not /app) and the apps/packages layout is preserved so
# pnpm's workspace symlinks (apps/api/node_modules/@relay/contracts -> ../../..
# /packages/contracts, and its own node_modules/@sinclair/typebox -> the root
# .pnpm store) still resolve — flattening into /app would leave them dangling.
FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production
RUN apk add --no-cache tini
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build /repo/packages/contracts ./packages/contracts
WORKDIR /repo/apps/api
EXPOSE 3001
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
