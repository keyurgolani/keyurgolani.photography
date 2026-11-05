#!/usr/bin/env bash
# Moves the legacy derivative folders a watcher before v1.7.0 wrote out of the
# photo library, into a folder beside it on the same filesystem (#15, v2.0.0).
# Run it on the host, as the library's owner, or with sudo when uid 1001 owns
# the folders. The stack mounts the library read-only, so no container can.
#
#   scripts/host/legacy-move-aside.sh [--to <dir>] [--apply] [--] <library>
#
# A dry run by default: it prints each move as an `mv` line with its size, the
# total, and the lines that move the folders back, and changes nothing.
# --apply prints the same, writes the lines that move them back to
# <dir>/move-back.sh before the first move, then makes exactly those moves.
#
# It moves only the eight names lib/derivativeFolders.mjs lists, each only
# when it's a real folder directly under the library: never a symlink, a file,
# a nested folder or another name. It deletes nothing. Each move is a single
# rename(2), through perl, which never copies and fails rather than nest a
# folder or cross a filesystem. The destination defaults to
# <library's parent>/<library name>.legacy-derivatives-<YYYY-MM-DD>. It
# refuses, exits 1 and moves nothing when the destination:
# - is the library or inside it, by device and inode up the destination's
#   ancestors, so case, symlinks, firmlinks and bind mounts can't hide it
#   (the watcher would scan the folders there, and take every WebP in them
#   for a new photo);
# - is under the public/ folder of a checkout, beside package.json or
#   next.config.*, which a build copies into the image;
# - already holds any of the eight names, or a move-back.sh;
# - sits on another device or mount than the library.
#
# Exit codes: 0 done, or nothing to move; 1 refused, or a move failed; 2 usage.
set -euo pipefail
# A CDPATH would make cd print the folder, into the paths below.
unset CDPATH

# The eight names, in lib/derivativeFolders.mjs's order: DERIVATIVE_FOLDERS, then CACHE_FOLDER.
NAMES=(thumbnails medium optimized thumbnails-avif medium-avif optimized-avif lqip cache)

# The extension DERIVATIVE_FOLDERS gives each name. cache/ has none.
extension_of() {
  case $1 in
    thumbnails | medium | optimized) echo .webp ;;
    thumbnails-avif | medium-avif | optimized-avif) echo .avif ;;
    lqip) echo .txt ;;
    *) echo '' ;;
  esac
}

usage() {
  echo "Usage: $0 [--to <dir>] [--apply] [--] <library>" >&2
  exit 2
}

refuse() {
  printf '%s Nothing was moved.\n' "$*" >&2
  exit 1
}

# $1 in single quotes, for a line the owner can paste into a shell.
quote() {
  local rest=$1 out="'"
  while [[ $rest == *"'"* ]]; do
    out="$out${rest%%"'"*}'\\''"
    rest=${rest#*"'"}
  done
  printf '%s' "$out$rest'"
}

# stat's format $1 for $2: GNU stat, then BSD stat.
stat_of() {
  stat -c "$1" -- "$2" 2>/dev/null || stat -f "$1" -- "$2" 2>/dev/null
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
to_given=0
apply=0
take_library() {
  [ -z "$library" ] && [ -n "$1" ] || usage
  library=$1
}
while [ $# -gt 0 ]; do
  case $1 in
    --apply) apply=1 ;;
    --to)
      [ $# -ge 2 ] && [ -n "$2" ] && [ "$to_given" -eq 0 ] || usage
      dest=$2
      to_given=1
      shift
      ;;
    --)
      shift
      [ $# -le 1 ] || usage
      [ $# -eq 0 ] || take_library "$1"
      break
      ;;
    -*) usage ;;
    *) take_library "$1" ;;
  esac
  shift
done
[ -n "$library" ] || usage

command -v perl >/dev/null 2>&1 || refuse "This needs perl, so that each move is a rename and never a copy."

# Both sides with symlinks resolved.
[ -d "$library" ] || refuse "The library $library isn't a folder."
lib=$(cd -P -- "$library" && pwd -P) || refuse "Can't open the library $library."
[ "$lib" != / ] || refuse "The library can't be /."

if [ "$to_given" -eq 0 ]; then
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

# Inside the library: by path, then by device and inode for every folder from
# the destination up to /, which catches a path that differs only in case, a
# firmlink, and a bind mount of the library.
inside="The destination $to is the library or inside it, where the watcher would scan the folders and take their WebP files for new photos. Pick one outside the library, on the same filesystem."
case "$to/" in
  "$lib/"*) refuse "$inside" ;;
