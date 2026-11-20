FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/adapters/package.json packages/adapters/package.json

RUN pnpm install --filter @matrixark/api... --frozen-lockfile

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN pnpm db:generate && pnpm --filter @matrixark/api... build

ENV NODE_ENV=production API_HOST=0.0.0.0
EXPOSE 4000

CMD ["node", "apps/api/dist/main.js"]
