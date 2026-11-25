#!/bin/sh
# Works out how a commit (Mike's release) would merge into main, without
# checking anything out or running anything from it
# (docs/bringing-in-updates.md, section 2). Prints the merged tree, then
# any files that clash and what git said, then what the release changes.
#
# The merge is done in a throwaway bare repo that borrows this repo's
# objects and has no config of its own, with no global, system or
# attributes files: no merge driver, merge.default, diff or textconv
# program from anywhere can run on the release's files while git works it
# out (Codex's review, 9 Nov 2026: this repo's own config can name one).
# Needs git 2.40 or later (merge-tree --write-tree, --attr-source).
#
# Usage: scripts/merge-preview.sh [--prepare <dir>] <commit> [<base>, main by default]
#
# --prepare <dir>: also writes each clashing file, with git's conflict
# markers, to <dir>/files/<path>, the list to <dir>/clashes and the two
# commits to <dir>/base and <dir>/commit, so the clashes can be settled
# there while the owner decides. <dir> must be outside this checkout, and
# new, empty or one an earlier --prepare made: nothing in it is loaded or
# run. After go, scripts/merge-prepared.sh <dir> merges and puts them in
# (docs/bringing-in-updates.md, sections 2 and 4).
set -eu
prepare=""
if [ "${1:-}" = "--prepare" ]; then
  prepare=${2:?usage: scripts/merge-preview.sh --prepare <dir> <commit> [base]}
  shift 2
fi
commit=${1:?usage: scripts/merge-preview.sh [--prepare <dir>] <commit> [base]}
base=${2:-refs/heads/main}
top=$(git rev-parse --show-toplevel)
# Replacement objects and grafts off, and a checkout with either refused:
# git reads a refs/replace/ entry or info/grafts in place of the object an
# id names, so the release's signed commit could merge as another, unsigned
# one (Daybreak 180, 24 Nov 2026).
# No fetching either: a partial clone missing the release's commit would
# fetch it through this checkout's own ssh command before anything's shown.
# GIT_NO_LAZY_FETCH needs git 2.44, so every transport is refused by name
# too (a protocol's own setting in the repo's config beats protocol.allow).
export GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1
unset GIT_GRAFT_FILE GIT_REPLACE_REF_BASE
here() {
  git -C "$top" -c protocol.allow=never -c protocol.ext.allow=never -c protocol.fd.allow=never -c protocol.file.allow=never \
    -c protocol.git.allow=never -c protocol.http.allow=never -c protocol.https.allow=never -c protocol.ssh.allow=never "$@"
}
common=$(here rev-parse --path-format=absolute --git-common-dir)
if [ -n "$(here for-each-ref --count=1 --format='%(refname)' refs/replace/)" ] || [ -e "$common/info/grafts" ]; then
  echo "This checkout has git replacement refs (refs/replace/) or grafts ($common/info/grafts), which could have git read other objects in place of the release's: remove them (git replace -d, or that file) first." >&2
  exit 1
