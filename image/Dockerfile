# Papermark for Railway: upstream at a pinned commit plus image/patches.
# Upstream ships no image and targets Vercel + Trigger.dev + Tinybird +
# Upstash; the patches swap those for in-process and Postgres stand-ins.
FROM node:24-bookworm-slim AS build

# bb93cfd (2026-04-29) is the newest upstream commit that builds from the
# public repo: every later main imports ee/ and lib/ modules that were never
# published (51 missing at ed19717, 2026-08-28).
ARG PAPERMARK_REF=bb93cfd03c7531f67cbb09a652e61c92de16d371

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates openssl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN git init -q && git remote add origin https://github.com/papermark/papermark.git \
    && git fetch -q --depth 1 origin "${PAPERMARK_REF}" && git checkout -q FETCH_HEAD \
    && rm -rf .git

COPY patches /patches
RUN node /patches/apply.mjs

RUN npm ci --no-audit --no-fund

# Next's production build of this app needs far more than Node's default heap.
ARG NODE_HEAP=12288

# NEXT_PUBLIC_* values are inlined at build time. The host is a placeholder
# that boot.sh rewrites to the deploy's real domain on every start. The
# webhook host only has to be non-empty (next.config uses it in a `has`
# rule) and never match: incoming webhooks need a second domain.
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=${NODE_HEAP} \
    NEXT_PUBLIC_BASE_URL=https://papermark-railway-host.invalid \
    NEXT_PUBLIC_MARKETING_URL=https://papermark-railway-host.invalid \
    NEXT_PUBLIC_APP_BASE_HOST=papermark-railway-host.invalid \
    NEXT_PUBLIC_UPLOAD_TRANSPORT=s3 \
    NEXT_PUBLIC_WEBHOOK_BASE_HOST=papermark-webhooks.invalid
# AI routes construct an OpenAI client at import, which throws without a key
# while Next collects page data. AI features are plan-gated off anyway.
RUN OPENAI_API_KEY=unset npm run build && rm -rf .next/cache

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app /app
COPY boot.sh /boot.sh
RUN chmod +x /boot.sh
EXPOSE 3000
CMD ["/boot.sh"]
