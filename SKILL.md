# Rhumb Club Publisher fork

- Keep fork changes minimal and upstream-compatible; preserve the default `final` container target.
- The `lambda` image target is arm64 and must keep Lambda Web Adapter pinned by digest.
- `duckdbConnection.databasePath` is operator-owned: absolute existing files only, always sandboxed and read-only, never persistent or combined with attachments.
- Browser OAuth is optional runtime configuration in `/runtime-config.js`; tokens remain in memory and PKCE state exists only in `sessionStorage`.
