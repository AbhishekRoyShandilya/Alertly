# One image, three processes: the same image runs the API, the worker or the scheduler
# depending on the command (see docker-compose.yml / render.yaml).
# Build from the repo root:  docker build -f apps/api/Dockerfile -t alertly-api .

# ---- build: install everything, bundle with esbuild
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --workspace=@alertly/api --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @alertly/api

# ---- runtime: production dependencies + the bundles + SQL migrations only
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --workspace=@alertly/api && npm cache clean --force
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations

WORKDIR /repo/apps/api
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
