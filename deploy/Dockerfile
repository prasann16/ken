FROM oven/bun:1.3-debian

WORKDIR /app

# sqlite3 + libsqlite3-dev so sqlite-vec extension can load
RUN apt-get update && apt-get install -y --no-install-recommends \
      sqlite3 libsqlite3-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --production

COPY src/ ./src/

ENV KEN_HOME=/data
ENV NODE_ENV=production

# Empty the macOS-default sqlite path; on Linux Bun's bundled SQLite handles extensions
ENV KEN_SQLITE_LIB=

EXPOSE 5556
CMD ["bun", "run", "src/cli.ts", "view", "--bind", "0.0.0.0", "--port", "5556", "--no-open"]
