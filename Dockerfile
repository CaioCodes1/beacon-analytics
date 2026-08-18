# Build em estágios: as ferramentas de compilação (TypeScript, tipos) não têm
# motivo para viajar até produção. A imagem final leva só o JavaScript gerado e
# as dependências de runtime.

FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# --- Runtime -----------------------------------------------------------------

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# As migrations são arquivos .sql: o build do TypeScript não as copia.
COPY src/db/migrations ./dist/db/migrations

# Não rodar como root é o mínimo; a imagem base já traz o usuário `node`.
USER node

EXPOSE 3333

# Healthcheck bate no endpoint que verifica o banco, não só se a porta abriu.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3333/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
