# ItAgentBack 映像檔(endpoint-server:管理 API 51240、Agent 通道 51241;機密一律以 *_FILE 指向 Docker secret,不寫進映像檔)
# 建置 context 為 RustIt 根目錄(需要 docs/contracts/ 的 JSON Schema):
#   docker build -f ItAgentBack/Dockerfile --secret id=npm_token,env=GITLAB_NPM_TOKEN .
FROM node:22-alpine AS build
WORKDIR /app
COPY ItAgentBack/package.json ItAgentBack/package-lock.json ItAgentBack/.npmrc ./
# @giganexus/* 取自公司 GitLab npm Registry:Token 以 BuildKit secret(npm_token)傳入,不留在映像層
RUN --mount=type=secret,id=npm_token GITLAB_NPM_TOKEN="$(cat /run/secrets/npm_token)" npm ci --no-audit --no-fund
COPY ItAgentBack/tsconfig.json ItAgentBack/tsconfig.build.json ./
COPY ItAgentBack/src/ src/
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=51240 AGENT_PORT=51241 CONTRACTS_DIR=/app/contracts
WORKDIR /app
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY ItAgentBack/package.json ./
COPY ItAgentBack/db/migrations/ db/migrations/
COPY docs/contracts/*.schema.json contracts/
USER node
EXPOSE 51240 51241
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:51240/healthz >/dev/null || exit 1
CMD ["node", "dist/src/server.js"]
