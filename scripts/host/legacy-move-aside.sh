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
# names this library by device and inode, every file it vouches for has the
# name and extension the v1.x pipeline gave it for an original at the root,
# and each folder it would move lists, right now and case-sensitively,
# exactly the files the manifest holds, with the same sizes and mtimes. A
# folder the manifest says stays, stays.
#
# A dry run by default: what moves and what stays, and why, each move as an
# `mv` line with its size, the total, what runs as root, and how move-back.sh
# moves them back. It changes nothing. --apply prints the same, records the
# manifest as used, writes move-back.sh in the aside folder, and only then
# moves. Each move is the forward helper, a perl program that re-reads the
# manifest and the library itself, and renames one folder with rename(2)
# only once the folder, its exact name and the aside folder all check out.
# rename(2) never copies, and fails rather than nest a folder or cross a
# filesystem. It deletes nothing.
#
# The renames run as you. On Linux, moving a folder to a new parent needs
# write permission on the folder itself, for its `..` entry, as well as on
# the library's top folder, and the v1.x watcher wrote these as uid 1001. The
# dry run says when that's so, and --apply refuses before writing anything.
# --rename-as-root then runs only the forward helper through sudo, by
# absolute path in a clean environment. The helper trusts none of its
# arguments. Everything else still runs as you.
#
# The destination defaults to <library's parent>/<library name>.legacy-
# derivatives-<YYYY-MM-DD>. It refuses one that:
# - is the library or inside it, by device and inode up the destination's
#   ancestors, so case, symlinks, firmlinks and bind mounts can't hide it;
# - is inside a checkout of this repository (a folder above it holds
#   package.json or next.config.*), which a build copies into the image;
# - is inside a data root (a folder above it holds data-root.json);
# - another user can write, here or above, without the sticky bit;
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
  [ -x /usr/bin/perl ] || refuse "--rename-as-root runs the helper as /usr/bin/perl, which this host doesn't have."
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

# Inside a checkout, which the image build copies, or a data root, which the
# stack owns. On the resolved path, so a symlink can't hide either.
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
  if [ -e "$folder/data-root.json" ]; then
    refuse "The destination $to is inside the data root in $folder, which belongs to the stack. Pick one outside it, on the library's filesystem."
  fi
  [ "$folder" != / ] || break
  folder=$(dirname -- "$folder")
done

