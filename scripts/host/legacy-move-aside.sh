#!/usr/bin/env bash
# Moves the legacy derivative folders a watcher before v1.7.0 wrote out of the
# photo library, into a folder beside it on the same filesystem (#15, v2.0.0).
# Run it on the host, with sudo when uid 1001 owns the folders or the data
# root. The stack mounts the library read-only, so no container can.
#
#   scripts/host/legacy-move-aside.sh --manifest <file> [--to <dir>] [--apply] [--] <library>
#
# A folder name is never enough: on a case-insensitive disk `medium` is also
# the owner's `Medium` album. So it moves only folders the app vouched for.
# First run `photos legacy-derivatives` in the watcher's container. It reads
# the library and writes status/legacy-derivatives.json to the data root: for
# each of the eight names the library lists exactly, every file and its size
# and mtime, or why the folder stays. --manifest names that file. This script
# refuses, exits 1 and moves nothing unless the manifest's digest is intact,
# it's under 24 hours old, it hasn't been used for an --apply, it names this
# library by device and inode, and each folder it would move lists, right
# now and case-sensitively, exactly the files the manifest holds, with the
# same sizes and mtimes. A folder the manifest says stays, stays.
#
# A dry run by default: what moves and what stays, and why, each move as an
# `mv` line with its size, the total, and the lines that move the folders
# back. It changes nothing. --apply prints the same, then writes the way back
# to <dir>/move-back.sh and records the manifest as used, in <dir> and beside
# the manifest, and only then moves. Each move is a single rename(2), through
# perl, which never copies, and fails rather than nest a folder or cross a
# filesystem. It deletes nothing.
#
# The destination defaults to <library's parent>/<library name>.legacy-
# derivatives-<YYYY-MM-DD>. It refuses one that:
# - is the library or inside it, by device and inode up the destination's
#   ancestors, so case, symlinks, firmlinks and bind mounts can't hide it;
# - is inside a checkout of this repository (a folder above it holds
#   package.json or next.config.*), which a build copies into the image;
# - already holds any of the eight names, a move-back.sh or a used record;
# - sits on another device or mount than the library;
# - or whose path, or the library's, holds a newline.
#
# Exit codes: 0 done, or nothing to move; 1 refused, or a move failed; 2 usage.
set -euo pipefail
# A CDPATH would make cd print the folder, into the paths below.
unset CDPATH

# The eight names, in lib/derivativeFolders.mjs's order: DERIVATIVE_FOLDERS, then CACHE_FOLDER.
NAMES=(thumbnails medium optimized thumbnails-avif medium-avif optimized-avif lqip cache)

usage() {
  echo "Usage: $0 --manifest <file> [--to <dir>] [--apply] [--] <library>" >&2
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

has_newline() {
  case $1 in
    *$'\n'*) return 0 ;;
  esac
  return 1
}

