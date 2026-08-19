FROM emscripten/emsdk:4.0.15 AS core-build

WORKDIR /app
COPY core ./core
COPY scripts ./scripts
RUN EMSDK_DIR=/emsdk bash scripts/build-core.sh

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=core-build /app/core/dist ./core/dist
COPY auth ./auth
COPY lib ./lib
COPY roms ./roms
COPY web ./web
COPY server.mjs README.md LICENSE THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /app/data /app/roms \
    && chown -R node:node /app \
    && chmod -R u=rwX,go=rX /app

USER node
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
