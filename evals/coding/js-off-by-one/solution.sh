#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
sed -i '' 's/i < end/i <= end/' src/range.js
