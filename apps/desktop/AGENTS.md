# Desktop renderer

The desktop app and the gateway web UI share this renderer.

- User-visible strings go through `t()` / `tk()` with the **English sentence as the key**.
- Add the Simplified Chinese entry in `src/renderer/src/locale-zh-CN.ts` **in the same change** (keep `{name}` placeholders).
- `apps/desktop/test/i18n.test.ts` fails if a string is not wrapped, not translated, or placeholders drifted. Spec: `specs/028-ui-i18n.md`.
- Docs, comments, and IPC names stay English.
