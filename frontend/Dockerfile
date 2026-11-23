# frontend — 大屏（零依赖单页）。多阶段构建（模板规范）。
# 页面单一来源在 backend/src/static/index.html，经 compose additional_contexts(backend-shared)
# 带入构建，禁止复制两份（防漂移）。本项目无 npm 依赖，NPM_REGISTRY build-arg 保留以统一模板。
FROM node:22-alpine AS build
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /build
RUN mkdir -p dist
COPY --from=backend-shared src/static/index.html dist/index.html

FROM nginx:alpine
COPY nginx-frontend.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO /dev/null http://127.0.0.1/ || exit 1
