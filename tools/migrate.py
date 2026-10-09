#!/usr/bin/env python3
"""One-time move from the claude.ai artifact database to Supabase.

  migrate.py EXPORT_DIR COIS_DIR [--dry-run]

EXPORT_DIR holds <collection>/<id>.json files (ArtifactData list with out_dir).
COIS_DIR holds the COI PDFs saved from the artifact's asset store as <asset_id>.pdf.
Each PDF goes to the private `cois` bucket at <asset_id>/<file name>, and the client's
cois[].url is rewritten from /_blob/<asset_id> to /coi/<asset_id>/<file name>.
Safe to run again: uploads and document writes both overwrite.
"""
import json, pathlib, re, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rd


def safe(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name or "file.pdf")


def main(export, cois, dry=False):
    export, cois = pathlib.Path(export), pathlib.Path(cois)
    rows, uploaded, missing = [], {}, []
    for f in sorted(export.glob("*/*.json")):
        col, doc_id, data = f.parent.name, f.stem, json.loads(f.read_text())
        if col == "clients":
            for c in data.get("cois") or []:
                aid = c.get("asset_id")
                if not aid or not str(c.get("url", "")).startswith("/_blob/"):
                    continue
                pdf = cois / f"{aid}.pdf"
                if not pdf.exists():
                    missing.append((doc_id, aid))
                    continue
                path = f"{aid}/{safe(c.get('file'))}"
                if aid not in uploaded:
                    uploaded[aid] = path if dry else rd.upload(pdf, path)[len("/coi/"):]
                c["url"] = "/coi/" + uploaded[aid]
        rows.append((col, doc_id, data))
    counts = {}
    for col, _, _ in rows:
        counts[col] = counts.get(col, 0) + 1
    print("docs:", counts, "| PDFs uploaded:", len(uploaded), "| PDFs missing:", len(missing))
    for m in missing:
        print("  missing", *m)
    if not dry:
        rd.set_docs(rows)
        print("imported", len(rows), "docs")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], "--dry-run" in sys.argv)
