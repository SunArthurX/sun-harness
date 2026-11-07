#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
sed -i '' 's/^from models import/from .models import/; s/^from pricing import/from .pricing import/' shop/pricing.py shop/main.py
