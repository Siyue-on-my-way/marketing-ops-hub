# backend — hub 本地中控 + maitian-cloud 同镜像双用途（compose 以 command 区分）。
# 零第三方依赖（node:sqlite / node:http，无需安装步骤）。
# Node 22（规格表写 Node 20；node:sqlite 需 ≥22.5，为保持零依赖选择升级基线，已注明）。
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY cloud ./cloud
# 知识包：单一来源 content-hub/docs/knowledge，经 compose additional_contexts 带入（防两份漂移）
COPY --from=knowledge docs/knowledge /app/knowledge
ENV NODE_ENV=production
EXPOSE 8787
# slim 镜像无 curl，用 node 自身探测 /api/health（hub）；maitian-cloud 服务在 compose 内覆写 healthcheck
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/hub.mjs", "serve"]
