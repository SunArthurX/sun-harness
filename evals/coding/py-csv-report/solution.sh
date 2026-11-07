#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > report.py <<'EOF'
import csv, json
from collections import defaultdict

totals = defaultdict(float)
with open('sales.csv', newline='') as f:
    for row in csv.DictReader(f):
        totals[row['region']] += int(row['units']) * float(row['unit_price'])
print(json.dumps({k: round(totals[k], 2) for k in sorted(totals)}))
EOF
