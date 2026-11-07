#!/usr/bin/env bash
set -euo pipefail
cmp -s test/cart.test.mjs .eval-hidden/orig-cart.test.mjs || { echo 'tests were modified'; exit 1; }
node --test 'test/*.test.mjs'
