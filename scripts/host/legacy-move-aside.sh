#!/usr/bin/env bash
# Moves the legacy derivative folders a watcher before v1.7.0 wrote out of the
# photo library, into a folder beside it on the same filesystem (#15, v2.0.0).
# Run it on the host, as yourself. It refuses to run as root. The stack mounts
# the library read-only, so no container can move them.
#
#   scripts/host/legacy-move-aside.sh --manifest <file> [--to <dir>] [--apply] [--rename-as-root] [--] <library>
#
# A folder name is never enough: on a case-insensitive disk `medium` is also
# the owner's `Medium` album. So it moves only folders the app vouched for.
# First save the manifest `photos legacy-derivatives --stdout` prints in the
# watcher's container: for each of the eight names the library lists exactly,
# every file with its size and mtime, or why the folder stays. --manifest
# names that copy. It refuses, exits 1 and moves nothing unless the manifest's
# digest is intact, it's under 24 hours old, it hasn't been used for an
# --apply (by its digest, in ${XDG_STATE_HOME:-~/.local/state}/photos), it
# names this library by device and inode, and each folder it would move
# lists, right now and case-sensitively, exactly the files the manifest holds,
# with the same sizes and mtimes. A folder the manifest says stays, stays.
#
# A dry run by default: what moves and what stays, and why, each move as an
# `mv` line with its size, the total, and the move-back.sh it would write. It
# changes nothing. --apply prints the same, then writes move-back.sh in the
# aside folder and records the manifest as used, and only then moves. Each
# move is one rename(2) by a perl helper that first re-reads the library's
# listing and checks the folder's device and inode, so a folder swapped since
# the check stays where it is. rename(2) never copies, and fails rather than
# nest a folder or cross a filesystem. It deletes nothing.
#
# The renames run as you. On Linux, moving a folder to a new parent needs
# write permission on the folder itself, for its `..` entry, and the v1.x
# watcher wrote these as uid 1001. When a rename is refused that way, it
# stops and says so. --rename-as-root then runs only that helper through
# sudo. The helper works out both paths itself, by device and inode, and
# trusts none of its arguments. Everything else still runs as you.
#
# The destination defaults to <library's parent>/<library name>.legacy-
# derivatives-<YYYY-MM-DD>. It refuses one that:
# - is the library or inside it, by device and inode up the destination's
#   ancestors, so case, symlinks, firmlinks and bind mounts can't hide it;
# - is inside a checkout of this repository (a folder above it holds
#   package.json or next.config.*), which a build copies into the image;
# - already holds any of the eight names, a move-back.sh or a used record;
# - sits on another device or mount than the library;
# - or whose path, or the library's or the manifest's, holds a newline.
#
# Exit codes: 0 done, or nothing to move; 1 refused, or a move failed; 2 usage.
set -euo pipefail
# A CDPATH would make cd print the folder, into the paths below.
unset CDPATH

# The eight names, in lib/derivativeFolders.mjs's order: DERIVATIVE_FOLDERS, then CACHE_FOLDER.
NAMES=(thumbnails medium optimized thumbnails-avif medium-avif optimized-avif lqip cache)

usage() {
  echo "Usage: $0 --manifest <file> [--to <dir>] [--apply] [--rename-as-root] [--] <library>" >&2
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

# $1 with its nearest folder resolved, plus the rest of the path: a file's
# name, or the parts that don't exist yet.
resolved() {
  local target=$1 rest=''
  while [ ! -d "$target" ]; do
    rest="/$(basename -- "$target")$rest"
    target=$(dirname -- "$target")
  done
  printf '%s%s' "$(cd -P -- "$target" && pwd -P | sed 's:/*$::')" "$rest"
}

# Refuses with $2 when $1, or any folder above it, is the library by device and inode.
refuse_inside_library() {
  local folder=$1 id
  while [ ! -e "$folder" ]; do folder=$(dirname -- "$folder"); done
  while :; do
    id=$(stat_of %d:%i "$folder") || id=''
    [ -n "$id" ] || refuse "Can't read the device and inode of $folder."
    [ "$id" != "$lib_id" ] || refuse "$2"
    [ "$folder" != / ] || break
    folder=$(dirname -- "$folder")
  done
}

library=''
dest=''
manifest=''
to_given=0
apply=0
as_root=0
take_library() {
  [ -z "$library" ] && [ -n "$1" ] || usage
  library=$1
}
while [ $# -gt 0 ]; do
  case $1 in
    --apply) apply=1 ;;
    --rename-as-root) as_root=1 ;;
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

