# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --chown=0:0 --chmod=0644 package.json package-lock.json ./
RUN npm ci --registry=https://registry.npmjs.org
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3210 \
    WORKBENCH_HOST=0.0.0.0 \
    WORKBENCH_DATA=/app/.data
WORKDIR /app
COPY --chown=0:0 --chmod=0644 package.json package-lock.json ./
RUN npm ci --omit=dev --registry=https://registry.npmjs.org \
    && npm cache clean --force \
    && mkdir -p /app/.data \
    && chown node:node /app/.data
COPY --from=build --chown=0:0 /app/build ./build
COPY --from=build --chown=0:0 /app/dist ./dist
# Normalize application code only; production data is a separate bind mount.
RUN chmod -R u=rwX,go=rX /app/build /app/dist /app/node_modules
USER node
RUN node -e "const f=require('node:fs');if(process.getuid()!==1000)throw Error('Expected node UID');for(const p of ['package.json','package-lock.json','build/server/index.js','dist/index.html'])f.accessSync(p,f.constants.R_OK)"
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3210/api/health',{signal:AbortSignal.timeout(4000)}).then(async r=>{if(!r.ok||!(await r.json()).ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "build/server/index.js", "--production"]
