#!/usr/bin/env bash
# The full SHA of the one commit a Perf A/B ref names, for the checkout that
# measures it. actions/checkout reads a short SHA as a branch name and fails,
# so the workflow resolves the ref first, in a clone with every branch and tag.
#
#   bash ci/perf/resolve-ref.sh <git-dir> <ref>
#
# <ref> is a full or short SHA (4 to 40 hex digits), a branch, or a tag, by
# its own name: a full refs/heads/... or refs/tags/... name is refused, as is
# any name git check-ref-format refuses. It
# prints the 40-character SHA on stdout. A ref that names no commit, or names
# more than one (a short SHA two commits share, or a branch and a tag of that
# name on different commits), exits 1 with a ::error:: line that says which.
# A branch is read from refs/remotes/origin, where actions/checkout fetches
# it, or from refs/heads when origin has none of that name: the local branch
# the checkout made can lag origin's if a push lands mid-run, and that isn't a
# second commit. Only git; it writes nothing. The workflow's clone is a
# partial one (blob:none), where git would fetch a missing object on demand
# (rev-parse on a blob's SHA does), so every git call here runs with
# GIT_NO_LAZY_FETCH=1, set for that command alone.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <git-dir> <ref>" >&2
  exit 2
fi
GIT_DIR_ARG=$1
REF=$2

fail() {
  echo "::error::$1" >&2
  exit 1
}

# The ref as the shell would quote it, so a newline in it can't end the ::error:: line and start another workflow
# command. A ref that passes the checks below has none of the characters %q escapes.
SHOWN=$(printf %q "$REF")

[ -n "$REF" ] || fail "The ref is empty. Give a branch, a tag, or a commit SHA."
# Never an option to git, and only the characters a branch, tag or SHA takes here.
if [[ $REF == -* || ! $REF =~ ^[A-Za-z0-9._/-]+$ ]]; then
  fail "'$SHOWN' isn't a branch, tag or commit SHA: use letters, digits, '.', '_', '/' and '-', not starting with '-'."
fi
# Nor '..', a '.lock' or '/' at the end, an empty or dot-led part, and the rest git refuses in a ref name.
GIT_NO_LAZY_FETCH=1 git check-ref-format --allow-onelevel "$REF" || fail "'$SHOWN' isn't a valid branch or tag name (git check-ref-format refuses it)."
if [[ $REF =~ ^refs/(heads|tags|remotes/origin)/(.+)$ ]]; then
  fail "'$SHOWN' is a full ref name. Give the branch or tag by its own name, as in '${BASH_REMATCH[2]}'."
fi

g() {
  GIT_NO_LAZY_FETCH=1 git --git-dir="$GIT_DIR_ARG" "$@"
}

# What the ref names, one "<sha> <what>" line each.
FOUND=()
commit_of() {
  g rev-parse --verify --quiet "$1^{commit}" 2>/dev/null || true
}
add() {
  [ -n "$1" ] && FOUND+=("$1 $2")
  return 0
}

branch=$(commit_of "refs/remotes/origin/$REF")
[ -n "$branch" ] || branch=$(commit_of "refs/heads/$REF")
add "$branch" "the branch $REF"
add "$(commit_of "refs/tags/$REF")" "the tag $REF"
if [[ $REF =~ ^[0-9a-fA-F]{4,40}$ ]]; then
  prefix=$(printf '%s' "$REF" | tr 'A-F' 'a-f')
  if [ "${#prefix}" -eq 40 ]; then
    add "$(commit_of "$prefix")" "the commit $prefix"
  else
    # Every object the prefix starts, of any type; only commits count.
    while read -r object; do
      [ -n "$object" ] || continue
      [ "$(g cat-file -t "$object" 2>/dev/null || true)" = commit ] && add "$object" "the commit $object"
    done < <(g rev-parse --disambiguate="$prefix" 2>/dev/null || true)
  fi
fi

[ "${#FOUND[@]}" -gt 0 ] || fail "No branch, tag or commit is named '$SHOWN' in this repository."
SHAS=$(printf '%s\n' "${FOUND[@]}" | cut -d' ' -f1 | sort -u)
if [ "$(printf '%s\n' "$SHAS" | wc -l | tr -d ' ')" -ne 1 ]; then
  WHAT=$(printf '%s\n' "${FOUND[@]}" | sort -u | cut -d' ' -f2- | sort -u | paste -sd ';' - | sed 's/;/; /g')
  fail "'$SHOWN' is ambiguous: it names more than one commit ($WHAT). Give the full SHA, or a longer one."
fi
printf '%s\n' "$SHAS"