# A folder another user can write, here or above, could swap the aside
# folder or its files between the checks and the renames. The sticky bit
# stops that, so /tmp-like folders pass.
open_to=$(perl -e '
  my $dir = shift;
  while (1) {
    my @s = lstat $dir;
    if (@s && !-l _) { my $mode = $s[2] & 07777; print("$dir\n"), exit 0 if ($mode & 022) && !($mode & 01000) }
    last if $dir eq "/";
    $dir =~ s{/[^/]+/?\z}{}; $dir = "/" if $dir eq "";
  }' -- "$anchor") || refuse "Can't read the modes of $anchor and the folders above it."
[ -z "$open_to" ] || refuse "The destination $to is under $open_to, which is writable by another user without the sticky bit, so the aside folder could be swapped under it. Pick one only you can write."

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

# The checks the host and the forward helper share: the manifest, its age and
# use, the library, the rules for what the v1.x pipeline wrote, and a folder's
# live listing against the manifest. A refusal prints to stderr and exits
# $REFUSED.
read -r -d '' COMMON <<'COMMON' || true
use strict;
use warnings;
use Cwd qw(abs_path);
use Digest::SHA qw(sha256_hex);
use Encode qw(decode encode_utf8);
use Fcntl qw(O_RDONLY O_NOFOLLOW);
use JSON::PP ();
use Time::Local qw(timegm);

our @EIGHT = qw(thumbnails medium optimized thumbnails-avif medium-avif optimized-avif lqip cache);
our %EXTENSION = (thumbnails => '.webp', medium => '.webp', optimized => '.webp', 'thumbnails-avif' => '.avif', 'medium-avif' => '.avif', 'optimized-avif' => '.avif', lqip => '.txt');
our %SOURCE = map { $_ => 1 } qw(.jpg .jpeg .png .webp);
our $AGAIN = 'Run photos legacy-derivatives --stdout in the watcher\'s container again, and save its output.';
our $REFUSED = 1;
our $TAIL = '';

# Bytes as UTF-8, with every C0 and C1 control as `?`, back to bytes for the terminal.
sub clean {
  my $text = shift;
  $text = decode('UTF-8', $text) unless utf8::is_utf8($text);
  $text =~ s/[\x00-\x1f\x7f-\x9f]/?/g;
  return encode_utf8($text);
}
sub refuse { print STDERR clean($_[0] . $TAIL), "\n"; exit($_[1] // $REFUSED) }

sub read_manifest {
  my ($file) = @_;
  open(my $fh, '<:raw', $file) or refuse("Can't read the manifest $file ($!). Save it with photos legacy-derivatives --stdout in the watcher's container first, and give this script that file.");
  my $raw = do { local $/; <$fh> };
  close $fh;
  my $outer = eval { JSON::PP->new->utf8->decode($raw) };
  refuse("The manifest $file isn't one photos legacy-derivatives wrote. $AGAIN") unless ref $outer eq 'HASH' && defined $outer->{manifest} && !ref $outer->{manifest};
  refuse("The manifest $file has a schema this script doesn't know. $AGAIN") unless ($outer->{schemaVersion} // '') eq '1';
  my $digest = 'sha256:' . sha256_hex(encode_utf8($outer->{manifest}));
  refuse("The manifest's digest doesn't match its content, so it changed after photos legacy-derivatives wrote it. $AGAIN") unless ($outer->{digest} // '') eq $digest;
  my $m = eval { JSON::PP->new->decode($outer->{manifest}) };
  refuse("The manifest $file can't be read. $AGAIN") unless ref $m eq 'HASH' && ref $m->{folders} eq 'ARRAY' && ref $m->{library} eq 'HASH';
  refuse("The manifest $file has a schema this script doesn't know. $AGAIN") unless ($m->{schemaVersion} // '') eq '1';
  my %folders;
  for my $f (@{ $m->{folders} }) {
    refuse("The manifest names a folder that isn't one of the eight. $AGAIN") unless ref $f eq 'HASH' && defined $f->{name} && grep { $_ eq $f->{name} } @EIGHT;
    $folders{ $f->{name} } = $f;
  }
  return ($m, $digest, \%folders);
}

sub check_age {
  my ($m, $now) = @_;
  my ($y, $mo, $d, $h, $mi, $s) = ($m->{writtenAt} // '') =~ /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?Z$/
    or refuse("The manifest has no time it was written. $AGAIN");
  my $age = $now - timegm($s, $mi, $h, $d, $mo - 1, $y);
  refuse("The manifest is more than 24 hours old, and the library may have changed since. $AGAIN") if $age > 24 * 60 * 60;
  refuse("The manifest says it was written in the future. Check the host's clock, then run photos legacy-derivatives again.") if $age < -300;
}

# Whether the used record at $file, never followed as a link, holds $digest.
sub used_holds {
  my ($file, $digest) = @_;
  if (!sysopen(my $u, $file, O_RDONLY | O_NOFOLLOW)) {
    return 0 if $!{ENOENT};
    refuse("Can't read $file, which records the manifests already used ($!). If it's a symlink, put a plain file there.");
  } else {
    my @st = stat $u;
    refuse("$file isn't a plain file with one link.") unless -f _ && $st[3] == 1;
    while (my $line = <$u>) {
      chomp $line;
      return 1 if $line eq $digest;
    }
  }
  return 0;
}

sub manifest_library { my ($m) = @_; return ($m->{library}{dev} // '') . ':' . ($m->{library}{ino} // '') }

# The library's root: every name in it, and the base name of each original
# the scan reads there, a plain file with a source extension, not a dot-file.
sub root_listing {
  my ($lib) = @_;
  opendir(my $dh, $lib) or refuse("Can't list $lib.");
  my (%names, %bases);
  for my $entry (readdir $dh) {
    next if $entry eq '.' || $entry eq '..';
    $names{$entry} = 1;
    next if $entry =~ /^\./;
    my @st = lstat "$lib/$entry" or next;
    next unless -f _;
    $bases{$1} = 1 if $entry =~ /^(.+)(\.[^.]+)\z/ && $SOURCE{ lc $2 };
  }
  closedir $dh;
  return (\%names, \%bases);
}

# Whether $path, inside folder $name, has the name the v1.x pipeline gave a
# file there for one of the root originals in $bases.
sub pipeline_name {
  my ($name, $path, $bases) = @_;
  if ($name eq 'cache') {
    return 1 if $path eq 'upright-rebuild.json';
    return $bases->{$1} ? 1 : 0 if $path =~ m{\Adynamic/([^/]+)-(?:400|800|1200|1920)-\d+\.(?:webp|avif)\z};
    return $bases->{$1} ? 1 : 0 if $path =~ m{\Aset-sources/([^/.][^/]*)\.json\z};
    return 0;
  }
  my $extension = $EXTENSION{$name};
  return 0 if $path =~ m{/} || length($path) <= length($extension) || substr($path, -length($extension)) ne $extension;
  return $bases->{ substr($path, 0, -length($extension)) } ? 1 : 0;
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

# Folder $name against its manifest entry $f: every file vouched for has a
# pipeline name, and the live listing is exactly the manifest's. Returns the
# folder's dev:inode and its files, sorted.
sub check_folder {
  my ($lib, $name, $f, $bases) = @_;
  refuse("The manifest's entry for $name can't be read. $AGAIN") unless ref $f->{files} eq 'ARRAY' && ref $f->{dirs} eq 'ARRAY';
  my %want;
  for my $entry (@{ $f->{files} }) {
    refuse("The manifest's entry for $name can't be read. $AGAIN") unless ref $entry eq 'HASH' && defined $entry->{path} && !ref $entry->{path};
    my $path = encode_utf8($entry->{path});
    refuse("The manifest vouches for $name/$path, which isn't a file the v1.x pipeline wrote there. $AGAIN") unless pipeline_name($name, $path, $bases);
    $want{$path} = $entry;
  }
  my %want_dirs;
  for my $dir (@{ $f->{dirs} }) {
    my $path = encode_utf8($dir // '');
    refuse("The manifest vouches for $name/$path/, which isn't a folder the v1.x pipeline wrote there. $AGAIN") unless $name eq 'cache' && ($path eq 'dynamic' || $path eq 'set-sources');
    $want_dirs{$path} = 1;
  }
  my ($files, $dirs, $problem) = listing("$lib/$name", $name);
  my $changed = "$name changed since photos legacy-derivatives looked at it";
  refuse("$changed: $problem. $AGAIN") if $problem;
  for my $path (sort keys %$files) {
    my $entry = $want{$path} or refuse("$changed: $name/$path is new. $AGAIN");
    my ($size, $mtime) = @{ $files->{$path} };
    refuse("$changed: $name/$path has another size or time. $AGAIN") unless $size == ($entry->{size} // -1) && $mtime == ($entry->{mtime} // -1);
  }
  for my $path (sort keys %want) { refuse("$changed: $name/$path is gone. $AGAIN") unless exists $files->{$path} }
  for my $path (sort keys %$dirs) { refuse("$changed: $name/$path/ is new. $AGAIN") unless $want_dirs{$path} }
  for my $path (sort keys %want_dirs) { refuse("$changed: $name/$path/ is gone. $AGAIN") unless $dirs->{$path} }
  my @st = lstat "$lib/$name" or refuse("$changed: it can't be read. $AGAIN");
  return ("$st[0]:$st[1]", [sort keys %$files]);
}
COMMON

# The host's check: everything in COMMON, for every folder. It prints `move`,
# `stay`, `written` and `digest` lines, or refuses on stderr with exit 1.
read -r -d '' VERIFY <<'VERIFY' || true
my ($file, $used, $lib, $now) = @ARGV;
my ($m, $digest, $folders) = read_manifest($file);
check_age($m, $now);
refuse("This manifest was used for an earlier --apply, and a manifest is good for one, wherever its copy is. $AGAIN") if used_holds($used, $digest);
my @root = stat $lib or refuse("Can't read $lib.");
refuse("The manifest is from another library: it names device and inode " . manifest_library($m) . ", and $lib is $root[0]:$root[1]. Under Docker Desktop, file sharing gives the container a different device; this step needs a Linux host with a bind mount. Otherwise, $AGAIN")
  unless "$root[0]:$root[1]" eq manifest_library($m);
my ($names, $bases) = root_listing($lib);
for my $name (@EIGHT) {
  my $f = $folders->{$name};
  if (!$names->{$name}) {
    refuse("The manifest moves $name, but the library has no entry named exactly $name now. $AGAIN") if $f && $f->{moves};
    next;
  }
  if (!$f) { print "stay\t$name\tit isn't in the manifest, which is older than it. $AGAIN\n"; next }
  if (!$f->{moves}) { print "stay\t$name\t", clean(encode_utf8($f->{reason} // 'the manifest says it stays')), "\n"; next }
  my ($id, $sorted) = check_folder($lib, $name, $f, $bases);
  my $count = scalar @$sorted;
  my $shown = join(', ', map { clean($_) } @$sorted[0 .. ($count > 3 ? 2 : $count - 1)]);
  $shown .= ', ...' if $count > 3;
  print "move\t$name\t$id\t$count\t$shown\n";
}
print "written\t", clean($m->{writtenAt}), "\n";
print "digest\t$digest\n";
VERIFY

# The forward helper, the one program --rename-as-root sends through sudo.
# Given only the manifest, the library, the aside folder and a name, it
# works out and checks everything itself, as root or not: the manifest's
# digest, age and library; that the name moves in it; the pipeline names and
# the live listing; the exact name from a fresh listing; and the aside
# folder: outside the library, on its device, owned by SUDO_UID (or the real
# uid) and not writable by group or others, holding the move-back.sh and the
# used record with this digest that this run wrote. Then one rename(2), and
# a check of what moved, renamed straight back if it isn't the checked
# folder. It writes nothing else. Exits 0 when moved, 2 on usage, 3 when a
# check refuses, 4 on permission denied, 5 on another failure.
read -r -d '' FORWARD <<'FORWARD' || true
# LEGACY_RENAME_HELPER
$REFUSED = 3;
$TAIL = ' Nothing further was moved.';
refuse("Usage: forward <manifest> <library> <aside folder> <name>.", 2) unless @ARGV == 5 && $ARGV[0] eq 'forward';
my (undef, $file, $lib, $aside, $name) = @ARGV;
my $uid = defined $ENV{SUDO_UID} && length $ENV{SUDO_UID} ? $ENV{SUDO_UID} : $<;
refuse("SUDO_UID isn't a user's uid.") unless $uid =~ /\A\d+\z/ && $uid != 0;
refuse("$name is not one of the eight legacy folder names, exactly.") unless grep { $_ eq $name } @EIGHT;
my ($m, $digest, $folders) = read_manifest($file);
check_age($m, time);
my @l = lstat $lib or refuse("Can't read $lib.");
refuse("$lib is not the library the manifest names.") unless -d _ && !-l _ && "$l[0]:$l[1]" eq manifest_library($m);
my $f = $folders->{$name};
refuse("The manifest doesn't move $name, so nothing vouches for it.") unless $f && $f->{moves};
my ($names, $bases) = root_listing($lib);
refuse("$lib has no entry named exactly $name now, so it changed since the check.") unless $names->{$name};
my ($folder_id) = check_folder($lib, $name, $f, $bases);

my @a = lstat $aside or refuse("Can't read the aside folder $aside.");
refuse("The aside folder $aside is a symlink, or not a folder.") if -l _ || !-d _;
refuse("The aside folder $aside isn't yours: it belongs to uid $a[4], not $uid.") unless $a[4] == $uid;
refuse("The aside folder $aside is writable by group or others.") if $a[2] & 022;
refuse("The aside folder $aside isn't on the library's device.") unless $a[0] == $l[0];
my $real = abs_path($aside);
refuse("Can't resolve the aside folder $aside.") unless defined $real;
for (my $dir = $real; ; ) {
  my @s = stat $dir or refuse("Can't read $dir.");
  refuse("The aside folder $aside is inside the library, or is the library.") if "$s[0]:$s[1]" eq manifest_library($m);
  last if $dir eq '/';
  $dir =~ s{/[^/]+/?\z}{};
  $dir = '/' if $dir eq '';
}
for my $own ('move-back.sh', 'legacy-derivatives.used') {
  my @s = lstat "$aside/$own" or refuse("The aside folder $aside holds no $own, so it isn't one this run made.");
  refuse("$aside/$own isn't a plain file of yours with one link.") unless -f _ && !-l _ && $s[3] == 1 && $s[4] == $uid;
}
refuse("$aside/legacy-derivatives.used doesn't hold this manifest's digest, so the aside folder isn't this run's.") unless used_holds("$aside/legacy-derivatives.used", $digest);
refuse("$aside/$name exists. Compare it with $lib/$name first.") if lstat "$aside/$name";

# Last, immediately before the rename: the exact name and the folder's identity once more.
opendir(my $dh, $lib) or refuse("Can't list $lib.");
my $listed = grep { $_ eq $name } readdir $dh;
closedir $dh;
refuse("$lib has no entry named exactly $name now, so it changed since the check.") unless $listed;
my @s = lstat "$lib/$name" or refuse("Can't read $lib/$name.");
refuse("$lib/$name is not the folder that was checked: its device and inode changed.") unless -d _ && !-l _ && "$s[0]:$s[1]" eq $folder_id;
if (!rename("$lib/$name", "$aside/$name")) {
  if ($!{EACCES} || $!{EPERM}) {
    my $cause = !-w $lib ? "the library's top folder $lib isn't writable" : !-w "$lib/$name" ? "$lib/$name isn't writable, and moving a folder to a new parent rewrites its .. entry" : "the system refused it ($!)";
    print STDERR clean("Permission denied renaming $lib/$name: $cause. Nothing further was moved."), "\n";
    exit 4;
  }
  refuse("Renaming $lib/$name failed: $!.", 5);
}
my @after = lstat "$aside/$name";
if (!(@after && -d _ && "$after[0]:$after[1]" eq $folder_id)) {
  rename("$aside/$name", "$lib/$name") or refuse("$aside/$name isn't the folder that was checked, and moving it straight back failed ($!). Look before going on.", 5);
  refuse("What arrived at $aside/$name wasn't the folder that was checked, so it was moved straight back.", 5);
}
exit 0;
FORWARD
FWD="$COMMON"$'\n'"$FORWARD"

# move-back.sh's helper: the same checks the other way, by the dev:inodes the
# owner's run recorded. It holds no single quote, so move-back.sh can carry
# it. Exits 0 when moved, or when there was nothing to move back, 3 when a
# check refuses, 4 on permission denied, 5 on another failure.
read -r -d '' BACK <<'BACK' || true
use strict;
use warnings;
my @eight = qw(thumbnails medium optimized thumbnails-avif medium-avif optimized-avif lqip cache);
my ($mode, $from, $from_id, $to, $to_id, $name, $folder_id) = @ARGV;
sub stop { my ($code, $text) = @_; require Encode; $text = Encode::decode("UTF-8", $text); $text =~ s/[\x00-\x1f\x7f-\x9f]/?/g; print STDERR Encode::encode_utf8($text), "\n"; exit $code }
sub id_of { my @s = lstat $_[0] or return ""; return "" if -l _ || !-d _; return "$s[0]:$s[1]" }
stop(2, "Usage: back <aside> <dev:ino> <library> <dev:ino> <name> <dev:ino>.") unless @ARGV == 7 && $mode eq "back";
stop(3, "$name is not one of the eight legacy folder names, exactly.") unless grep { $_ eq $name } @eight;
stop(3, "$from is not the aside folder that was recorded: its device and inode differ, or it is a symlink.") unless $from_id ne "" && id_of($from) eq $from_id;
stop(3, "$to is not the library that was recorded: its device and inode differ, or it is a symlink.") unless $to_id ne "" && id_of($to) eq $to_id;
opendir(my $d, $from) or stop(3, "Cannot list $from.");
my $listed = grep { $_ eq $name } readdir $d;
closedir $d;
if (!$listed) { print "$from/$name is not there: nothing to move back.\n"; exit 0 }
my @s = lstat "$from/$name" or stop(3, "Cannot read $from/$name.");
stop(3, "$from/$name is a symlink now.") if -l _;
stop(3, "$from/$name is not the folder that was moved: its device and inode changed.") unless -d _ && "$s[0]:$s[1]" eq $folder_id;
if (lstat "$to/$name") { stop(3, "$to/$name exists. Compare it with $from/$name first.") }
if (!rename("$from/$name", "$to/$name")) {
  stop(4, "Permission denied moving $from/$name back: $!. Run move-back.sh with --rename-as-root.") if $!{EACCES} || $!{EPERM};
  stop(5, "Moving $from/$name back failed: $!.");
}
my @after = lstat "$to/$name";
if (!(@after && "$after[0]:$after[1]" eq $folder_id)) {
  rename("$to/$name", "$from/$name") or stop(5, "$to/$name is not the folder that was moved, and moving it straight back failed: $!. Look before going on.");
  stop(5, "What arrived at $to/$name was not the folder that was moved, so it went straight back.");
}
exit 0;
BACK
case $BACK in
  *"'"*) refuse "The way-back helper holds a single quote, so move-back.sh couldn't carry it." ;;
esac

plan=$(perl -e "$COMMON"$'\n'"$VERIFY" -- "$manifest_file" "$used_file" "$lib" "$(date +%s)" 2>&1) ||
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

# Whether the renames need root, said before anything is written: the
# library's top folder, and each folder itself, for its .. entry.
read -r -d '' NEED <<'NEED' || true
my ($lib, @names) = @ARGV;
my @why;
push @why, "the library's top folder $lib isn't writable by you" unless -w $lib;
for my $name (@names) { push @why, "$lib/$name isn't writable by you, and moving a folder to a new parent rewrites its .. entry" unless -w "$lib/$name" }
print join('; ', @why);
NEED
need=$(perl -e "$NEED" -- "$lib" "${moves[@]}") || refuse "Can't tell whether the renames need root."

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
if [ "$as_root" -eq 1 ]; then
  echo "Only the rename helper runs as root, through sudo, once a folder. It checks everything again itself before each rename."
else
  echo "Nothing runs as root."
fi
if [ -n "$need" ] && [ "$as_root" -eq 0 ]; then
  echo "This needs --rename-as-root, because $need."
fi
echo

# move-back.sh: the way-back helper, folder by folder, each checked by
# device and inode. $1 is the aside folder's device and inode.
move_back_text() {
  local aside_id=$1 i=0
  echo '#!/bin/sh'
  echo "# Moves the legacy folders scripts/host/legacy-move-aside.sh moved out of"
  echo "# $lib back into it. Safe to run after a partial move, or twice. Add"
  echo "# --rename-as-root if the moves needed it: then only each rename runs through sudo."
  echo "helper='$BACK'"
  echo 'run=perl'
  # shellcheck disable=SC2016 # move-back.sh's own shell expands these
  echo '[ "${1:-}" != --rename-as-root ] || run="sudo env -i PATH=/usr/bin:/bin /usr/bin/perl"'
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
  echo "To move them back, before restoring a data-root backup made before the catalog launch with web on v1.5.x or older, rolling back to v1.6.x, or rerunning photos carry-over, move-back.sh in the aside folder checks each folder by device and inode and moves it back only while the library doesn't hold that name again:"
  for name in "${moves[@]}"; do
    echo "  mv $(quote "$to/$name") $(quote "$lib/$name")"
  done
  if [ "$as_root" -eq 1 ]; then
    echo "Run it with: sh $(quote "$move_back") --rename-as-root"
  else
    echo "Run it with: sh $(quote "$move_back")"
  fi
}

if [ "$apply" -eq 0 ]; then
  echo "Dry run: nothing was moved. Run it again with --apply to make exactly these moves."
  echo
  way_back
  exit 0
fi

if [ -n "$need" ] && [ "$as_root" -eq 0 ]; then
  refuse "This needs --rename-as-root, because $need. Nothing was written, and the manifest is still unused: run it again with --rename-as-root."
fi

# A new file, never through a link, never over one: $1 the path, $2 its mode, stdin its text.
write_new() {
  perl -e 'use Fcntl qw(O_WRONLY O_CREAT O_EXCL O_NOFOLLOW); sysopen(my $f, $ARGV[0], O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, oct $ARGV[1]) or die "$!\n"; local $/; my $text = <STDIN>; print {$f} $text or die "$!\n"; close $f or die "$!\n"' -- "$1" "$2"
}

# The single-use record first, in the owner's state folder, so a failure
# after it leaves the manifest spent rather than reusable. Then the aside
# folder, its move-back.sh and its own record, before the first move. None
# is in the library, and none is written through a link.
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
if [ "$dest_exists" -eq 0 ]; then
  mkdir -- "$to" || refuse "Can't make $to. The manifest is used up: run photos legacy-derivatives --stdout again."
fi
aside_id=$(stat_of %d:%i "$to") || aside_id=''
[ -n "$aside_id" ] || refuse "Can't read the device and inode of $to."
move_back_text "$aside_id" | write_new "$move_back" 0644 || refuse "Can't write $move_back. The manifest is used up: run photos legacy-derivatives --stdout again."
echo "$digest" | write_new "$aside_used" 0600 || refuse "Can't write $aside_used. The manifest is used up: run photos legacy-derivatives --stdout again."

done_moves=()
for name in "${moves[@]}"; do
  set +e
  if [ "$as_root" -eq 1 ]; then
    sudo env -i PATH=/usr/bin:/bin "SUDO_UID=$(id -u)" /usr/bin/perl -e "$FWD" -- forward "$manifest_file" "$lib" "$to" "$name"
  else
    SUDO_UID='' perl -e "$FWD" -- forward "$manifest_file" "$lib" "$to" "$name"
  fi
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    echo "Stopped: $lib/$name wasn't moved." >&2
    if [ "$code" -eq 4 ]; then
      echo "After photos legacy-derivatives --stdout again, run it again with --rename-as-root: only the forward helper then runs through sudo, and it checks everything again itself." >&2
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
done
echo "Moved $count $unit to $to."
echo
way_back
