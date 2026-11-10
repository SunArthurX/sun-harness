# validated-setting — Add a validated setting through all surfaces

Edit only src/schema.mjs, src/renderer.mjs, src/cli.mjs. You may add test/additions.test.mjs.

Acceptance: Add pageSize with default 25 and inclusive integer range 10 through 100.
Expose it through the existing host, Electron IPC, gateway and renderer. The
renderer labels are Page size and 每页数量. The CLI accepts decimal digit
strings for pageSize and refuses partial numbers or values outside the range.
Use the existing revision check, default provenance and persistence behavior.
Keep verbose behavior and unknown persisted keys. Do not change the host or
transport implementation. Invalid edits must leave values and revision intact.
