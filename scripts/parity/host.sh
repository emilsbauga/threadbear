#!/bin/bash
# Sourced by nightly.sh. General check hosts may include Linux machines;
# pictures need a Mac with Desk Runner in its desktop session.
parity_host() {
  local candidate
  while IFS= read -r candidate || [ -n "$candidate" ]; do
    [ -n "$candidate" ] || continue
    if ssh -o BatchMode=yes -o ConnectTimeout=10 -- "$candidate" \
      'test "$(uname -s)" = Darwin && test -f "$HOME/.local/bin/desk" && test -x "$HOME/.local/bin/desk"' </dev/null >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "No reachable parity Mac with ~/.local/bin/desk; set THREADBEAR_PARITY_HOST or checkHosts in ${RUNNER_JSON:-runner.json}" >&2
  return 1
}
