# Game server image: builds the client and server bundles, then runs the server alone.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist/index.html /app/dist/server.mjs ./dist/
EXPOSE 8080
USER node
CMD ["node", "dist/server.mjs"]
