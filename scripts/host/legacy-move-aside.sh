#!/usr/bin/env bash
# Moves the legacy derivative folders a watcher before v1.7.0 wrote out of the
# photo library, into a folder beside it on the same filesystem (#15, v2.0.0).
# Run it on the host, as the library's owner, or with sudo when uid 1001 owns
# the folders. The stack mounts the library read-only, so no container can.
#
#   scripts/host/legacy-move-aside.sh <library> [--to <dir>] [--apply]
#
# A dry run by default: it prints each move as an `mv` line with its size, the
# total, and the lines that move the folders back, and changes nothing.
# --apply prints the same, then makes exactly those moves.
#
# It moves only the eight names lib/derivativeFolders.mjs lists, each only
# when it's a real folder directly under the library: never a symlink, a file,
# a nested folder or another name. It deletes nothing. The destination
# defaults to <library's parent>/<library name>.legacy-derivatives-<YYYY-MM-DD>.
# It refuses, exits 1 and moves nothing when the destination is the library or
# inside it (the watcher would scan the folders there, and take every WebP in
# them for a new photo), already holds any of the names, or sits on another
# filesystem than the library, where `mv` would copy and then delete.
#
# Exit codes: 0 done, or nothing to move; 1 refused, or a move failed; 2 usage.
set -euo pipefail
# A CDPATH would make cd print the folder, into the paths below.
unset CDPATH

# The eight names, in lib/derivativeFolders.mjs's order: DERIVATIVE_FOLDERS, then CACHE_FOLDER.
NAMES=(thumbnails medium optimized thumbnails-avif medium-avif optimized-avif lqip cache)

usage() {
  echo "Usage: $0 <library> [--to <dir>] [--apply]" >&2
  exit 2
}

refuse() {
  printf '%s Nothing was moved.\n' "$*" >&2
  exit 1
}

# $1 in single quotes, for a line the owner can paste into a shell.
quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# The device ID of $1: GNU stat, then BSD stat.
device_of() {
  stat -c %d -- "$1" 2>/dev/null || stat -f %d -- "$1" 2>/dev/null
}

# The filesystem and mount point df reports for $1, without its counts.
mount_of() {
  df -P -- "$1" 2>/dev/null | awk 'NR == 2 { $2 = $3 = $4 = $5 = ""; print }'
}

# Kilobytes on disk as a size, in decimal units.
human() {
  awk -v k="$1" 'BEGIN { b = k * 1024; if (b >= 1e9) printf "%.1f GB", b / 1e9; else if (b >= 1e6) printf "%.1f MB", b / 1e6; else printf "%.1f kB", b / 1e3 }'
}

library=''
dest=''
apply=0
while [ $# -gt 0 ]; do
  case $1 in
    --apply) apply=1 ;;
    --to)
      [ $# -ge 2 ] && [ -n "$2" ] || usage
      dest=$2
      shift
      ;;
    -*) usage ;;
    *)
      [ -z "$library" ] || usage
      library=$1
      ;;
  esac
  shift
done
[ -n "$library" ] || usage

# Both sides with symlinks resolved, so "inside the library" means the real folder.
[ -d "$library" ] || refuse "The library $library isn't a folder."
lib=$(cd -P -- "$library" && pwd -P) || refuse "Can't open the library $library."
[ "$lib" != / ] || refuse "The library can't be /."

if [ -z "$dest" ]; then
  parent=$(dirname -- "$lib")
  dest="${parent%/}/$(basename -- "$lib").legacy-derivatives-$(date +%Y-%m-%d)"
fi
if [ -e "$dest" ] || [ -L "$dest" ]; then
  [ -d "$dest" ] || refuse "The destination $dest isn't a folder."
  to=$(cd -P -- "$dest" && pwd -P) || refuse "Can't open the destination $dest."
  anchor=$to
  dest_exists=1
else
  parent=$(dirname -- "$dest")
  [ -d "$parent" ] || refuse "The destination's parent $parent isn't a folder. Make it first, outside the library."
  anchor=$(cd -P -- "$parent" && pwd -P) || refuse "Can't open the destination's parent $parent."
  to="${anchor%/}/$(basename -- "$dest")"
  dest_exists=0
