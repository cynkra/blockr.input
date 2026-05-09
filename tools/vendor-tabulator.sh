#!/usr/bin/env bash
# Vendor a pinned Tabulator release into inst/js/vendor/tabulator/.
# Usage: tools/vendor-tabulator.sh [version]   (default 6.3.1)
set -euo pipefail
VERSION="${1:-6.3.1}"
DEST="inst/js/vendor/tabulator"
mkdir -p "$DEST"
curl -fsSL -o "$DEST/tabulator.min.js"  "https://unpkg.com/tabulator-tables@${VERSION}/dist/js/tabulator.min.js"
curl -fsSL -o "$DEST/tabulator.min.css" "https://unpkg.com/tabulator-tables@${VERSION}/dist/css/tabulator.min.css"
echo "$VERSION" > "$DEST/VERSION"
echo "Vendored Tabulator $VERSION → $DEST"
