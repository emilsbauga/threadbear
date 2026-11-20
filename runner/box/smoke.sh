#!/usr/bin/env bash
# A quick check of a built box image (runner/box/Dockerfile), with no
# secrets and no network past the image: CI runs it after each build
# (.github/workflows/box-image.yml), before anything is pushed.
#
#   runner/box/smoke.sh <image>
#
# 1. With no boot token it stops at once (64) and says why, rather than
#    starting as an ordinary runner.
# 2. What's baked in runs: Claude Code at the version its link names, git,
#    ps, and the runner's version (its release record, when CI built it).
# 3. In box mode, the whole runner loads and trades its boot token at
#    THREADBEAR_SYNC_URL: a stand-in for Convex in the same container refuses
#    the token (`auth`), and the runner stops at once, saying so, as a box
#    whose token is used or expired does (docs/protocol.md, "Box mode").
set -euo pipefail
# The single-quoted scripts are run by the image's shell, which expands them.
# shellcheck disable=SC2016

IMAGE="${1:?usage: runner/box/smoke.sh <image>}"
fail() {
  echo "smoke: $1" >&2
  [ -n "${2:-}" ] && printf '%s\n' "--- output ---" "$2" >&2
  exit 1
}
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "1. No boot token"
set +e
out="$(timeout 60 docker run --rm --init "$IMAGE" 2>&1)"
code=$?
set -e
[ "$code" = 64 ] || fail "with no boot token it exited $code, not 64" "$out"
grep -q "THREADBEAR_BOX_BOOT isn't set" <<<"$out" || fail "with no boot token it didn't say why" "$out"

echo "2. What's baked in"
set +e
out="$(timeout 120 docker run --rm --init --entrypoint /bin/sh "$IMAGE" -c '
  set -e
  cd /opt/threadbear/runner
  v="$(basename "$(readlink /root/.local/bin/claude)")"
  claude --version | grep -q "^$v " || { echo "claude --version isn'"'"'t $v: $(claude --version)"; exit 1; }
  echo "claude $v"
  git --version
  ps -p 1 -o comm=
  [ ! -e node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 ] || { echo "the SDK'"'"'s own Claude Code is still in"; exit 1; }
  node -e "import(\"./src/release.ts\").then((m) => console.log(\"runner \" + m.RELEASE.version))"
' 2>&1)"
code=$?
set -e
[ "$code" = 0 ] || fail "something baked in didn't run (exit $code)" "$out"
printf '%s\n' "$out" | sed 's/^/   /'

echo "3. Box mode's boot exchange, refused"
cat >"$tmp/fake-convex.mjs" <<'EOF'
// Stands in for the deployment: refuses every boot token, as a used one is.
import http from 'node:http';
import { writeFileSync } from 'node:fs';
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const { path, args } = JSON.parse(body || '{}');
      const shaped = /^[0-9a-f]{64}$/.test(args?.boxKeyHash ?? '');
      console.error(`fake-convex: ${req.method} ${req.url} ${path} token=${args?.bootToken === 'tbt_smoke' ? 'given' : 'wrong'} keyHash=${shaped ? 'ok' : 'bad'}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', errorMessage: 'Server Error', errorData: { kind: 'auth', message: 'That boot token has been used.' } }));
    });
  })
  .listen(3210, '127.0.0.1', () => writeFileSync('/tmp/fake-ready', ''));
EOF
started=$(date +%s)
set +e
out="$(timeout 90 docker run --rm --init -v "$tmp:/smoke:ro" \
  -e THREADBEAR_BOX_BOOT=tbt_smoke -e THREADBEAR_SYNC_URL=http://127.0.0.1:3210 \
  --entrypoint /bin/sh "$IMAGE" -c '
    node /smoke/fake-convex.mjs &
    for i in $(seq 50); do [ -e /tmp/fake-ready ] && break; sleep 0.1; done
    exec /usr/local/bin/threadbear-box
  ' 2>&1)"
code=$?
set -e
took=$(($(date +%s) - started))
[ "$code" = 1 ] || fail "with a refused boot token it exited $code, not 1" "$out"
grep -q "fake-convex: POST /api/action boxes:exchange token=given keyHash=ok" <<<"$out" || fail "it didn't trade its boot token at THREADBEAR_SYNC_URL" "$out"
grep -q "The box's runner couldn't start: The backend refused the box's boot token" <<<"$out" || fail "it didn't say the backend refused its token" "$out"
[ "$took" -le 60 ] || fail "it took ${took}s to give up on a refused token" "$out"
echo "   refused, stopped in ${took}s"
echo "smoke: ok"
