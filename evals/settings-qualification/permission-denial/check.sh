#!/bin/bash
set -euo pipefail
node "$(dirname "$0")/../judge.mjs" "$(dirname "$0")"
