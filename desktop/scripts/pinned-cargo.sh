#!/bin/bash
# cargo from exactly the Rust main pins, for builds of the app a Mac runs:
# stage-update.sh (the installed app's updates, here or on an update build
# host) and install-app.sh. Never rustup, and never a cargo that happens to
# be on PATH (Daybreak 173, 23 Nov 2026).
#
#   desktop/scripts/pinned-cargo.sh <cargo arguments...>
#
# rust-toolchain.toml names the version, and desktop/scripts/rust-toolchain.pins
# the SHA-256 and address of each of its three parts (rustc, cargo, rust-std)
# for this kind of Mac. The first time, each is downloaded over https and
# checked against its pin before anything is unpacked; then the three are
# put together, as rustup would, in a folder of this Mac's own
# (~/Library/Caches/Threadbear/rust/<version>-<target>-<pins hash>), which
# later builds reuse. Moving the pins makes a new one. Nothing from the network runs until its
# hash has matched, and no manifest from Rust's servers is read: rustup
# reads a channel manifest nobody signs and would run the compiler it got
# to report its version before anything here could check it (the cross-lab
# review of the first fix).
#
# THREADBEAR_RUST_CACHE puts the folder elsewhere, and THREADBEAR_RUST_DIST
# stands in for Rust's servers in the tests (a folder of the archives by
# name); what comes from it is checked against the pins all the same.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
# THREADBEAR_RUST_HOST names the target in the tests, which also run on Linux.
if [[ -n "${THREADBEAR_RUST_HOST:-}" ]]; then
  host="$THREADBEAR_RUST_HOST"
else
  [ "$(uname -s)" = Darwin ] || { echo "pinned-cargo.sh: the pinned Rust is only for a Mac." >&2; exit 1; }
  case "$(uname -m)" in
    arm64 | aarch64) host=aarch64-apple-darwin ;;
    x86_64) host=x86_64-apple-darwin ;;
    *) echo "pinned-cargo.sh: no pinned Rust for a $(uname -m) Mac." >&2; exit 1 ;;
  esac
