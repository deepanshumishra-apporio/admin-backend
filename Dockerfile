# The admin backend as a container: Node 24 runs the TypeScript directly, so there is no build step.
#   docker build -t admin-backend .
#   docker run -d --name admin-backend --restart unless-stopped --network host --env-file .env admin-backend
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production
USER node
CMD ["node", "--use-env-proxy", "--disable-warning=ExperimentalWarning", "src/server.ts"]
