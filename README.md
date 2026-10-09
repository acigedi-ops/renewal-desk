# Rhino Renewal Desk, standalone site

The same app as the claude.ai artifact, hosted on Vercel with a Supabase database and login.

## How it fits together
- `src/app.html` is a copy of `/mnt/project-files/lni-renewals/app.html` (owned by the "L&I and bond renewal tracker" thread). It runs unchanged.
- `src/shim.js` provides `window.claude.use("db" | "assets" | "downloads")` on top of Supabase, and shows the sign-in screen.
- `build.mjs` wraps app.html in a full page and writes `dist/` (Vercel runs it on every push).
- `public/config.js` holds the Supabase project URL and publishable key (public by design).
- `supabase/schema.sql` creates table `docs(collection, id, data jsonb)`, the `merge_doc` function, realtime, and the private `cois` bucket. Only signed-in users can read or write.

## Data layout (same as the artifact db)
`clients/<license>`, `meta/status`, `meta/agency`, `todo/<id>`, `sos/<UBI>`, `sosmeta/status`.
COI PDFs live in bucket `cois` at `<asset_id>/<file>`; `cois[].url` is `/coi/<asset_id>/<file>` and the shim swaps it for a signed URL.

## Updating the app
After app.html changes: copy it to `src/app.html`, commit, push. Vercel redeploys.

## Scripts and routines
`tools/rd.py` reads and writes the database from a cloud session. The Supabase secret key is a network secret on the
"lni" environment (header `apikey` for the project host), so nothing secret is in this repo or in arguments.

Routine changes at switch-over (artifact db -> Supabase):
- Twice-daily L&I routine: replace ArtifactData writes of `clients/<id>.lni`, `meta/status` and `todo/*` with
  `rd.update_doc("clients", id, {"lni": ...})`, `rd.set_doc("meta", "status", ...)`, `rd.set_docs([("todo", id, data), ...])`;
  read clients with `rd.list_docs("clients")`. The routine must fire into a session on the "lni" environment.
- Weekly SOS routine: same for `sos/<UBI>` (`rd.update_doc("sos", ubi, {"sos": ...})`) and `sosmeta/status`.
- New COIs from email: `rd.upload(pdf, f"{id}/{file}")` and store the returned `/coi/...` path as the COI url.

## One-time migration
`tools/migrate.py EXPORT_DIR COIS_DIR` (EXPORT_DIR from ArtifactData list with out_dir; COIS_DIR = artifact assets saved as `<asset_id>.pdf`).
