#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > validate.py <<'EOF'
import re

LOCAL = r"[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*"
LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?"
EMAIL = re.compile(rf"^{LOCAL}@{LABEL}(?:\.{LABEL})+$")

def is_valid_email(s: str) -> bool:
    return bool(EMAIL.match(s))
EOF
