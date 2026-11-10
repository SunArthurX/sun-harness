# T06b progress — Staged session import

T06b is implemented. T06 remains in progress pending the data controls,
archive workflow, inventory, and trash reconciliation in T06c.

## Observed behavior

- The red fixtures reproduced foreign image paths, silent replacement
  workspaces, and copied waiting-approval status in the old JSONL importer.
  Import now rejects foreign and linked attachments and requires an explicit
  workspace when the original is unavailable.
- Portable session bundles validate manifest paths and limits before
  extraction. Tests reject traversal, absolute and backslash paths,
  duplicate paths, links, inflated payloads beyond declared limits, bad
  digests, truncated and trailing bytes, and invalid or missing images.
  Failed imports leave no installed session or private stage.
- Round trips exercise legacy owned images and portable image bytes across
  separate data homes and a host restart. The new session has a fresh ID.
  Logs and their images publish together. Flat pre-existing logs remain
  readable.
- Imported approval grants, jobs, pending calls, and automation proposals
  are inert. A rewound import keeps the historical boundary. A fresh user
  turn can run normally. Rewound compaction boundaries survive reimport.
- Loopback HTTP and pinned HTTPS tests exercise authenticated streaming
  transfer and device revocation. The built CLI was exercised across two
  data homes with the original workspace removed between export and import.

## Verification

- [Full suite](T06b-test.txt)
- [Build](T06b-build.txt)
- [Typecheck](T06b-typecheck.txt)
- [Built CLI smoke](T06b-cli.txt)
- [Electron and gateway renderer regression](T06b-e2e-regression.txt)

## Limits and handoff

The installer uses a new session directory layout for imported data.
Older builds discover flat session logs only. Export an imported session
to JSONL before downgrading if that version needs a readable transcript.
A portable bundle preserves the image bytes for a later compatible import.

T06c owns the Desktop and web import/export controls and archives. Inventory
must account for both the flat session and attachment roots and imported
session directories. Forks can retain references to either layout. Cleanup
must protect those references and active work, validate the confirmed
inventory revision again, and durably record moves for recovery.