fi
objects=$(here rev-parse --path-format=absolute --git-path objects)
format=$(here rev-parse --show-object-format 2>/dev/null || echo sha1)
base_id=$(here rev-parse --verify "$base^{commit}")
commit_id=$(here rev-parse --verify "$commit^{commit}")
if [ -n "$prepare" ]; then
  real_top=$(cd "$top" && pwd -P)
  inside() {
    case "$1/" in "$real_top/"*) echo "--prepare: $prepare is inside this checkout; use a folder outside it (\${TMPDIR:-/tmp}/...)." >&2; exit 2 ;; esac
  }
  # Refused before anything is made: check the nearest folder that exists.
  near=$prepare
  while [ ! -d "$near" ]; do near=$(dirname "$near"); done
  inside "$(cd "$near" && pwd -P)"
  mkdir -p "$prepare"
  prepare=$(cd "$prepare" && pwd -P)
  inside "$prepare"
  # Only a folder of its own: what's in it is cleared on each run.
  if [ -n "$(ls -A "$prepare")" ] && [ ! -f "$prepare/commit" ]; then
    echo "--prepare: $prepare has other things in it; use a new folder." >&2
    exit 2
  fi
  rm -rf "$prepare/files"
  rm -f "$prepare/clashes"
  printf '%s\n' "$base_id" > "$prepare/base"
  printf '%s\n' "$commit_id" > "$prepare/commit"
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/tb-merge-preview.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM
# Nothing of anyone's config: not this repo's, the user's or the system's.
bare() {
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_COUNT -u GIT_TEMPLATE_DIR -u GIT_GRAFT_FILE \
    HOME="$tmp" XDG_CONFIG_HOME="$tmp" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 \
    git "$@"
}
# No template either: init.templateDir or GIT_TEMPLATE_DIR could copy in a
# config and info/attributes naming a driver (Codex's third look).
bare init -q --bare --template= "--object-format=$format" "$tmp/r"
printf '%s\n' "$objects" > "$tmp/r/objects/info/alternates"
clean() {
  bare -C "$tmp/r" -c core.attributesFile=/dev/null -c merge.default=text -c core.commitGraph=false "$@"
}
empty=$(clean hash-object -t tree /dev/null)
status=0
clean --attr-source="$empty" merge-tree --write-tree --name-only --messages "$base_id" "$commit_id" > "$tmp/out" || status=$?
cat "$tmp/out"
tree=$(head -n 1 "$tmp/out")
echo
if [ "$status" -eq 1 ]; then echo "It clashes in the files above."; elif [ "$status" -ne 0 ]; then echo "git merge-tree failed ($status)."; exit "$status"; else echo "It merges cleanly."; fi
# A clean merge leaves an empty list, so merge-prepared.sh merges it too:
# one merge helper for every release, with replacements off.
if [ -n "$prepare" ] && [ "$status" -eq 0 ]; then : > "$prepare/clashes"; fi
if [ -n "$prepare" ] && [ "$status" -eq 1 ]; then
  mkdir "$prepare/files"
  # The clashing paths: the lines after the tree id, up to the blank line.
  sed -n '2,/^$/p' "$tmp/out" | sed '/^$/d' | sort -u > "$prepare/clashes"
  while IFS= read -r f; do
    # Git never stores a path with a . or .. part or a leading /, but this
    # one goes into a folder, so check anyway.
    case "/$f/" in */../*|*/./*|//*) echo "--prepare: skipped an odd path: $f" >&2; continue ;; esac
    mkdir -p "$prepare/files/$(dirname "$f")"
    if ! clean cat-file blob "$tree:$f" > "$tmp/blob" 2>/dev/null; then
      echo "--prepare: no merged copy of $f (deleted or moved on one side?); settle it after go." >&2
      continue
    fi
    mv "$tmp/blob" "$prepare/files/$f"
  done < "$prepare/clashes"
  echo
  echo "Wrote the clashing files, with conflict markers, under $prepare/files: settle them there."
fi
echo
echo "What it changes against main:"
clean --attr-source="$empty" diff --no-ext-diff --no-textconv --stat "$base_id" "$tree"

# A format commit in the release (.git-blame-ignore-revs, "# format-subject:"
# lines; runner/src/format-replay.ts) that main doesn't have clashes with
# every change main made to the files it formatted, though only formatting
# differs. Nothing formats here (that would run the release's toolchain), so
# say so, and show the real clashes: merging the commit before the oldest.
# Found as format-replay.ts finds them: the id written under its block, or
# else the one commit with its subject (none when two have it).
list=$(clean show "$commit_id:.git-blame-ignore-revs" 2>/dev/null | tr -d '\r' || true)
[ -n "$list" ] || exit 0
printf '%s\n' "$list" | awk '
  function out(id) { if (s != "") print s "\037" id "\037" p "\037" c; s = ""; p = ""; c = "" }
  /^#[[:space:]]*format-subject:/ { out(""); sub(/^#[[:space:]]*format-subject:[[:space:]]*/, ""); s = $0; next }
  /^#[[:space:]]*format-paths:/ { sub(/^#[[:space:]]*format-paths:[[:space:]]*/, ""); p = $0; next }
  /^#[[:space:]]*format-config:/ { sub(/^#[[:space:]]*format-config:[[:space:]]*/, ""); c = $0; next }
  # (Lengths, not {40}: mawk, the awk on Debian and Android, panics on an interval.)
  /^[0-9a-f]+$/ && (length($0) == 40 || length($0) == 64) { out($0); next }
  /^[^#]/ && NF { out("") }
  END { out("") }
' > "$tmp/entries"
clean log --no-merges --format='%H%x09%s' "$commit_id" > "$tmp/subjects"
: > "$tmp/new"
# (A separator that isn't whitespace, so an empty field stays a field.)
while IFS="$(printf '\037')" read -r subject id paths config; do
  f=""
  if [ -n "$id" ] && clean merge-base --is-ancestor "$id" "$commit_id" 2>/dev/null; then
    f=$id
  else
    # ENVIRON, not -v: awk would read backslashes in -v as escapes.
    n=$(S=$subject awk -F '\t' 'substr($0, index($0, "\t") + 1) == ENVIRON["S"]' "$tmp/subjects" | wc -l | tr -d ' ')
    [ "$n" = 1 ] && f=$(S=$subject awk -F '\t' 'substr($0, index($0, "\t") + 1) == ENVIRON["S"] { print $1 }' "$tmp/subjects")
  fi
  [ -n "$f" ] || continue
  if clean merge-base --is-ancestor "$f" "$base_id"; then continue; fi
  # Only what it formats, none of its config, one parent: else the replay
  # won't take it as a format commit, so neither does this.
  [ "$(clean rev-list --parents -n 1 "$f" | wc -w | tr -d ' ')" = 2 ] || continue
  ok=1
  clean diff --name-only "$f^" "$f" > "$tmp/changed"
  while IFS= read -r file; do
    inside=0
    for d in $paths; do d=${d%/}; case "$file" in "$d"|"$d"/*) inside=1 ;; esac; done
    for c in $config; do [ "$file" = "$c" ] && inside=0; done
    [ "$inside" = 1 ] || { ok=0; break; }
  done < "$tmp/changed"
  [ "$ok" = 1 ] || continue
  printf '%s\t%s\t%s\n' "$(clean rev-list --count "$f")" "$f" "$subject" >> "$tmp/new"
done < "$tmp/entries"
[ -s "$tmp/new" ] || exit 0
sort -n "$tmp/new" > "$tmp/sorted"
echo
while IFS="$(printf '\t')" read -r _ f subject; do
  echo "The release has a format commit main doesn't: $f ($subject)."
done < "$tmp/sorted"
oldest=$(head -n 1 "$tmp/sorted" | cut -f 2)
if [ -n "$prepare" ] && [ -f "$prepare/clashes" ]; then
  rm -rf "$prepare/files" "$prepare/clashes"
  echo "(--prepare: nothing kept, as a release with a format commit merges with replay-over-format.sh: settle its clashes after go.)"
fi
echo "Clashes in the files they formatted are formatting only: after they say go, merge with"
echo "scripts/replay-over-format.sh --merge $commit_id (docs/bringing-in-updates.md, section 4),"
echo "which settles those by itself. The real clashes up to it, merging the commit before it:"
st=0
clean --attr-source="$empty" merge-tree --write-tree --name-only "$base_id" "$oldest^" > "$tmp/before" 2>&1 || st=$?
if [ "$st" -eq 0 ]; then echo "  none"
elif [ "$st" -eq 1 ]; then sed -n '2,/^$/p' "$tmp/before" | sed '/^$/d; s/^/  /'
else echo "  (git merge-tree failed, $st: $(head -n 1 "$tmp/before"))"; fi
