#!/bin/sh
# The box image's entrypoint (runner/box/Dockerfile): the runner in box mode
# for one thread of a virtual runner (docs/virtual-runners.md; docs/protocol/boxes.md,
# "Box mode"). The backend's service starts the machine with only
# THREADBEAR_SYNC_URL, THREADBEAR_BOX_BOOT and THREADBEAR_MACHINE_ID_ENV set,
# and no command, so this is what runs.
#
# Without a boot token the runner would start as an ordinary runner, which
# a box must never be, so it says why and stops at once (64, EX_USAGE).
# There's no restart loop: the runner exiting stops the machine, as the
# Fly adapter's `restart: no` intends (a crashed runner shows as a stopped
# machine, not a new process passing for the old).
set -eu

if [ -z "${THREADBEAR_BOX_BOOT:-}" ]; then
  echo "threadbear-box: THREADBEAR_BOX_BOOT isn't set, so there's nothing to run. This image is a Threadbear virtual runner's box: the backend's service starts it with a boot token and THREADBEAR_SYNC_URL (docs/virtual-runners.md). It doesn't run on its own." >&2
  exit 64
fi
if [ -z "${THREADBEAR_SYNC_URL:-}" ]; then
  echo "threadbear-box: THREADBEAR_BOX_BOOT is set but THREADBEAR_SYNC_URL isn't, so the box has no backend to boot from." >&2
  exit 64
fi

cd /opt/threadbear/runner
exec node src/main.ts
