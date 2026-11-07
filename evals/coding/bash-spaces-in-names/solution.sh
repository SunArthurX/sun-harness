#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > backup.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
src=$1
dst=$2
if [[ ! -d "$src" ]]; then
  echo "source directory not found: $src" >&2
  exit 1
fi
mkdir -p "$dst"
count=0
shopt -s nullglob
for f in "$src"/*.txt; do
  cp "$f" "$dst/"
  count=$((count + 1))
done
echo "$count"
EOF