[ "$(id -u)" != 0 ] || refuse "Run this as yourself, not as root or with sudo. If a rename needs root, --rename-as-root runs only that rename through sudo."
command -v perl >/dev/null 2>&1 || refuse "This needs perl, to read the manifest and so that each move is a checked rename and never a copy."
if [ "$as_root" -eq 1 ]; then
  command -v sudo >/dev/null 2>&1 || refuse "--rename-as-root needs sudo, which isn't on PATH."
fi

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
refuse_inside_library "$anchor" "$inside"

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

[ -n "$manifest" ] || refuse "This needs the manifest photos legacy-derivatives writes. Save it in the watcher's container with --stdout, then pass that file with --manifest."
manifest_file=$(resolved "$manifest") || refuse "Can't open the folder of the manifest $manifest. Save it with photos legacy-derivatives --stdout first."
refuse_inside_library "$(dirname -- "$manifest_file")" "The manifest $manifest_file is inside the library. Keep the copy outside it, such as in your home folder."

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/photos"
has_newline "$state_dir" && refuse "The state folder's path $state_dir holds a newline."
state_dir=$(resolved "$state_dir") || refuse "Can't resolve the state folder $state_dir."
refuse_inside_library "$state_dir" "The state folder $state_dir is inside the library. Set XDG_STATE_HOME outside it."
used_file="$state_dir/legacy-derivatives.used"

# Sizes come first, so nothing runs between the check below and the renames but the helper's own re-check.
sizes=''
for name in $present; do
  if usage_line=$(du -sk -- "$lib/$name" 2>/dev/null); then
    sizes="$sizes$name ${usage_line%%[[:space:]]*}"$'\n'
  else
    sizes="$sizes$name ?"$'\n'
  fi
done

# The manifest's checks, in perl: digest, age, use, library, and each folder's
# real listing against it. It prints `move`, `stay`, `written` and `digest`
# lines, or refuses on stderr with exit 1.
read -r -d '' VERIFY <<'PERL' || true
use strict;
use warnings;
use Digest::SHA qw(sha256_hex);
use Encode qw(encode_utf8);
use Fcntl qw(O_RDONLY O_NOFOLLOW);
use JSON::PP ();
use Time::Local qw(timegm);

my ($file, $used, $aside_used, $lib, $now, @names) = @ARGV;
my $again = 'Run photos legacy-derivatives --stdout in the watcher\'s container again, and save its output.';
sub clean { my $text = shift; $text =~ s/[\x00-\x1f\x7f]/?/g; return $text }
sub refuse { print STDERR clean($_[0]), "\n"; exit 1 }

open(my $fh, '<:raw', $file) or refuse("Can't read the manifest $file ($!). Save it with photos legacy-derivatives --stdout in the watcher's container first, and give this script that file.");
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

# Never follow a link to a used record: a link there could point anywhere.
for my $record ($used, $aside_used) {
  if (!sysopen(my $u, $record, O_RDONLY | O_NOFOLLOW)) {
    next if $!{ENOENT};
    refuse("Can't read $record, which records the manifests already used ($!). If it's a symlink, put a plain file there.");
  } else {
    my @st = stat $u;
    refuse("$record isn't a plain file.") unless -f _ && $st[3] == 1;
    while (my $line = <$u>) {
      chomp $line;
      refuse("This manifest was used for an earlier --apply, and a manifest is good for one, wherever its copy is. $again") if $line eq $digest;
    }
    close $u;
  }
}

