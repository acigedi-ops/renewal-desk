# Rhino Renewal Desk, standalone site

The same app as the claude.ai artifact, hosted on Cloudflare (free, commercial use allowed) with a Supabase database and login.

## How it fits together
- `src/app.html` is a copy of `/mnt/project-files/lni-renewals/app.html` (owned by the "L&I and bond renewal tracker" thread). It runs unchanged.
- `src/shim.js` provides `window.claude.use("db" | "assets" | "downloads")` on top of Supabase, and shows the sign-in screen.
- `build.mjs` wraps app.html in a full page and writes `dist/`. Cloudflare runs it on every push to main (build command `node build.mjs`, output directory `dist`). Response headers are in `public/_headers`.
- `public/config.js` holds the Supabase project URL and publishable key (public by design).
- `supabase/schema.sql` creates table `docs(collection, id, data jsonb)`, the `merge_doc` function, realtime, and the private `cois` bucket. Only signed-in users can read or write.

## Outbox (emails Eduard approves)
- `src/outbox.js` adds the Outbox tab and an "Emails" card on each client (Send bond to L&I, Welcome email). It is loaded by `build.mjs` after the app, because the L&I routine overwrites `src/app.html`.
- `worker/index.js` serves `dist/` and handles `POST /api/outbox/send {id}`: it checks the caller's Supabase session, reads `outbox/<id>` and its PDFs with that user's token, and sends through smtp.gmail.com:465 (`worker/mail.js`) as `GMAIL_USER`. Secret `GMAIL_APP_PASSWORD` (a Gmail app password) is set in Cloudflare, never in the repo.
- `tools/outbox.py` queues emails from routines; `tools/OUTBOX_ROUTINE_STEP.md` is the welcome-email step for the twice-daily routine.

## Data layout (same as the artifact db)
`clients/<license>` (plus `bond_files` from the Outbox), `outbox/<id>`, `meta/status`, `meta/agency`, `todo/<id>`, `sos/<UBI>`, `sosmeta/status`.
COI PDFs live in bucket `cois` at `<asset_id>/<file>`; `cois[].url` is `/coi/<asset_id>/<file>` and the shim swaps it for a signed URL.

## Updating the app
After app.html changes: copy it to `src/app.html`, commit, push. Cloudflare redeploys.

## Scripts and routines
`tools/rd.py` reads and writes the database from a cloud session. The Supabase secret key is the SUPABASE_SECRET_KEY
environment variable on the "lni" environment (rd.py strips a stray "SUPABASE_SECRET_KEY=" prefix and sends it only as the
`apikey` header), so nothing secret is in this repo or in arguments. Only sessions started on "lni" have it.

Routine changes at switch-over (artifact db -> Supabase):
- Twice-daily L&I routine: replace ArtifactData writes of `clients/<id>.lni`, `meta/status` and `todo/*` with
  `rd.update_doc("clients", id, {"lni": ...})`, `rd.set_doc("meta", "status", ...)`, `rd.set_docs([("todo", id, data), ...])`;
  read clients with `rd.list_docs("clients")`. The routine must fire into a session on the "lni" environment.
- Weekly SOS routine: same for `sos/<UBI>` (`rd.update_doc("sos", ubi, {"sos": ...})`) and `sosmeta/status`.
- New COIs from email: `rd.upload(pdf, f"{id}/{file}")` and store the returned `/coi/...` path as the COI url.

## One-time migration
`tools/migrate.py EXPORT_DIR COIS_DIR` (EXPORT_DIR from ArtifactData list with out_dir; COIS_DIR = artifact assets saved as `<asset_id>.pdf`).
