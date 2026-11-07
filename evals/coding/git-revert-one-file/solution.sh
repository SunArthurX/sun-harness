#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
git checkout HEAD~1 -- pricing.json && git commit -qm 'Revert pricing change'
