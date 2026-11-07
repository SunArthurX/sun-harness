#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
grep -rl getUserName src | xargs sed -i '' 's/getUserName/getDisplayName/g'
