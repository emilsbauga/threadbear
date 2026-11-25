#!/bin/bash
# Writes runner/box/debs.lock: the exact Debian packages the box image
# installs (box/Dockerfile, box/debs.ts), each by name, version,
# architecture, size and SHA-256, from one dated snapshot of Debian's archive
# (snapshot.debian.org), resolved against the Node image the Dockerfile pins.
# A build installs exactly those files or stops, so rebuilding a commit gets
# the same bytes, and nothing the archive publishes later reaches a box until
# this is run again and the new lock committed (Daybreak, 24 Nov: "Production
# box images install mutable Debian packages without source-pinned
# artifacts").
#
# To move it on (Debian security updates, a new base image):
#   runner/box/lock-debs.sh                    # today's snapshot
#   runner/box/lock-debs.sh 20261201T000000Z   # a given one
# then read the diff (versions, and any package added or gone) and commit it
# with the Dockerfile. It needs Docker that runs linux/amd64 images (a Linux
# x86 box, or Docker Desktop's emulation), and curl. The packages it asks for
# are the lock's own "# packages:" line.
#
# Inside the base image apt reads the snapshot over plain http (the image
# has no CA certificates yet), checking its signatures with the image's own
# Debian keys; as that alone would take an older signed index replayed by
# someone in the path, each index apt used is also fetched here over https
# and must be the same bytes.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
lock="$here/debs.lock"
stamp="${1:-$(date -u +%Y%m%dT000000Z)}"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "A snapshot is YYYYMMDDTHHMMSSZ, not $stamp" >&2; exit 1; }
image=$(sed -n 's/^ARG NODE_IMAGE=//p' "$here/Dockerfile")
[[ "$image" == *@sha256:* ]] || { echo "box/Dockerfile's NODE_IMAGE isn't pinned by digest" >&2; exit 1; }
packages=$(sed -n 's/^# packages: //p' "$lock")
[ -n "$packages" ] || { echo "debs.lock has no '# packages:' line" >&2; exit 1; }
suites="debian:trixie debian:trixie-updates debian-security:trixie-security"

sha256() { if command -v sha256sum >/dev/null; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

# Inside the base image: only the snapshot's suites as sources, then each
# index's hash and the URIs apt would download for the packages, each with
# its size and SHA-256.
resolved=$(docker run --rm --platform linux/amd64 -e STAMP="$stamp" -e PACKAGES="$packages" -e SUITES="$suites" "$image" bash -euc '
  rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
  for s in $SUITES; do
    echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/${s%%:*}/$STAMP ${s#*:} main"
  done > /etc/apt/sources.list.d/snapshot.list
  apt-get -o Acquire::Retries=5 update -qq >&2
  for s in $SUITES; do
    f=/var/lib/apt/lists/snapshot.debian.org_archive_${s%%:*}_${STAMP}_dists_${s#*:}_InRelease
    [ -f "$f" ] || { echo "apt has no InRelease for $s" >&2; exit 1; }
    echo "INRELEASE ${s%%:*} ${s#*:} $(sha256sum < "$f" | cut -d" " -f1)"
  done
  apt-get install -qq -o Acquire::ForceHash=SHA256 --print-uris --no-install-recommends $PACKAGES
')

while read -r _ archive suite sum; do
  got=$(curl -fsSL --retry 5 "https://snapshot.debian.org/archive/$archive/$stamp/dists/$suite/InRelease" | sha256)
  [ "$got" = "$sum" ] || { echo "The $archive $suite index apt read isn't the one snapshot.debian.org serves over https ($sum, not $got): nothing written" >&2; exit 1; }
done < <(printf '%s\n' "$resolved" | grep '^INRELEASE ')

{
  echo "# The box image's Debian packages (runner/box/lock-debs.sh writes this; box/debs.ts installs it)."
  echo "# snapshot: $stamp"
  echo "# packages: $packages"
  echo "# base: $image"
  echo "# name version arch size sha256 archive pool-path"
  printf '%s\n' "$resolved" | sed -n "s|^'http://snapshot.debian.org/archive/\([a-z-]*\)/$stamp/\(pool/[^']*\)' \([^ ]*\) \([0-9]*\) SHA256:\([0-9a-f]\{64\}\)\$|\1 \2 \3 \4 \5|p" |
    while read -r archive pool file size sum; do
      base=$(basename "$file" .deb)
      name=${base%%_*}
      rest=${base#*_}
      # A Debian version's only escaped characters are : + and ~ (no printf
      # %b, which macOS's bash 3.2 doesn't take \x in).
      version=$(printf '%s' "${rest%_*}" | sed -e 's/%3[aA]/:/g' -e 's/%2[bB]/+/g' -e 's/%7[eE]/~/g')
      arch=${rest##*_}
      printf '%s %s %s %s %s %s %s\n' "$name" "$version" "$arch" "$size" "$sum" "$archive" "$pool"
    done | sort
} > "$lock.new"
count=$(grep -vc '^#' "$lock.new" || true)
uris=$(printf '%s\n' "$resolved" | grep -c "^'" || true)
bad=$(grep -v '^#' "$lock.new" | awk '$2 !~ /^[A-Za-z0-9.+~:-]+$/' | head -1)
[ "$count" -gt 0 ] && [ "$count" = "$uris" ] && [ -z "$bad" ] || { rm -f "$lock.new"; echo "Read $count of apt's $uris packages${bad:+ (one malformed: $bad)}; nothing written" >&2; exit 1; }
mv "$lock.new" "$lock"
echo "debs.lock: $count packages from snapshot $stamp"