my @root = stat $lib or refuse("Can't read $lib.");
refuse("The manifest is from another library: it names device and inode $m->{library}{dev}:$m->{library}{ino}, and $lib is $root[0]:$root[1]. Under Docker Desktop, file sharing gives the container a different device; this step needs a Linux host with a bind mount. Otherwise, $again")
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
      or refuse("Can't read $shown, so it can't be checked against the manifest. Check you can read every folder in it.");
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
  refuse("$changed: " . clean($problem) . ". $again") if $problem;
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
  my @st = lstat "$lib/$name" or refuse("$changed: it can't be read. $again");
  my @sorted = sort keys %$files;
  my $count = scalar @sorted;
  my $shown = join(', ', map { clean($_) } @sorted[0 .. ($count > 3 ? 2 : $count - 1)]);
  $shown .= ', ...' if $count > 3;
  print "move\t$name\t$st[0]:$st[1]\t$count\t$shown\n";
}
print "written\t", clean($m->{writtenAt}), "\n";
print "digest\t$digest\n";
PERL

# The one step that may run through sudo: a single rename, after checking by
# device and inode, from a fresh listing, that the source is the checked
# folder by its exact name in the checked parent, and the destination is the
# checked parent plus that name and doesn't exist. It trusts none of its
# arguments, and writes nothing else. It holds no single quote, so
# move-back.sh can carry it. Exits 0 when moved (or, going back, when there
# was nothing to move), 3 when a check refuses, 4 on permission denied, 5 on
# another failure.
read -r -d '' HELPER <<'HELPER' || true
# LEGACY_RENAME_HELPER
use strict;
use warnings;
my @eight = qw(thumbnails medium optimized thumbnails-avif medium-avif optimized-avif lqip cache);
my ($mode, @a) = @ARGV;
sub stop { my ($code, $text) = @_; $text =~ s/[\x00-\x1f\x7f]/?/g; print STDERR "$text\n"; exit $code }
sub id_of { my @s = lstat $_[0] or return ""; return "" if -l _ || !-d _; return "$s[0]:$s[1]" }
my ($from, $from_id, $to, $to_id, $name, $folder_id);
if (defined $mode && $mode eq "forward" && @a == 7) {
  my $manifest;
  ($manifest, $from, $from_id, $to, $to_id, $name, $folder_id) = @a;
  require JSON::PP;
  require Digest::SHA;
  require Encode;
  open(my $fh, "<:raw", $manifest) or stop(3, "Cannot read the manifest $manifest. Nothing further was moved.");
  my $raw = do { local $/; <$fh> };
  close $fh;
  my $outer = eval { JSON::PP->new->utf8->decode($raw) };
  stop(3, "The manifest $manifest is not one photos legacy-derivatives wrote. Nothing further was moved.") unless ref $outer eq "HASH" && defined $outer->{manifest} && !ref $outer->{manifest};
  stop(3, "The manifest $manifest changed since it was checked. Nothing further was moved.") unless ($outer->{digest} // "") eq "sha256:" . Digest::SHA::sha256_hex(Encode::encode_utf8($outer->{manifest}));
  my $m = eval { JSON::PP->new->decode($outer->{manifest}) };
  stop(3, "The manifest $manifest can not be read. Nothing further was moved.") unless ref $m eq "HASH" && ref $m->{library} eq "HASH";
  stop(3, "$from is not the library the manifest names. Nothing further was moved.") unless $from_id eq ($m->{library}{dev} // "") . ":" . ($m->{library}{ino} // "");
} elsif (defined $mode && $mode eq "back" && @a == 6) {
  ($from, $from_id, $to, $to_id, $name, $folder_id) = @a;
} else {
  stop(2, "Usage: forward <manifest> <library> <dev:ino> <aside> <dev:ino> <name> <dev:ino>, or back <aside> <dev:ino> <library> <dev:ino> <name> <dev:ino>.");
}
stop(3, "$name is not one of the eight legacy folder names, exactly. Nothing further was moved.") unless grep { $_ eq $name } @eight;
stop(3, "$from is not the folder that was checked: its device and inode differ, or it is a symlink. Nothing further was moved.") unless $from_id ne "" && id_of($from) eq $from_id;
stop(3, "$to is not the folder that was checked: its device and inode differ, or it is a symlink. Nothing further was moved.") unless $to_id ne "" && id_of($to) eq $to_id;
opendir(my $d, $from) or stop(3, "Cannot list $from. Nothing further was moved.");
my $listed = grep { $_ eq $name } readdir $d;
closedir $d;
if (!$listed) {
  if ($mode eq "back") { print "$from/$name is not there: nothing to move back.\n"; exit 0 }
  stop(3, "$from has no entry named exactly $name now, so it changed since the check. Nothing further was moved.");
}
my @s = lstat "$from/$name" or stop(3, "Cannot read $from/$name. Nothing further was moved.");
stop(3, "$from/$name is a symlink now. Nothing further was moved.") if -l _;
stop(3, "$from/$name is not the folder that was checked: its device and inode changed. Nothing further was moved.") unless -d _ && "$s[0]:$s[1]" eq $folder_id;
if (lstat "$to/$name") { stop(3, "$to/$name exists. Compare it with $from/$name first. Nothing further was moved.") }
if (!rename("$from/$name", "$to/$name")) {
  stop(4, "Permission denied renaming $from/$name: $!") if $!{EACCES} || $!{EPERM};
  stop(5, "Renaming $from/$name failed: $!. Nothing further was moved.");
}
my @after = lstat "$to/$name";
stop(5, "$to/$name is not the folder that was moved. Look before going on.") unless @after && "$after[0]:$after[1]" eq $folder_id;
exit 0;
HELPER
case $HELPER in
  *"'"*) refuse "The rename helper holds a single quote, so move-back.sh couldn't carry it." ;;
esac

plan=$(perl -e "$VERIFY" -- "$manifest_file" "$used_file" "$to/legacy-derivatives.used" "$lib" "$(date +%s)" "${NAMES[@]}" 2>&1) ||
  refuse "$plan"

moves=()
ids=()
move_lines=()
stay_lines=()
digest=''
written=''
while IFS=$'\t' read -r kind name rest; do
  case $kind in
    move)
      moves+=("$name")
      ids+=("${rest%%$'\t'*}")
      rest=${rest#*$'\t'}
      count=${rest%%$'\t'*}
      [ "$count" -eq 1 ] && files='1 file' || files="$count files"
      move_lines+=("  $name moves aside: $files, such as ${rest#*$'\t'}")
      ;;
    stay) stay_lines+=("  $name stays: $rest") ;;
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

