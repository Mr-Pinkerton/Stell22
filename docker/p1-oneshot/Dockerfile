# Reviewed recipe for the P1 one-shot migrator.
# Building this image on a production host is a separate authorization.
# The production operator does not build or retag it.
# The tag stell22-p1-oneshot:node22 is not an identity.
# Approve the resulting image id in /var/lib/stell22/p1-oneshot-image-pin.json.
#
# Base registry digest verified 2026-10-16:
#   docker buildx imagetools inspect docker.io/library/node:22-bookworm-slim
#   Digest: sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
# linux/amd64 manifest inside that index:
#   sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562
# Source: nodejs/docker-node 81f419144a1251854c6d9afb09eaa39928e724e8
# node -p process.version on this digest: v22.23.3
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# OS packages are taken from snapshot.debian.org, not the live Debian mirror.
# The base image comments snapshot 20261005T000000Z. That exact id is not published.
# These timestamps exist, and the three debs were present on the security snapshot.
# Apt still verifies the Debian archive signature. The historical Release file is
# past Valid-Until, so only that date check is disabled.
# This is not a claim of byte-for-byte image reproducibility.
# npm ci runs the locked Prisma install script, which fetches the engine for
# the build platform. The npm tarball integrity is locked; the engine blob is not
# stored in this repository.
RUN set -eux \
 && printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261005T023518Z bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261005T020725Z bookworm-security main' \
      > /etc/apt/sources.list \
 && rm -rf /etc/apt/sources.list.d \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      openssl=3.0.22-1~deb12u1 \
      ca-certificates=20250419~deb12u1 \
      libssl3=3.0.22-1~deb12u1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/migrator
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
