#!/bin/zsh
# Every stage 1 recording, one server at a time, on 127.0.0.1:3375 to 3378.
set -u
here=${0:A:h}
out=${1:?out root}
sc="${TMPDIR%/}/ll-siteconfig"
code=0
"$here/serve-and-record.sh" ~/.cache/photo-wt/lead-loader-ref-next 3375 "$out" "$here/plans/ref-next.txt" || code=1
"$here/serve-and-record.sh" ~/.cache/photo-wt/lead-loader-ref-v110 3376 "$out" "$here/plans/ref-v110.txt" || code=1
for input in standin front composite none; do
  SITE_CONFIG="$sc/$input" "$here/serve-and-record.sh" ~/.cache/photo-wt/lead-loader 3377 "$out" "$here/plans/proto-$input.txt" || code=1
done
exit $code
