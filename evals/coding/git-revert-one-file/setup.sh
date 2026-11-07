#!/usr/bin/env bash
# Runs in the workspace after the initial commit: create the commit the agent must partially revert.
set -euo pipefail
printf '{"basic": 12, "pro": 25}\n' > pricing.json
printf '# Notes\nsecond line\n' > notes.md
git add -A && git commit -qm "Raise prices and update notes"
