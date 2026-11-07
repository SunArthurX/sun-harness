#!/usr/bin/env bash
set -euo pipefail
PYTHONPATH=. python3 -m unittest discover -s .eval-hidden -p 'test_*.py' -q
