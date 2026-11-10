# The image every part is built from (score/*.score.yaml say `image: .`; the release pins it by digest).
# CI builds first (pnpm build, then pnpm release-out, which deploys the service with its production
# dependencies into out/), so the image only copies the result and needs no registry token. The
# frontend is not in it: it is released as a bundle of its own, which the shell serves.
FROM node:22-alpine
WORKDIR /app
COPY out/ .
ENV NODE_ENV=production
# A user other than root, as a number (the runner refuses root, and a name could be root in the image's
# own user list). The runner starts every part with a read-only filesystem: the service writes nothing
# outside /tmp and its scratch folder.
USER 10001
CMD ["node", "dist/index.js"]
