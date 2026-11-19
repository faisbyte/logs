# One image for the self-host stack (compose.yaml): the digest server, its scheduled jobs, and the dashboard.
# Build: docker build -t logs .   It holds no secrets; keys come from the environment at run time.

FROM node:22.19.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN corepack install && pnpm install --frozen-lockfile
# The packages, then the dashboard (next/font downloads its fonts here, at build time).
RUN pnpm build && pnpm --filter @digest/web build
# Leave out what only tests use.
RUN rm -rf packages/*/test apps/web/test apps/web/e2e

FROM node:22.19.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
# The admin command, on the PATH: docker compose exec server sprintdigest-server token ...
RUN ln -s /app/packages/server/dist/main.js /usr/local/bin/sprintdigest-server && chmod +x /app/packages/server/dist/main.js
USER node
# The server by default; compose runs the dashboard and the jobs from the same image.
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787 3000
CMD ["sprintdigest-server", "serve"]