fi

case "$to/" in
  "$lib/"*) refuse "The destination $to is the library or inside it, where the watcher would scan the folders and take their WebP files for new photos. Pick one outside the library, on the same filesystem." ;;
esac

lib_device=$(device_of "$lib") || lib_device=''
anchor_device=$(device_of "$anchor") || anchor_device=''
case "$lib_device$anchor_device" in
  '' | *[!0-9]*) refuse "Can't read the device of $lib or $anchor." ;;
esac
lib_mount=$(mount_of "$lib") || lib_mount=''
anchor_mount=$(mount_of "$anchor") || anchor_mount=''
[ -n "$lib_mount" ] && [ -n "$anchor_mount" ] || refuse "Can't read the mount of $lib or $anchor."
if [ "$lib_device" != "$anchor_device" ] || [ "$lib_mount" != "$anchor_mount" ]; then
  refuse "The destination $to is on another filesystem than the library, so mv would copy the folders and then delete them. Pick a --to on the library's filesystem, outside the library. If the library is a whole disk of its own, leave the folders where they are."
fi

# The plan: every real folder of the eight names directly under the library.
moves=()
total=0
skipped=()
for name in "${NAMES[@]}"; do
  from="$lib/$name"
  if [ -L "$from" ]; then
    skipped+=("Leaves $(quote "$from") where it is: it's a symlink.")
  elif [ -d "$from" ]; then
    if [ -e "$to/$name" ] || [ -L "$to/$name" ]; then
      refuse "The destination $to already holds $name."
    fi
    [ "$(device_of "$from")" = "$lib_device" ] || refuse "$from is on another filesystem than the library."
    moves+=("$name")
  elif [ -e "$from" ]; then
    skipped+=("Leaves $(quote "$from") where it is: it isn't a folder.")
  fi
done

echo "Library: $lib"
echo "Destination: $to, outside the library on the same filesystem"
echo
if [ ${#skipped[@]} -gt 0 ]; then
  printf '%s\n' "${skipped[@]}"
  echo
fi
if [ ${#moves[@]} -eq 0 ]; then
  echo "Nothing to move: the library holds none of the eight legacy folders as a real folder at its top."
  exit 0
fi

for name in "${moves[@]}"; do
  kb=$(du -sk -- "$lib/$name" | awk '{ print $1 }')
  total=$((total + kb))
  echo "mv $(quote "$lib/$name") $(quote "$to/$name")  # $(human "$kb")"
done
count=${#moves[@]}
[ "$count" -eq 1 ] && unit=folder || unit=folders
echo "Total: $count $unit, $(human "$total") on disk. It frees no space: the folders stay on the same filesystem."
echo

back() {
  echo "To move them back, before restoring a data-root backup made before the catalog launch with web on v1.5.x or older, rolling back to v1.6.x, or rerunning photos carry-over, run these. Each moves its folder back only while the library doesn't hold that name again:"
  for name in "${moves[@]}"; do
    echo "if [ -e $(quote "$lib/$name") ] || [ -L $(quote "$lib/$name") ]; then echo $(quote "$lib/$name exists. Compare it with $to/$name first.") >&2; else mv $(quote "$to/$name") $(quote "$lib/$name"); fi"
  done
}

if [ "$apply" -eq 0 ]; then
  echo "Dry run: nothing was moved. Run it again with --apply to make exactly these moves."
  echo
  back
  exit 0
fi

if [ "$dest_exists" -eq 0 ]; then
  mkdir -- "$to" || refuse "Can't make $to."
fi
done_moves=()
for name in "${moves[@]}"; do
  if [ -e "$to/$name" ] || [ -L "$to/$name" ] || ! mv -- "$lib/$name" "$to/$name"; then
    echo "Stopped: $lib/$name wasn't moved." >&2
    if [ ${#done_moves[@]} -gt 0 ]; then
      moves=("${done_moves[@]}")
      echo "Moved before it stopped: ${done_moves[*]}." >&2
      back >&2
    else
      echo "Nothing was moved." >&2
    fi
    exit 1
  fi
  done_moves+=("$name")
done
echo "Moved $count $unit to $to."
echo
back
