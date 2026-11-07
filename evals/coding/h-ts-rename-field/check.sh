#!/usr/bin/env bash
set -euo pipefail
tsc --noEmit -p .
node --test .eval-hidden/*.test.mjs