total=0
unknown=0
for name in "${moves[@]}"; do
  line="mv $(quote "$lib/$name") $(quote "$to/$name")"
  kb=$(printf '%s' "$sizes" | awk -v n="$name" '$1 == n { print $2 }')
  case $kb in
    '' | *[!0-9]*)
      unknown=$((unknown + 1))
      echo "$line  # size unknown"
      ;;
    *)
      total=$((total + kb))
      echo "$line  # $(human "$kb")"
      ;;
  esac
done
count=${#moves[@]}
[ "$count" -eq 1 ] && unit=folder || unit=folders
summary="Total: $count $unit, $(human "$total") on disk"
[ "$unknown" -eq 0 ] || summary="$summary, not counting $unknown whose size is unknown"
echo "$summary. It frees no space: the folders stay on the same filesystem."
echo

# move-back.sh: the helper going the other way, folder by folder, each checked
# by device and inode. $1 is the aside folder's device and inode.
move_back_text() {
  local aside_id=$1 i=0
  echo '#!/bin/sh'
  echo "# Moves the legacy folders scripts/host/legacy-move-aside.sh moved out of"
  echo "# $lib back into it. Safe to run after a partial move, or twice. Add"
  echo "# --rename-as-root if the moves needed it: then only each rename runs through sudo."
  echo "helper='$HELPER'"
  echo 'run=perl'
  # shellcheck disable=SC2016 # move-back.sh's own shell expands these
  echo '[ "${1:-}" != --rename-as-root ] || run="sudo perl"'
  echo 'status=0'
  for name in "${moves[@]}"; do
    echo "# mv $(quote "$to/$name") $(quote "$lib/$name")"
    echo "\$run -e \"\$helper\" -- back $(quote "$to") $(quote "$aside_id") $(quote "$lib") $(quote "$lib_id") $(quote "$name") $(quote "${ids[$i]}") || status=1"
    i=$((i + 1))
  done
  # shellcheck disable=SC2016
  echo 'exit $status'
}

way_back() {
  echo "To move them back, before restoring a data-root backup made before the catalog launch with web on v1.5.x or older, rolling back to v1.6.x, or rerunning photos carry-over, run $move_back with sh. It moves each folder back only while the library doesn't hold that name again. It holds:"
  echo "--- move-back.sh ---"
  move_back_text "$1"
  echo "--- end of move-back.sh ---"
}

if [ "$apply" -eq 0 ]; then
  echo "Dry run: nothing was moved. Run it again with --apply to make exactly these moves."
  echo
  way_back '<the aside folder>'
  exit 0
fi

if [ "$dest_exists" -eq 0 ]; then
  mkdir -- "$to" || refuse "Can't make $to."
fi
aside_id=$(stat_of %d:%i "$to") || aside_id=''
[ -n "$aside_id" ] || refuse "Can't read the device and inode of $to."

# A new file, never through a link, never over one: $1 the path, $2 its mode, stdin its text.
write_new() {
  perl -e 'use Fcntl qw(O_WRONLY O_CREAT O_EXCL O_NOFOLLOW); sysopen(my $f, $ARGV[0], O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, oct $ARGV[1]) or die "$!\n"; local $/; my $text = <STDIN>; print {$f} $text or die "$!\n"; close $f or die "$!\n"' -- "$1" "$2"
}

# The way back, and the manifest marked used, go to disk before the first
# move, so they're there whatever happens next. None is in the library, and
# none is written through a link.
move_back_text "$aside_id" | write_new "$move_back" 0644 || refuse "Can't write $move_back."
echo "$digest" | write_new "$aside_used" 0600 || refuse "Can't write $aside_used."
mkdir -p -- "$state_dir" || refuse "Can't make the state folder $state_dir."
printf '%s\n' "$digest" | perl -e '
  use Fcntl qw(O_WRONLY O_APPEND O_CREAT O_NOFOLLOW);
  my ($file, $dir) = @ARGV;
  sysopen(my $f, $file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0600) or die "$file: $!\n";
  my @st = stat $f;
  my $plain = -f _;
  my @folder = stat $dir or die "$dir: $!\n";
  die "$file is not a plain file with one link on the state folder'"'"'s disk\n" unless $plain && $st[3] == 1 && $st[0] == $folder[0];
  my $line = <STDIN>;
  print {$f} $line or die "$file: $!\n";
  close $f or die "$file: $!\n";
' -- "$used_file" "$state_dir" || refuse "Can't record the manifest as used in $used_file."

done_moves=()
i=0
for name in "${moves[@]}"; do
  set +e
  if [ "$as_root" -eq 1 ]; then
    sudo perl -e "$HELPER" -- forward "$manifest_file" "$lib" "$lib_id" "$to" "$aside_id" "$name" "${ids[$i]}"
  else
    perl -e "$HELPER" -- forward "$manifest_file" "$lib" "$lib_id" "$to" "$aside_id" "$name" "${ids[$i]}"
  fi
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    echo "Stopped: $lib/$name wasn't moved." >&2
    if [ "$code" -eq 4 ]; then
      echo "On Linux, moving a folder to a new parent needs write permission on the folder itself, to update its .. entry, and the v1.x watcher wrote these folders as uid 1001. Run the same command again with --rename-as-root after running photos legacy-derivatives --stdout again: only each checked rename then runs through sudo." >&2
    fi
    if [ ${#done_moves[@]} -gt 0 ]; then
      echo "Moved before it stopped: ${done_moves[*]}. $move_back moves them back." >&2
    elif [ "$dest_exists" -eq 0 ]; then
      echo "Nothing was moved. The folder $to was left with move-back.sh and the used record in it, and nothing to move back. It's safe to leave." >&2
    else
      echo "Nothing was moved. $move_back has nothing to move back, so $to is safe to leave as it is." >&2
    fi
    echo "The manifest is used up. Run photos legacy-derivatives --stdout again before another --apply." >&2
    exit 1
  fi
  done_moves+=("$name")
  i=$((i + 1))
done
echo "Moved $count $unit to $to."
echo
way_back "$aside_id"
