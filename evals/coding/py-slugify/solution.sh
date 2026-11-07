#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > text_utils.py <<'EOF'
import re
import unicodedata

def slugify(text: str, max_length: int = 50) -> str:
    t = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode().lower()
    t = re.sub(r'[^a-z0-9]+', '-', t).strip('-')
    return t[:max_length].rstrip('-')
EOF