esac
lib_id=$(stat_of %d:%i "$lib") || lib_id=''
case $lib_id in
  *[0-9]:[0-9]*) ;;
  *) refuse "Can't read the device and inode of $lib." ;;
esac
folder=$anchor
while :; do
  id=$(stat_of %d:%i "$folder") || id=''
  [ -n "$id" ] || refuse "Can't read the device and inode of $folder."
  [ "$id" != "$lib_id" ] || refuse "$inside"
  [ "$folder" != / ] || break
  folder=$(dirname -- "$folder")
done

# Under a checkout's public/ folder, which the image build and Next read.
folder=$to
while [ "$folder" != / ]; do
  parent=$(dirname -- "$folder")
  case $(basename -- "$folder") in
    [Pp][Uu][Bb][Ll][Ii][Cc])
      checkout=0
      [ ! -e "$parent/package.json" ] || checkout=1
      for config in "$parent"/next.config.*; do
        [ ! -e "$config" ] || checkout=1
      done
      if [ "$checkout" -eq 1 ]; then
        if [ "$to_given" -eq 0 ]; then
          refuse "The default destination $to is under $folder, the public/ folder of the checkout in $parent, which a build copies into the image. Pass --to a folder outside the checkout, on the library's filesystem."
        fi
        refuse "The destination $to is under $folder, the public/ folder of the checkout in $parent, which a build copies into the image. Pick one outside the checkout, on the library's filesystem."
      fi
      ;;
  esac
  folder=$parent
done

lib_device=$(stat_of %d "$lib") || lib_device=''
anchor_device=$(stat_of %d "$anchor") || anchor_device=''
case "$lib_device$anchor_device" in
  '' | *[!0-9]*) refuse "Can't read the device of $lib or $anchor." ;;
esac
lib_mount=$(mount_of "$lib") || lib_mount=''
anchor_mount=$(mount_of "$anchor") || anchor_mount=''
[ -n "$lib_mount" ] && [ -n "$anchor_mount" ] || refuse "Can't read the mount of $lib or $anchor."
if [ "$lib_device" != "$anchor_device" ] || [ "$lib_mount" != "$anchor_mount" ]; then
  refuse "The destination $to is on another filesystem than the library, where a move would have to copy the folders. Pick a --to on the library's filesystem, outside the library. If the library is a whole disk of its own, leave the folders where they are."
fi

move_back=$to/move-back.sh
for name in "${NAMES[@]}" move-back.sh; do
  if [ -e "$to/$name" ] || [ -L "$to/$name" ]; then
    refuse "The destination $to already holds $name."
  fi
done

# The plan: every real folder of the eight names directly under the library.
moves=()
skipped=()
for name in "${NAMES[@]}"; do
  from="$lib/$name"
  if [ -L "$from" ]; then
    skipped+=("Leaves $(quote "$from") where it is: it's a symlink.")
  elif [ -d "$from" ]; then
    [ "$(stat_of %d "$from")" = "$lib_device" ] || refuse "$from is on another filesystem than the library."
    moves+=("$name")
  elif [ -e "$from" ]; then
    skipped+=("Leaves $(quote "$from") where it is: it isn't a folder.")
  fi
done

sudo=''
[ "${EUID:-1}" -ne 0 ] || sudo='sudo '

# The guarded line that moves $1 back. It does nothing to a folder that isn't
# in the aside folder, and won't move one into a library that holds the name.
back_line() {
  local aside=$to/$1 home=$lib/$1
  echo "if [ ! -d $(quote "$aside") ] || [ -L $(quote "$aside") ]; then echo $(quote "$aside isn't there: nothing to move back."); elif [ -e $(quote "$home") ] || [ -L $(quote "$home") ]; then echo $(quote "$home exists. Compare it with $aside first.") >&2; else ${sudo}mv $(quote "$aside") $(quote "$home"); fi"
}

