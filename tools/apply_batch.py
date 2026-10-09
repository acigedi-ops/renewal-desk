#!/usr/bin/env python3
"""Apply writes to the Renewal Desk database (Supabase), for the routines.

  apply_batch.py BATCH.json [BATCH.json ...]
      ArtifactData-style batch files, as lni_todo.py writes them: a JSON list of
      {op: set|update|delete, collection, doc_id, data | file_path[, if_version]}.
      if_version is ignored (Supabase has no document versions).
  apply_batch.py --update-dir COLLECTION DIR
      Merge every DIR/<id>.json into COLLECTION/<id> (files starting with "_" are skipped),
      e.g. sos_check.py's out/ directory.
"""
import json, pathlib, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rd


def load(w):
    return w["data"] if "data" in w else json.loads(pathlib.Path(w["file_path"]).read_text())


def apply(writes):
    sets = [(w["collection"], w["doc_id"], load(w)) for w in writes if w["op"] == "set"]
    rd.set_docs(sets)
    n = len(sets)
    for w in writes:
        if w["op"] == "update":
            rd.update_doc(w["collection"], w["doc_id"], load(w)); n += 1
        elif w["op"] == "delete":
            rd.delete_doc(w["collection"], w["doc_id"]); n += 1
    return n


def main(a):
    if a[:1] == ["--update-dir"]:
        col, d = a[1], pathlib.Path(a[2])
        files = [f for f in sorted(d.glob("*.json")) if not f.name.startswith("_")]
        for f in files:
            rd.update_doc(col, f.stem, json.loads(f.read_text()))
        print(f"updated {len(files)} {col} docs")
        return
    total = 0
    for p in a:
        total += apply(json.loads(pathlib.Path(p).read_text()))
    print(f"applied {total} writes")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    main(sys.argv[1:])
