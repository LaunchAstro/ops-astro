#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Final committed-history checks. Local file-only preparation uses candidate-snapshot.mjs.
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/publication-receipt.mjs" "$@"
