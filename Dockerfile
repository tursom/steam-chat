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

WORKDIR /app
RUN chown node:node /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/config.example.js ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
