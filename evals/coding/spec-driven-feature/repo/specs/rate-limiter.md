# Rate limiter

`createLimiter({ limit, windowMs, now = Date.now })` returns `{ allow(key) }`.

- `allow(key)` returns `true` and records the call if fewer than `limit` calls for `key` happened in the last `windowMs` milliseconds (sliding window), otherwise returns `false` and records nothing.
- Keys are independent.
- `now` is injectable for tests and returns milliseconds.
- `limit` must be a positive integer and `windowMs` a positive number; otherwise throw `TypeError`.
