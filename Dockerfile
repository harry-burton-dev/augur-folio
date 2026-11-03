# The service image. CI builds first (pnpm build, then pnpm release-out, which deploys the service with
# its production dependencies into out/ and puts the built frontend in out/frontend), so the image only
# copies the result and needs no registry token. The service gives its frontend to the registry when it
# starts (the service kit's publishFrontend).
FROM node:22-alpine
WORKDIR /app
COPY out/ .
ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
