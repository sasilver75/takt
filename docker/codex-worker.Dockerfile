FROM node:24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@9.15.9 --activate \
  && npm install -g @openai/codex@0.130.0

WORKDIR /workspace

CMD ["codex", "app-server"]
