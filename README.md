# Rhino Renewal Desk, standalone site

The same app as the claude.ai artifact, hosted on Cloudflare (free, commercial use allowed) with a Supabase database and login.

## How it fits together
- `src/app.html` is a copy of `/mnt/project-files/lni-renewals/app.html` (owned by the "L&I and bond renewal tracker" thread). It runs unchanged.
- `src/shim.js` provides `window.claude.use("db" | "assets" | "downloads")` on top of Supabase, and shows the sign-in screen.
- `build.mjs` wraps app.html in a full page and writes `dist/`. Cloudflare runs it on every push to main (build command `node build.mjs`, output directory `dist`). Response headers are in `public/_headers`.
- `public/config.js` holds the Supabase project URL and publishable key (public by design).
- `supabase/schema.sql` creates table `docs(collection, id, data jsonb)`, the `merge_doc` function, realtime, and the private `cois` bucket. Only signed-in users can read or write.

## Who can send (supabase/approval_guard.sql)
Run once in the Supabase SQL editor (safe to re-run). It makes the database itself enforce the no-send-without-approval rule:
- Only Eduard's account (user id `ee17d28b-…`) can read or write `docs` and the `cois` bucket, even if someone else signs up.
- A text can become `approved` only from the website (supabase-js) signed in as Eduard, and only for one phone number. Routines (secret key)
  and the Mac (curl) can't approve. A text goes to `sending` only from `approved`, and its body/phone can't change while approved or sending.
- Routines (secret key) can never set an email or text to `approved`, `sending`, `sent` or `unsure`: they only write drafts.
- An email's recipients, subject, body and attachments can't change while it is `sending`.
If the site's own user id ever changes (new account), update `rd_is_eduard()` there.

## Outbox (emails Eduard approves)
- `src/outbox.js` adds the Outbox tab and an "Emails" card on each client (Send bond to L&I, Welcome email). It is loaded by `build.mjs` after the app, because the L&I routine overwrites `src/app.html`.
- `worker/index.js` serves `dist/` and handles `POST /api/outbox/send {id}`: it checks the caller's Supabase session, reads `outbox/<id>` and its PDFs with that user's token, and sends through smtp.gmail.com:465 (`worker/mail.js`) as `GMAIL_USER`. Secret `GMAIL_APP_PASSWORD` (a Gmail app password) is set in Cloudflare, never in the repo.
- If the connection drops after Gmail has the whole email, the Worker marks it `unsure` instead of `failed`, so it can't be resent by one tap: the Outbox asks Eduard to check his Sent mail ("It went out" / "It didn't go out"). A `sending` older than 5 minutes is shown the same way.
- `.claude/settings.json` denies the Gmail connector's send, reply and forward tools to any Claude session working in this repo (routines included), so the only way an email leaves is the Approve & send tap.
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

## To do (src/tasks.js)
- A "To do" tab after the Outbox for things Eduard owes people. Shared list `tasks/<id>` with `source` text, call, email or callback, so every
  thread adds to the same place: `{source, who, phone, client_id, title, detail, category, urgent, at, status: "open"|"done", done_at, created_by}`.
  The L&I mismatch list stays in `todo` (the L&I routine resolves anything there it did not create).

## Qtax (quarterly-tax texts from Eduard's own number)
- `src/qtax.js` adds a "Qtax" mode next to Policies and SOS status (loaded by `build.mjs`, like the Outbox). Clients are `qtax/<id>`
  (`p` + last 10 phone digits) with one `q_2026Q3`-style field per quarter: status asked, received, filed or paid.
- Texts are `texts/<id>`. The page only writes drafts and, on Eduard's "Approve & send" tap, `status: "approved"`.
  Nothing else may set "approved": routines and the Mac only write drafts.
- `mac/texter.js` runs on Eduard's Mac inside "Renewal Desk Texter", a fixed app shell (`mac/loader.js`) that re-reads texter.js from
  `~/Library/Application Support/Renewal Desk Texter/` when it changes, so updates keep Full Disk Access (install or update:
  double-click `mac/Install Renewal Desk Texter.command`). It only ever texts one person: a single +1 number, in a one-on-one chat
  with exactly that person, never a group chat (checked in texter.js and again in the AppleScript that sends).
  Every minute it sends approved texts through Messages (same thread, same number as always; never 9 pm to 8 am; approvals older
  than 2 days go back to drafts), reads replies from `~/Library/Messages/chat.db` (needs Full Disk Access) to mark clients
  "Got income", drafts reminders after 3 days without an answer, finds past group texts (the Hit Em Up blast) for the client list,
  on request (`qtaxmeta/export {requested_at, days}`) saves recent conversations to `~/Desktop/Renewal Desk Texter/recent-texts.json`
  for Claude to read; at 9:00 and 18:00 uploads `textscan/<slot>` (chats whose last message is someone else's) that a routine turns into
  `tasks` with `tools/text_tasks.py` and then erases; and watches his texts for "I'll call you back in N min": if there is no call
  (Call History) or text to that person by then (+10 min), it shows a Mac notification and adds an urgent `callback` task,
  and writes a heartbeat to `qtaxmeta/mac`. It signs in once as Eduard; nothing secret is in the repo.

## Health, backups and the free L&I check
- `src/health.js` shows a one-line health strip under the tabs (L&I check, email check, SOS check, Mac texter, backup, stuck sends).
- Nightly routine (fresh session on the "lni" env): `tools/backup.py /mnt/project-files/backups` (all docs + the `cois` bucket, 14 days kept,
  writes `meta/backup`), `tools/lni_shadow.py` and `tools/health_check.py` (anything late becomes an urgent `tasks/health-<kind>-<date>`).
- `tools/lni_shadow.py` is the L&I check as a plain script. It only writes the comparison report `meta/lni_shadow` and never changes clients.
  `.github/workflows/lni-shadow.yml` runs it three times a day once the repository secret SUPABASE_SECRET_KEY is set.
  When it has matched the routine for a while, the routine's L&I steps can move to it.
