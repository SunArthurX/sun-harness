# ADR 0010 — Fixture boundaries

The application entry points use explicit interfaces. Keep validation and policy
at the shared boundary, preserve legacy values and use stable reason codes.
Replay reads owned attachments through an injected reader. Preserve model-visible
messages when an attachment is unavailable.
