#!/usr/bin/env bash
# Fails when `npm run build` copied project files, the default data root, or
# the library into .next/standalone, which happens when Turbopack traces the
# whole project, or a pattern such as every .json file at the root. Run it
# after the build, from the repository root.
set -euo pipefail

dir=.next/standalone
if [ ! -d "$dir" ]; then
  echo "::error::There is no $dir. Run npm run build first."
  exit 1
fi

found=()
for entry in app components lib utils scripts docs e2e test ci portfolio-data public/assets/photos tsconfig.json package-lock.json; do
  if [ -e "$dir/$entry" ]; then found+=("$entry"); fi
done
if [ ${#found[@]} -gt 0 ]; then
  echo "::error::The build traced project files into $dir, which now holds: ${found[*]}"
  exit 1
fi
echo "$dir holds no project sources, data root, or library."
