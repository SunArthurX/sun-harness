# T02 progress checkpoint

The configuration file transaction layer is wired into the existing configuration load and save
functions. The revision check hashes exact persisted bytes. A lock is published as an atomically
renamed directory with a unique owner marker. Recovery removes a marker only after the owner PID
is absent. An empty lock directory can be removed safely even while another writer is acquiring it.
Config writes use a private temporary file and flush it before replacement. The store records
whether the directory flush succeeded separately from whether the replacement committed.

The focused suite covers stale revisions, malformed JSON, unknown key preservation, permissions,
injected write and replace failures, abrupt process exit before and after replace, a live lock,
a manual edit during preparation, and two real subprocesses sharing a revision. The failed
pre-implementation test run is preserved in `T02-store-red.txt`.

This checkpoint covers the file layer. See the T02 completion record for the public settings
interface, client migration, recovery, audit behavior, and end-to-end verification.
