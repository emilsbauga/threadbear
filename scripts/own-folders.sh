#!/bin/bash
# own-folders.sh <where> <folder>...: each folder (relative to the current
# one, the home folder over ssh) must be this account's own and closed to
# others, or this says which isn't and exits 1. desktop/scripts/remote.sh
# sends it to a build host before writing helpers there that it then runs: a
# folder another account could write in could have one swapped in between
# (Codex's review of Daybreak 114/116, 13 Nov). Name the folders top down, so
# each one's own folder has been checked first. The current folder and every
# folder above it must be root's or this account's, closed to others, as
# whoever could change them could swap the first one out.
#
# A folder is owned by this account and loses group and other write. It may
# be a symlink only straight to the folder's real path (absolute, with no
# other link, . or .. on the way: one in a folder another account owns could
# be pointed elsewhere after the check), when that folder is this account's
# own and every folder above it is root's or this account's, closed to
# others. Then only root or this account can change what the path leads to.
# On 24 Nov 2026 cloud's ~/.cache/threadbear-check became such a link, to a
# bigger Hetzner volume (/mnt/HC_Volume_107600708, root's, 755), and a guard
# that refused every link stopped every build there. On a Mac, an ACL that
# allows anything is refused too, as mode bits don't show it (Codex's and
# Gemini's reviews, 24 Nov).
# Bash 3.2 and POSIX tools only: hosts are macOS and Linux.
where="$1"
shift
uid="$(id -u)"
me="$(id -un)"
mac=0
[ "$(uname -s)" != Darwin ] || mac=1
refuse() {
  echo "remote.sh: ~/$1 on $where isn't a folder of this account's own: $2" >&2
  exit 1
}
# Closed: owned by root or this account, no group or other write, and on a
# Mac no ACL entry that allows anything (a deny one, like a home folder's,
# takes nothing away from the owner). Not GNU stat's -f, on a Mac with
# Homebrew's coreutils first on the PATH.
closed() {
  local om o m
  if [ "$mac" = 1 ]; then om="$(/usr/bin/stat -f '%u %Lp' "$1" 2>/dev/null)"; else om="$(stat -c '%u %a' "$1" 2>/dev/null)"; fi
  o="${om% *}" m="${om#* }"
  case "$o$m" in *[!0-9]*|'') return 1 ;; esac
  { [ "$o" = 0 ] || [ "$o" = "$uid" ]; } && [ $((8#$m & 8#022)) -eq 0 ] || return 1
  [ "$mac" = 0 ] || no_allow_acl "$1"
}
# On a Mac: the ACL could be read (one hidden from us fails ls; Codex's
# review) and has no allow entry.
no_allow_acl() {
  local acl
  acl="$(/bin/ls -lde "$1" 2>/dev/null)" || return 1
  ! printf '%s\n' "$acl" | sed 1d | grep -q ' allow '
}
# Every folder from $1 up to /, $1 included.
chain_closed() {
  local p="$1"
  while :; do
    closed "$p" || { bad="$p"; return 1; }
    [ "$p" != / ] || return 0
    p="${p%/*}"
    [ -n "$p" ] || p=/
  done
}
# A path made of plain characters only: $() drops newlines at the end, so a
# name ending in one would be checked as another (Gemini's review). Each path
# read with $() has a . after it, so such a newline stays and is refused.
plain() {
  case "$1" in /*) ;; *) return 1 ;; esac
  case "$1" in *[!A-Za-z0-9._/@+-]*) return 1 ;; esac
  case "$1/" in */./*|*/../*|*//*) return 1 ;; esac
}
here="$(pwd -P && echo .)"
here="${here%.}" here="${here%?}"
plain "$here" && chain_closed "$here" || refuse . "$here, or ${bad:-a folder above it}, isn't root's or $me's alone (others could change it)"
for d in "$@"; do
  if [ ! -L "$d" ]; then
    [ -d "$d" ] && [ -O "$d" ] && chmod go-w "$d" || refuse "$d" "not a folder, or not owned by $me"
    [ "$mac" = 0 ] || no_allow_acl "$d" || refuse "$d" "it has an ACL that lets others in, or one that can't be read"
    continue
  fi
  to="$(readlink "$d" && echo .)" || refuse "$d" "a link that can't be read"
  to="${to%.}" to="${to%?}"
  real="$(cd -P -- "$d" 2>/dev/null && pwd -P && echo .)" || refuse "$d" "a link that doesn't lead to a folder"
  real="${real%.}" real="${real%?}"
  plain "$real" && [ "$to" = "$real" ] || refuse "$d" "a link to $to, not straight to a folder's real path"
  [ -d "$real" ] && [ ! -L "$real" ] && [ -O "$real" ] || refuse "$d" "a link to $real, which isn't owned by $me"
  up="${real%/*}"
  chain_closed "${up:-/}" || refuse "$d" "a link to $real, and $bad above it isn't root's or $me's alone (others could change it)"
  chmod go-w "$real" && closed "$real" || refuse "$d" "a link to $real, which others can change (an ACL?)"
done
