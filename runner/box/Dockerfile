# The box image (docs/virtual-runners.md, "The box image"): what a virtual
# runner's machine boots to run one thread. The runner from this commit with
# its production packages, and Claude Code at a pinned version, both baked
# in, so a box's start doesn't spend 70 s installing them (the spike's cold
# start, runner/box/spike/README.md). Its entrypoint is the runner in box
# mode (entrypoint.sh); the service passes no command. No secrets: a box gets
# its key, its Claude token and its thread's key by the boot exchange.
#
# Built from the runner/ folder, so the context is that folder:
#   docker build -f runner/box/Dockerfile runner
# (runner/.dockerignore keeps the context to what's copied.) CI builds it
# on pushes to main and publishes it (.github/workflows/box-image.yml), with
# COMMIT and BUILT_AT set; a build without them reports "+source" as its
# version, as a runner run from a checkout does.
#
# linux/amd64 only, Fly's default: Claude Code's download below is that
# platform's.

# Node 24 on Debian 13, pinned by digest. To move it on:
#   docker buildx imagetools inspect node:24-trixie-slim | grep -m1 Digest
ARG NODE_IMAGE=node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0

# ------------------------------------------------------------ Claude Code
# The native build, as its installer would put it, at the version Mike's
# runners are on when this is bumped (box mode turns the runner's CLI
# updates off, and DISABLE_AUTOUPDATER below Claude Code's own, so a box
# runs exactly this one). To move it on, take the version and the
# linux-x64 checksum from its manifest:
#   v=$(curl -fsSL https://downloads.claude.ai/claude-code-releases/latest)
#   curl -fsSL https://downloads.claude.ai/claude-code-releases/$v/manifest.json | jq -r '.platforms["linux-x64"].checksum'
FROM ${NODE_IMAGE} AS claude
ARG TARGETARCH
ARG CLAUDE_CODE_VERSION=2.1.327
ARG CLAUDE_CODE_SHA256=343c744baa14bfd38286a7cb90871051f04379956da6c5b803a9e66019a76ac9
RUN [ "${TARGETARCH:-amd64}" = amd64 ] || { echo "The box image is linux/amd64 only (Claude Code's download and checksum here are linux-x64's)." >&2; exit 1; } \
 && apt-get update -q \
 && apt-get install -y -q --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /claude "https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/linux-x64/claude" \
 && echo "${CLAUDE_CODE_SHA256}  /claude" | sha256sum -c - \
 && chmod 755 /claude

# ------------------------------------------------------------ the runner's packages
# Production packages only, as a release installs them (scripts/deploy.mjs).
# The agent SDK's own copy of Claude Code (a platform package, some 250 MB)
# goes: the runner always hands the SDK the CLI's path (claudePath).
FROM ${NODE_IMAGE} AS packages
WORKDIR /opt/threadbear/runner
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-* \
 && npm cache clean --force

# ------------------------------------------------------------ the box
FROM ${NODE_IMAGE}
ARG CLAUDE_CODE_VERSION=2.1.327
# git for the clone, worktrees and saves; ps (procps) for the runner's
# process checks; ca-certificates for https. Nothing else: a repo's own
# worktree setup installs what it needs.
RUN apt-get update -q \
 && apt-get install -y -q --no-install-recommends ca-certificates git procps \
 && rm -rf /var/lib/apt/lists/*
COPY --from=claude /claude /root/.local/share/claude/versions/${CLAUDE_CODE_VERSION}
RUN mkdir -p /root/.local/bin /work \
 && ln -s ../share/claude/versions/${CLAUDE_CODE_VERSION} /root/.local/bin/claude
WORKDIR /opt/threadbear/runner
COPY --from=packages /opt/threadbear/runner/node_modules ./node_modules
# What a release holds of runner/ (deploy.mjs RELEASE_PATHS).
COPY package.json package-lock.json .npmrc ./
COPY bin ./bin
COPY src ./src
COPY box/entrypoint.sh /usr/local/bin/threadbear-box
# The release record the runner reports its version from (src/release.ts):
# <built at>-<short commit>, as deploy.mjs names a release.
ARG COMMIT=
ARG BUILT_AT=
RUN if [ -n "$COMMIT" ] && [ -n "$BUILT_AT" ]; then \
      node -e 'const [c, at] = process.argv.slice(1); const id = at.replace(/[-:]/g, "").replace(/\.\d+/, "") + "-" + c.slice(0, 9); require("fs").writeFileSync("release.json", JSON.stringify({ id, commit: c, branch: "main", dirty: false, builtAt: at, node: process.versions.node, prefix: "runner/" }, null, 2) + "\n");' "$COMMIT" "$BUILT_AT"; \
    fi

# IS_SANDBOX: Claude Code runs as root here, which it refuses to with
# skipped permissions unless told it's in a sandbox (box mode sets it too).
# The runner's log goes to stderr as well, so the provider's logs show a
# box's start (Faster starts, 2).
ENV PATH=/root/.local/bin:$PATH \
    IS_SANDBOX=1 \
    DISABLE_AUTOUPDATER=1 \
    THREADBEAR_BOX_WORK=/work \
    THREADBEAR_LOG_STDERR=1
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/threadbear-box"]
