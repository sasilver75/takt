FROM node:24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates chromium fonts-liberation git openssh-client \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium \
    CHROMIUM_BIN=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN corepack enable \
  && corepack prepare pnpm@9.15.9 --activate \
  && npm install -g @openai/codex@0.130.0

COPY docker/symphony-capture-url /usr/local/bin/symphony-capture-url
RUN chmod 0755 /usr/local/bin/symphony-capture-url

WORKDIR /workspace

CMD ["codex", "app-server"]
