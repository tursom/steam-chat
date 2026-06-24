FROM node:26-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json config.example.js ./
COPY src ./src
COPY web ./web

RUN npm run build \
  && npm prune --omit=dev

FROM node:26-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV STEAM_CHAT_DATA_DIR=/app/data
ENV STEAM_CHAT_HOST=0.0.0.0
ENV STEAM_CHAT_PORT=3000

WORKDIR /app
RUN mkdir -p /app/data \
  && chown -R node:node /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
