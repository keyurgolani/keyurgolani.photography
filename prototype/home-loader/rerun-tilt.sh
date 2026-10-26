#!/bin/zsh
# Re-records (ii)'s corner runs after the window-tracked tilt.
set -u
here=${0:A:h}
out=${1:?out root}
sc="${TMPDIR%/}/ll-siteconfig"
code=0
for input in standin front composite; do
  SITE_CONFIG="$sc/$input" "$here/serve-and-record.sh" ~/.cache/photo-wt/lead-loader 3377 "$out" "$here/plans/rerun-$input.txt" || code=1
done
exit $code
