FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
RUN \
  if [ -f yarn.lock ]; then yarn --frozen-lockfile; \
  elif [ -f package-lock.json ]; then npm ci; \
  elif [ -f pnpm-lock.yaml ]; then yarn global add pnpm && pnpm i --frozen-lockfile; \
  else echo "Lockfile not found." && exit 1; \
  fi


# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
# ENV NEXT_TELEMETRY_DISABLED 1

RUN npm run build
# The watcher and the photo CLIs, bundled into dist/scripts with everything
# but Sharp, so the runner needs no dev node_modules and no tsx
RUN npm run build:scripts

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

# Install wget for healthcheck
RUN apk add --no-cache wget

ENV NODE_ENV=production
# Uncomment the following line in case you want to disable telemetry during runtime.
# ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
# The standalone output carries package.json too.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The image watcher, its healthcheck, and the photo CLIs, run with plain node
COPY --from=builder /app/dist/scripts ./dist/scripts

# Sharp stays out of those bundles, since it loads the libvips build for this
# platform from @img. Copy it whole, with the packages it needs at run time,
# whatever the web server's trace picked up, and fail the build here if one
# is missing. A new Sharp release can change that list.
COPY --from=deps /app/node_modules/sharp ./node_modules/sharp
COPY --from=deps /app/node_modules/@img ./node_modules/@img
COPY --from=deps /app/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=deps /app/node_modules/semver ./node_modules/semver
RUN node -e "require('sharp')"

# The data root's mount point, owned by the containers' user.
# docker-compose.prod.yml binds ./portfolio-data over it. Don't use a named
# volume here: one is silently recreated empty after `down -v`, which leaves
# an empty data root beside a library that had photo IDs.
RUN mkdir -p /data/portfolio && chown nextjs:nodejs /data/portfolio

USER nextjs

EXPOSE 3000

ENV PORT=3000
# Bind every interface inside the container. The compose file decides what's
# published, and it publishes on the host's loopback only.
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
