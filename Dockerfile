# Прод-образ Stell22: Next.js (Node-рантайм) + Prisma.
# Debian-slim выбран из-за надёжной поддержки движков Prisma (openssl).

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

# --- Рантайм: только то, что нужно для запуска ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
# node_modules с @prisma/client и CLI нужны для `prisma migrate deploy` при старте.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
