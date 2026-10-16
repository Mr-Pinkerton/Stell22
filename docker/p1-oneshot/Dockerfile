# Reviewed recipe for the P1 one-shot migrator.
# Building this image on a production host is a separate authorization.
# The production operator does not build, download, or retag it.
# The tag stell22-p1-oneshot:node22 is not an identity.
# Approve the resulting image id in /var/lib/stell22/p1-oneshot-image-pin.json.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/migrator
RUN npm install --omit=dev --no-audit --no-fund prisma@6.19.3