fi
channel="$(sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)"[[:space:]]*$/\1/p' "$root/rust-toolchain.toml" 2>/dev/null | head -1 || true)"
[[ "$channel" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "rust-toolchain.toml doesn't pin an exact Rust (channel = \"1.x.y\"; it says \"${channel:-nothing}\"), so nothing was built." >&2; exit 1; }

# This Mac's three lines: version target part sha256 url.
pins="$(awk -v ch="$channel" -v host="$host" '$0 !~ /^#/ && NF == 5 && $1 == ch && $2 == host' "$root/desktop/scripts/rust-toolchain.pins" 2>/dev/null || true)"
[[ "$(grep -c . <<<"$pins")" == 3 ]] || { echo "desktop/scripts/rust-toolchain.pins should have exactly rustc, cargo and rust-std for Rust $channel on $host, so nothing was built." >&2; exit 1; }
for part in rustc cargo rust-std; do
  line="$(awk -v p="$part" '$3 == p' <<<"$pins")"
  [[ "$(wc -l <<<"$line" | tr -d ' ')" == 1 ]] &&
    awk '{ exit !($4 ~ /^[0-9a-f]{64}$/ && $5 ~ /^https:\/\/static\.rust-lang\.org\/dist\/[0-9-]+\/[A-Za-z0-9._-]+\.tar\.xz$/) }' <<<"$line" ||
    { echo "desktop/scripts/rust-toolchain.pins has no single good pin for Rust $channel's $part on $host, so nothing was built." >&2; exit 1; }
done

# Named by its pins, and never replaced once there: a build fetching it for
# the first time beside another (two on an update build host, or an update
# beside install-app.sh) puts its copy in place in one rename, which fails
# if the other's got there first, so neither deletes the toolchain the other
# is compiling with (the second cross-lab review). New pins, a new folder.
cache="${THREADBEAR_RUST_CACHE:-$HOME/Library/Caches/Threadbear/rust}"
key="$(printf '%s' "$pins" | /usr/bin/shasum -a 256 | cut -c1-12)"
prefix="$cache/$channel-$host-$key"
if [[ ! -x "$prefix/bin/cargo" || "$(cat "$prefix/pinned" 2>/dev/null || true)" != "$pins" ]]; then
  echo "Getting Rust $channel for $host, checked against main's pins (about 1 GB unpacked, once)." >&2
  mkdir -p "$cache"
  work="$(mktemp -d "$cache/.making-XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  mkdir -p "$work/prefix"
  while read -r _ _ part sha url; do
    file="$work/${url##*/}"
    if [[ -n "${THREADBEAR_RUST_DIST:-}" ]]; then
      cp "$THREADBEAR_RUST_DIST/${url##*/}" "$file"
    else
      curl --proto '=https' --tlsv1.2 -sSfL --retry 3 "$url" -o "$file"
    fi
    got="$(/usr/bin/shasum -a 256 "$file" | awk '{ print $1 }')"
    if [[ "$got" != "$sha" ]]; then
      echo "Rust $channel's $part for $host isn't the one main pins (SHA-256 $got, not $sha), so nothing was built." >&2
      exit 1
    fi
    # Checked: now it's the bytes main reviewed. Each archive holds
    # <name>/components (the parts in it) and a folder for each, laid out as
    # they go under the toolchain.
    top="${url##*/}"
    top="${top%.tar.xz}"
    tar -xJf "$file" -C "$work"
    rm -f "$file"
    while read -r component; do
      [[ "$component" =~ ^[A-Za-z0-9._-]+$ && -d "$work/$top/$component" ]] || { echo "Rust's $part archive lists a part ($component) it doesn't hold." >&2; exit 1; }
      rm -f "$work/$top/$component/manifest.in"
      ditto "$work/$top/$component" "$work/prefix"
    done <"$work/$top/components"
    rm -rf "${work:?}/$top"
  done <<<"$pins"
  printf '%s\n' "$pins" >"$work/prefix/pinned"
  # rename(2): atomic, and refused onto a folder that has anything in it.
  if ! /usr/bin/perl -e 'rename($ARGV[0], $ARGV[1]) or exit 1' "$work/prefix" "$prefix"; then
    [[ -x "$prefix/bin/cargo" && "$(cat "$prefix/pinned" 2>/dev/null || true)" == "$pins" ]] ||
      { echo "pinned-cargo.sh: $prefix is there but isn't this toolchain; delete it and build again." >&2; exit 1; }
  fi
  # exec below skips the EXIT trap, so the copy that lost a race (a whole
  # toolchain) goes now.
  rm -rf "$work"
  trap - EXIT
fi

# Its own rustc for cargo and for build scripts, and none of rustup's
# settings, so a rust-toolchain.toml or RUSTUP_TOOLCHAIN can't swap in
# another Rust behind it.
# In a remote.sh run (an update build host), through its shared-cargo shim,
# which shares a few warm target folders between checkouts, told to run this
# cargo rather than the next one on the PATH.
# No wrapper around rustc either, from the environment or cargo's config
# (an empty one overrides the config's).
shim="$(command -v cargo 2>/dev/null || true)"
unset RUSTUP_TOOLCHAIN RUSTC RUSTDOC CARGO_BUILD_RUSTC CARGO_BUILD_RUSTC_WRAPPER CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER
export PATH="$prefix/bin:$PATH" RUSTC="$prefix/bin/rustc" RUSTC_WRAPPER="" RUSTC_WORKSPACE_WRAPPER=""
if [[ -n "${THREADBEAR_SHARED_CARGO_BASE:-}" && "$shim" == "$root/desktop/scripts/shared-cargo/cargo" ]]; then
  export THREADBEAR_SHARED_CARGO_REAL="$prefix/bin/cargo"
  exec "$shim" "$@"
fi
exec "$prefix/bin/cargo" "$@"
