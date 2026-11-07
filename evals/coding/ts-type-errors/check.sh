#!/usr/bin/env bash
set -euo pipefail
if grep -rnE '\bany\b|@ts-ignore|@ts-expect-error' src; then echo 'forbidden escape hatch'; exit 1; fi
tsc --noEmit -p .
git diff --quiet "$EVAL_BASE" -- tsconfig.json