library=''
dest=''
manifest=''
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
    --manifest)
      [ $# -ge 2 ] && [ -n "$2" ] && [ -z "$manifest" ] || usage
      manifest=$2
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

command -v perl >/dev/null 2>&1 || refuse "This needs perl, to read the manifest and so that each move is a rename and never a copy."

if has_newline "$library" || has_newline "$dest" || has_newline "$manifest"; then
  refuse "A path given holds a newline, which the printed and saved lines can't carry safely."
fi

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
if has_newline "$lib" || has_newline "$to"; then
  refuse "The library's or the destination's path holds a newline, which the printed and saved lines can't carry safely."
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

# Inside a checkout of this repository, which the image build copies and Next
# serves from. On the resolved path, so a symlink can't hide it.
folder=$to
while :; do
  checkout=0
  [ ! -e "$folder/package.json" ] || checkout=1
  for config in "${folder%/}"/next.config.*; do
    [ ! -e "$config" ] || checkout=1
  done
  if [ "$checkout" -eq 1 ]; then
    if [ "$to_given" -eq 0 ]; then
      refuse "The default destination $to is inside the checkout in $folder, which a build copies into the image. Pass --to a folder outside the checkout, on the library's filesystem."
    fi
    refuse "The destination $to is inside the checkout in $folder, which a build copies into the image. Pick one outside the checkout, on the library's filesystem."
  fi
  [ "$folder" != / ] || break
  folder=$(dirname -- "$folder")
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

for name in "${NAMES[@]}"; do
  if [ -e "$to/$name" ] || [ -L "$to/$name" ]; then
    refuse "The destination $to already holds $name."
  fi
done

# Which of the eight names the library's root lists exactly, from a real
# listing: a test of "$lib/medium" would find an album named Medium on a
# case-insensitive disk.
present=$(perl -e 'opendir(my $d, $ARGV[0]) or exit 3; my %want = map { $_ => 1 } @ARGV[1 .. $#ARGV]; print "$_\n" for sort grep { $want{$_} } readdir $d' -- "$lib" "${NAMES[@]}") ||
  refuse "Can't list the library $lib."
echo "Library: $lib"
echo "Destination: $to, outside the library on the same filesystem"
if [ -z "$present" ]; then
  echo
  echo "Nothing to move: the library's top holds none of the eight legacy folder names."
  exit 0
fi

[ -n "$manifest" ] || refuse "This needs the manifest photos legacy-derivatives writes. Run it in the watcher's container first, then pass --manifest <data root>/status/legacy-derivatives.json."
manifest_dir=$(cd -P -- "$(dirname -- "$manifest")" 2>/dev/null && pwd -P) ||
  refuse "Can't open the folder of the manifest $manifest. Run photos legacy-derivatives in the watcher's container first."
manifest_file="$manifest_dir/$(basename -- "$manifest")"
used_file="$manifest_dir/legacy-derivatives.used"

# The manifest's checks, in perl: digest, age, use, library, and each folder's
# real listing against it. It prints `digest`, `move` and `stay` lines, or
# refuses on stderr with exit 1.
read -r -d '' VERIFY <<'PERL' || true
use strict;
use warnings;
use Digest::SHA qw(sha256_hex);
use Encode qw(encode_utf8);
use JSON::PP ();
use Time::Local qw(timegm);

my ($file, $used, $aside_used, $lib, $now, @names) = @ARGV;
my $again = 'Run photos legacy-derivatives in the watcher\'s container again.';
sub refuse { print STDERR "$_[0]\n"; exit 1 }
sub clean { my $text = shift; $text =~ s/[\x00-\x1f\x7f]/?/g; return $text }

open(my $fh, '<:raw', $file) or refuse("Can't read the manifest $file ($!). Run photos legacy-derivatives in the watcher's container first, and give this script its file.");
my $raw = do { local $/; <$fh> };
close $fh;
my $outer = eval { JSON::PP->new->utf8->decode($raw) };
refuse("The manifest $file isn't one photos legacy-derivatives wrote. $again") unless ref $outer eq 'HASH' && defined $outer->{manifest} && !ref $outer->{manifest};
refuse("The manifest $file has a schema this script doesn't know. $again") unless ($outer->{schemaVersion} // '') eq '1';
my $digest = 'sha256:' . sha256_hex(encode_utf8($outer->{manifest}));
refuse("The manifest's digest doesn't match its content, so it changed after photos legacy-derivatives wrote it. $again") unless ($outer->{digest} // '') eq $digest;
my $m = eval { JSON::PP->new->decode($outer->{manifest}) };
refuse("The manifest $file can't be read. $again") unless ref $m eq 'HASH' && ref $m->{folders} eq 'ARRAY' && ref $m->{library} eq 'HASH';
refuse("The manifest $file has a schema this script doesn't know. $again") unless ($m->{schemaVersion} // '') eq '1';

my ($y, $mo, $d, $h, $mi, $s) = ($m->{writtenAt} // '') =~ /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?Z$/
  or refuse("The manifest has no time it was written. $again");
my $age = $now - timegm($s, $mi, $h, $d, $mo - 1, $y);
refuse("The manifest is more than 24 hours old, and the library may have changed since. $again") if $age > 24 * 60 * 60;
refuse("The manifest says it was written in the future. Check the host's clock, then run photos legacy-derivatives again.") if $age < -300;

for my $record ($used, $aside_used) {
  next unless -e $record;
  open(my $u, '<', $record) or refuse("Can't read $record, which records the manifests already used.");
  while (my $line = <$u>) {
    chomp $line;
    refuse("This manifest was used for an earlier --apply, and a manifest is good for one. $again") if $line eq $digest;
  }
  close $u;
}

my @root = stat $lib or refuse("Can't read $lib.");
refuse("The manifest is from another library: it names device and inode $m->{library}{dev}:$m->{library}{ino}, and $lib is $root[0]:$root[1]. $again")
  unless "$root[0]:$root[1]" eq ($m->{library}{dev} // '') . ':' . ($m->{library}{ino} // '');

opendir(my $dh, $lib) or refuse("Can't list $lib.");
my %root = map { $_ => 1 } readdir $dh;
closedir $dh;
my %known = map { $_ => 1 } @names;
my %folders;
for my $f (@{ $m->{folders} }) {
  refuse("The manifest names a folder that isn't one of the eight. $again") unless ref $f eq 'HASH' && defined $f->{name} && $known{ $f->{name} };
  $folders{ $f->{name} } = $f;
}

# Every file and folder under $top, with lstat: never a followed symlink.
sub listing {
  my ($top, $name) = @_;
  lstat $top or return (undef, undef, "$name can't be read");
  return (undef, undef, "$name is a symlink now") if -l _;
  return (undef, undef, "$name isn't a folder now") unless -d _;
  my (%files, %dirs);
  my @pending = ('');
  while (@pending) {
    my $rel = pop @pending;
    my $shown = $rel eq '' ? $name : "$name/$rel";
    opendir(my $dir, $rel eq '' ? $top : "$top/$rel")
      or refuse("Can't read " . clean($shown) . ", so it can't be checked against the manifest. Run this with sudo when uid 1001 owns the folders.");
    my @entries = grep { $_ ne '.' && $_ ne '..' } readdir $dir;
    closedir $dir;
    for my $entry (@entries) {
      my $path = $rel eq '' ? $entry : "$rel/$entry";
      my @st = lstat "$top/$path" or return (undef, undef, "$name/$path can't be read");
      if (-l _) { return (undef, undef, "$name/$path is a symlink") }
      elsif (-d _) { $dirs{$path} = 1; push @pending, $path }
      elsif (-f _) { $files{$path} = [$st[7], $st[9]] }
      else { return (undef, undef, "$name/$path isn't a regular file") }
    }
  }
  return (\%files, \%dirs, undef);
}

for my $name (@names) {
  my $f = $folders{$name};
  if (!$root{$name}) {
    refuse("The manifest moves $name, but the library has no entry named exactly $name now. $again") if $f && $f->{moves};
    next;
  }
  if (!$f) { print "stay\t$name\tit isn't in the manifest, which is older than it. $again\n"; next }
  if (!$f->{moves}) { print "stay\t$name\t", clean($f->{reason} // 'the manifest says it stays'), "\n"; next }
  refuse("The manifest's entry for $name can't be read. $again") unless ref $f->{files} eq 'ARRAY' && ref $f->{dirs} eq 'ARRAY';
  my ($files, $dirs, $problem) = listing("$lib/$name", $name);
  my $changed = "$name changed since photos legacy-derivatives looked at it";
  refuse("$changed: $problem. $again") if $problem;
  my %want;
  for my $entry (@{ $f->{files} }) {
    refuse("The manifest's entry for $name can't be read. $again") unless ref $entry eq 'HASH' && defined $entry->{path};
    $want{ encode_utf8($entry->{path}) } = $entry;
  }
  for my $path (sort keys %$files) {
    my $entry = $want{$path} or refuse("$changed: $name/" . clean($path) . " is new. $again");
    my ($size, $mtime) = @{ $files->{$path} };
    refuse("$changed: $name/" . clean($path) . " has another size or time. $again") unless $size == ($entry->{size} // -1) && $mtime == ($entry->{mtime} // -1);
  }
  for my $path (sort keys %want) {
    refuse("$changed: $name/" . clean($path) . " is gone. $again") unless exists $files->{$path};
  }
  my %want_dirs = map { encode_utf8($_) => 1 } @{ $f->{dirs} };
  for my $path (sort keys %$dirs) { refuse("$changed: $name/" . clean($path) . "/ is new. $again") unless $want_dirs{$path} }
  for my $path (sort keys %want_dirs) { refuse("$changed: $name/" . clean($path) . "/ is gone. $again") unless $dirs->{$path} }
  my @sorted = sort keys %$files;
  my $count = scalar @sorted;
  my $shown = join(', ', map { clean($_) } @sorted[0 .. ($count > 3 ? 2 : $count - 1)]);
  $shown .= ', ...' if $count > 3;
  print "move\t$name\t$count\t$shown\n";
}
print "written\t", clean($m->{writtenAt}), "\n";
print "digest\t$digest\n";
PERL

plan=$(perl -e "$VERIFY" -- "$manifest_file" "$used_file" "$to/legacy-derivatives.used" "$lib" "$(date +%s)" "${NAMES[@]}" 2>&1) ||
  refuse "$plan"

moves=()
move_lines=()
stay_lines=()
digest=''
written=''
while IFS=$'\t' read -r kind name rest; do
  case $kind in
    move)
      moves+=("$name")
      count=${rest%%$'\t'*}
      [ "$count" -eq 1 ] && files='1 file' || files="$count files"
      move_lines+=("  $name: $files, such as ${rest#*$'\t'}")
      ;;
    stay) stay_lines+=("  $name: $rest") ;;
    written) written=$name ;;
    digest) digest=$name ;;
  esac
done <<<"$plan"
[ -n "$digest" ] || refuse "The manifest check printed no digest."

for name in ${moves[@]+"${moves[@]}"}; do
  [ "$(stat_of %d "$lib/$name")" = "$lib_device" ] || refuse "$lib/$name is on another filesystem than the library."
done

echo "Manifest: $manifest_file, written $written"
echo
if [ ${#moves[@]} -gt 0 ]; then
  [ ${#moves[@]} -eq 1 ] && echo "Moves aside, 1 folder:" || echo "Moves aside, ${#moves[@]} folders:"
  printf '%s\n' "${move_lines[@]}"
fi
if [ ${#stay_lines[@]} -gt 0 ]; then
  [ ${#stay_lines[@]} -eq 1 ] && echo "Stays, 1 folder:" || echo "Stays, ${#stay_lines[@]} folders:"
  printf '%s\n' "${stay_lines[@]}"
fi
echo
if [ ${#moves[@]} -eq 0 ]; then
  echo "Nothing to move: the manifest vouches for none of the legacy-named folders here."
  exit 0
fi

move_back=$to/move-back.sh
aside_used=$to/legacy-derivatives.used
for name in move-back.sh legacy-derivatives.used; do
  if [ -e "$to/$name" ] || [ -L "$to/$name" ]; then
    refuse "The destination $to already holds $name from an earlier run. Pass a different --to."
  fi
done

sudo=''
if [ -n "${SUDO_USER:-}" ] && command -v sudo >/dev/null 2>&1; then
  sudo='sudo '
fi

# The guarded line that moves $1 back. It does nothing to a folder that isn't
# in the aside folder, and won't move one into a library that holds the name.
back_line() {
  local aside=$to/$1 home=$lib/$1
  echo "if [ ! -d $(quote "$aside") ] || [ -L $(quote "$aside") ]; then echo $(quote "$aside isn't there: nothing to move back."); elif [ -e $(quote "$home") ] || [ -L $(quote "$home") ]; then echo $(quote "$home exists. Compare it with $aside first.") >&2; else ${sudo}mv $(quote "$aside") $(quote "$home"); fi"
}

back_heading() {
  echo "To move them back, before restoring a data-root backup made before the catalog launch with web on v1.5.x or older, rolling back to v1.6.x, or rerunning photos carry-over, run these. Each moves its folder back only while the library doesn't hold that name again:"
}

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
# The way back, and the manifest marked used, go to disk before the first
# move, so they're there whatever happens next. Both are outside the library.
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
(
  umask 077
  set -C
  echo "$digest" >"$aside_used"
) || refuse "Can't write $aside_used."
(
  umask 077
  echo "$digest" >>"$used_file"
) || refuse "Can't record the manifest as used in $used_file."
if [ "${EUID:-1}" -eq 0 ]; then
  # Keep the data root's file with the data root's owner.
  perl -e 'my @s = stat $ARGV[0] or exit 1; chown($s[4], $s[5], $ARGV[1]) or exit 1' -- "$manifest_file" "$used_file" ||
    refuse "Can't give $used_file the manifest's owner."
fi

done_moves=()
for name in "${moves[@]}"; do
  if [ -e "$to/$name" ] || [ -L "$to/$name" ] ||
    ! perl -e 'rename($ARGV[0], $ARGV[1]) or die "$!\n"' -- "$lib/$name" "$to/$name"; then
    echo "Stopped: $lib/$name wasn't moved." >&2
    if [ ${#done_moves[@]} -gt 0 ]; then
      echo "Moved before it stopped: ${done_moves[*]}. $move_back moves them back, or run these:" >&2
      back_heading >&2
      for moved in "${done_moves[@]}"; do back_line "$moved" >&2; done
    elif [ "$dest_exists" -eq 0 ]; then
      echo "Nothing was moved. The folder $to was left with move-back.sh and the used record in it, and nothing to move back. It's safe to leave." >&2
    else
      echo "Nothing was moved. $move_back has nothing to move back, so $to is safe to leave as it is." >&2
    fi
    echo "The manifest is used up. Run photos legacy-derivatives again before another --apply." >&2
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
