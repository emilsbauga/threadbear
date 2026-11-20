#!/bin/bash
# Stands in for ssh when remote.sh's host is "local": a job running on a
# check host itself (scripts/nightly-fuzz.sh on Tinker Desk) gets the same
# locks, copy, build setup and hangup guard as a run from another Mac, with
# no ssh key to itself. Like sshd, it runs the command line through the
# login shell from the home folder, with stdin passed through, as the hangup
# guard watches stdin to know its caller has gone.
#
#   local-ssh.sh [ssh options] <host> <command words...>
set -euo pipefail
while [ $# -gt 0 ]; do
  case "$1" in
    -[bcDEeFIiJLlmOopQRSWw]) shift 2 ;;   # ssh options that take a value
    -*) shift ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] && shift   # the host
cd "$HOME"
exec "${SHELL:-/bin/zsh}" -c "$*"
