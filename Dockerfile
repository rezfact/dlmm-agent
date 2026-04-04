FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
# postinstall runs patch-anchor.js — scripts must exist before npm ci
COPY scripts ./scripts/
RUN npm ci

COPY . .

ENV NODE_ENV=production

CMD ["node", "index.js"]
