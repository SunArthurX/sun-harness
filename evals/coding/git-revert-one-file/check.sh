#!/usr/bin/env bash
set -euo pipefail
python3 -c "import json,sys; d=json.load(open('pricing.json')); sys.exit(0 if d=={'basic':10,'pro':20} else 1)" || { echo 'pricing.json not restored'; exit 1; }
grep -q 'second line' notes.md || { echo 'notes.md lost its change'; exit 1; }
git log -1 --format=%s | grep -q '^Revert pricing' || { echo 'missing revert commit'; exit 1; }
test -z "$(git status --porcelain -- pricing.json notes.md)" || { echo 'uncommitted changes'; exit 1; }
