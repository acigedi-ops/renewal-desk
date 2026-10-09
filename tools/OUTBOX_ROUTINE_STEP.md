# Routine step: queue welcome emails (and L&I bond emails) in the Outbox

Add this to the twice-daily L&I + email routine, after the Gmail scan. It only **queues** emails in the site's
Outbox (collection `outbox`). Nothing is sent from the routine: Eduard edits and taps "Approve & send" on the
site, and the Worker at `/api/outbox/send` sends it from kaplunlicensing@gmail.com.

---

**Step: Outbox (welcome emails for new clients)**

1. Search Gmail for policy or bond issuance emails since the last run (use `newer_than:2d`; the script below
   skips anything already queued). Look for new business only, not renewals:
   - Hiscox: from:contact@hiscox.com subject:"Here are your Hiscox policy documents"
   - ERGO NEXT: from:hello@nextinsurance.com subject:"Policy Documents"
   - Coterie: from:support@coterieinsurance.com subject:"policy is active"
   - Simply Business, Sierra/JPP, Palomar, Wholesure and other carriers: their "policy issued", "policy documents"
     or "bound" emails with PDFs attached
   - Bonds: BondExchange `from:service@bondexchange.com subject:"Bond Issuance"`, Surety Bonds Direct bond documents,
     and Propeller/Rhino new-bond issuance emails
   Skip anything with renew, renewal, quote, application, cancel or payment-failed in the subject.
2. Match each email's insured or principal to a client in `clients` (name, license, UBI, the same matching as the
   policy sweep). Leave unmatched ones out and list them in the run summary.
3. Queue a welcome only for a **new client**: one whose card was added in the last 30 days, or who has no other
   policy or bond from the agency that started more than 60 days before this one. Existing clients who renew or add
   coverage get nothing.
4. Save the email's PDFs: `get_message` with format RAW → save JSON → `python3 /mnt/project-files/lni-renewals/extract_pdf.py MSG.json OUTDIR`.
   Keep the policy declarations, certificate of insurance and bond. Drop invoices, receipts and applications.
5. Queue it (run on the lni environment, from the repo checkout or /mnt/project-files/renewal-desk-site):
   ```
   python3 tools/outbox.py welcome <CLIENT_ID> --pdf <file> [--pdf <file>] --to <client email> \
     --source "<Carrier> <what> email <YYYY-MM-DD>"
   ```
   `--to` is the insured's address from the carrier email (its To line), or leave it out to use the card's contact
   email. If there's none, still queue it: Eduard fills in the address on the site. If a welcome email for that
   client is still waiting, the script adds the new PDFs to it (insurance and bond often arrive separately). If one
   was already sent or dismissed, it does nothing.
6. L&I bond emails: BondExchange and Propeller/Rhino file bonds with L&I electronically, so never queue those.
   For a new bond from any other source that arrives by email (for example Surety Bonds Direct), also run
   `python3 tools/outbox.py bond <CLIENT_ID> --pdf <bond.pdf> --source "..."`.
   Bonds Eduard downloads from carrier portals are uploaded by him on the client card, which queues the L&I email itself.
7. In the run summary, add one line: how many emails were queued in the Outbox, and any unmatched issuance emails.
