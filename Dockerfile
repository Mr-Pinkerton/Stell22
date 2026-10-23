# Образ приложения Stell22: Next.js (Node-рантайм) + Prisma.
# Debian-slim выбран из-за надёжной поддержки движков Prisma (openssl).
#
# DEVELOPMENT CANDIDATE. Not a production release.
# Normal startup validates configuration, database role, schema, and migration
# history, then starts Next.js. It does not apply schema changes.
# HARD RELEASE BLOCKER: the current production login is incompatible with
# this gate. Do not deploy until a role split and the deploy procedure are
# accepted in a later reviewed package.

FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# --- Зависимости (кэшируются, пока не меняются package*.json) ---
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# --- Сборка приложения ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# --- Рантайм: только то, что нужно для запуска без миграций ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
# node_modules нужны Next.js, клиенту Prisma и read-only gate (tsx).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY docker-entrypoint-app-only.sh ./docker-entrypoint-app-only.sh
RUN chmod +x docker-entrypoint-app-only.sh
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint-app-only.sh"]