back_heading() {
  echo "To move them back, before restoring a data-root backup made before the catalog launch with web on v1.5.x or older, rolling back to v1.6.x, or rerunning photos carry-over, run these. Each moves its folder back only while the library doesn't hold that name again:"
}

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

total=0
unknown=0
for name in "${moves[@]}"; do
  line="mv $(quote "$lib/$name") $(quote "$to/$name")"
  if usage_line=$(du -sk -- "$lib/$name" 2>/dev/null); then
    kb=${usage_line%%[[:space:]]*}
    total=$((total + kb))
    echo "$line  # $(human "$kb")"
  else
    unknown=$((unknown + 1))
    echo "$line  # size unknown, run with sudo"
  fi
done
count=${#moves[@]}
[ "$count" -eq 1 ] && unit=folder || unit=folders
summary="Total: $count $unit, $(human "$total") on disk"
[ "$unknown" -eq 0 ] || summary="$summary, not counting $unknown whose size is unknown"
echo "$summary. It frees no space: the folders stay on the same filesystem."

# Files that don't look like derivatives: warned about, still moved.
odd=()
for name in "${moves[@]}"; do
  extension=$(extension_of "$name")
  [ -n "$extension" ] || continue
  while IFS= read -r file; do
    odd+=("$file")
  done < <(find "$lib/$name" -type f ! -name "*$extension" ! -name '.*' 2>/dev/null || true)
done
if [ ${#odd[@]} -gt 0 ]; then
  echo
  if [ ${#odd[@]} -eq 1 ]; then
    echo "Warning: 1 file in these folders doesn't have its folder's extension, so it may not be a derivative. Look at it before you rely on the move:"
  else
    echo "Warning: ${#odd[@]} files in these folders don't have their folder's extension, so they may not be derivatives. Look at them before you rely on the move:"
  fi
  shown=0
  for file in "${odd[@]}"; do
    [ "$shown" -lt 20 ] || break
    echo "  $(quote "$file")"
    shown=$((shown + 1))
  done
  [ ${#odd[@]} -le 20 ] || echo "  and $((${#odd[@]} - 20)) more."
fi
echo

if [ "$apply" -eq 0 ]; then
  echo "Dry run: nothing was moved. Run it again with --apply to make exactly these moves."
  echo
  back_heading
  for name in "${moves[@]}"; do back_line "$name"; done
  exit 0
fi

if [ "$dest_exists" -eq 0 ]; then
  mkdir -- "$to" || refuse "Can't make $to."
fi
# The way back goes to disk before the first move, so it's there whatever happens next.
(
  umask 022
  set -C
  {
    echo '#!/bin/sh'
    echo "# Moves the legacy folders scripts/host/legacy-move-aside.sh moved out of"
    echo "# $lib back into it. Safe to run after a partial move, or twice."
    for name in "${moves[@]}"; do back_line "$name"; done
  } >"$move_back"
) || refuse "Can't write $move_back."
chmod 0644 "$move_back"

done_moves=()
for name in "${moves[@]}"; do
  if [ -e "$to/$name" ] || [ -L "$to/$name" ] ||
    ! perl -e 'rename($ARGV[0], $ARGV[1]) or die "$!\n"' -- "$lib/$name" "$to/$name"; then
    echo "Stopped: $lib/$name wasn't moved." >&2
    if [ ${#done_moves[@]} -gt 0 ]; then
      echo "Moved before it stopped: ${done_moves[*]}. $move_back moves them back, or run these:" >&2
      back_heading >&2
      for moved in "${done_moves[@]}"; do back_line "$moved" >&2; done
    else
      if [ "$dest_exists" -eq 0 ]; then
        echo "Nothing was moved. The folder $to was left with only move-back.sh in it, which has nothing to move back. It's safe to leave." >&2
      else
        echo "Nothing was moved. $move_back has nothing to move back, so $to is safe to leave as it is." >&2
      fi
    fi
    exit 1
  fi
  done_moves+=("$name")
done
echo "Moved $count $unit to $to."
echo
back_heading
for name in "${moves[@]}"; do back_line "$name"; done
echo
echo "The same lines are in $move_back. Run it with ${sudo}sh."
