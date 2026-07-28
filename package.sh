#!/bin/bash
# Builds the directory that gets published to npm.
#
# `set -euo pipefail` is load-bearing. This used to have no `set -e` and to call a bare `tsc`,
# so when the compile produced nothing the script carried on regardless: `cp -r lib package/lib`
# failed too, and it printed "Done" and exited 0 having produced a package/ directory holding
# nothing but LICENSE, README.md and package.json. That matters because release.yml runs
# `npm run package` immediately before `npm run release`, and @semantic-release/npm is pointed at
# `pkgRoot: "package"`, so a build that emitted no code would have been published as a real
# version, with `bin` naming a lib/generator.js that was not in the tarball.
set -euo pipefail

START_TIME=$SECONDS
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "Building package..."
# `-rf`, because on a clean checkout neither directory exists and plain `rm -r` printed two
# "No such file or directory" errors before doing the right thing anyway.
rm -rf lib package
# The repo's own TypeScript, not whatever happens to be on PATH. `npm run package` adds
# node_modules/.bin for us, but this script is also run directly.
./node_modules/.bin/tsc
mkdir package

echo "Copying files..."
cp -r lib package/lib
cp package.json README.md LICENSE package

echo "Making package.json public..."
sed -i 's/"private": true/"private": false/' ./package/package.json

# Post-conditions. `npm publish` will happily ship a package whose `bin` points at a file that
# is not in it, so the entry point has to be asserted rather than assumed.
test -f package/lib/generator.js
test -f package/lib/prisma-generator.js
test -f package/lib/transformer.js

ELAPSED_TIME=$(($SECONDS - $START_TIME))
echo "Done in $ELAPSED_TIME seconds, $(find package -type f | wc -l) files."
