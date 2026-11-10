# T06a progress — Transcript export

T06 remains in progress. This slice covers the export boundary of C05.
The bundle installer, archives, and cleanup still need their AC-06 evidence.

- The HTML regression fixture reproduced executable event attributes in
  exported details, summaries, and code fences. The output now escapes those
  lines and includes a restrictive content security policy.
- The credential fixture first reproduced a configured secret in Markdown.
  Markdown, HTML, and JSONL now use the same redacted event copy. The fixture
  verifies raw and environment credentials, an authorization header, a device
  token, a JSON-escaped tool argument, and unchanged session replay data.
- [Unit tests](T06a-test.txt) passed with 250 passed and one existing skip.
  [Build](T06a-build.txt) and the plan integrity check also passed.

## Next dependency-ready slice

T06b owns staged import. The legacy JSONL route currently accepts embedded
absolute image paths and imported approval or automation state. Before adding
bundle loading, test rejection of attachment paths outside the staged bundle
and ensure that starting or resuming an imported conversation cannot run
historical pending tools, grant historical approvals, or activate a proposal.
Keep the existing JSONL entry point for safe transcripts and preserve history
that can be displayed without enabling its side effects.
