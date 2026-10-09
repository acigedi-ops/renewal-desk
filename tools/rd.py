#!/usr/bin/env python3
"""Read and write the Renewal Desk database (Supabase) from scripts and routines.

The Supabase secret key is never in this file or its arguments: the cloud environment's network
secret adds the `apikey` header to every request to the project host.

  rd.py list COLLECTION [--out DIR]       print docs as JSON lines, or save DIR/<collection>/<id>.json
  rd.py get COLLECTION ID
  rd.py set COLLECTION ID FILE.json       replace a document
  rd.py update COLLECTION ID FILE.json    merge top-level fields into a document
  rd.py delete COLLECTION ID
  rd.py import DIR                        upsert every DIR/<collection>/<id>.json
  rd.py upload LOCAL_FILE BUCKET_PATH     put a PDF in the private `cois` bucket; prints /coi/<path>

Python modules can `from rd import set_doc, update_doc, list_docs` the same way.
"""
import json, os, pathlib, re, sys, urllib.parse, urllib.request

HERE = pathlib.Path(__file__).resolve().parent


def base_url():
    url = os.environ.get("RD_SUPABASE_URL")
    if not url:
        cfg = (HERE.parent / "public" / "config.js").read_text()
        url = re.search(r'url:\s*"([^"]+)"', cfg).group(1)
    return url.rstrip("/")


def _req(method, path, body=None, headers=None, raw=None):
    h = {"Content-Type": "application/json", **(headers or {})}
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(base_url() + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            txt = r.read().decode()
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} -> {e.code} {e.read().decode()[:500]}")
    return json.loads(txt) if txt.strip() else None


def _q(v):
    return urllib.parse.quote(str(v), safe="")


def list_docs(col):
    out, start = [], 0
    while True:
        rows = _req("GET", f"/rest/v1/docs?select=id,data&collection=eq.{_q(col)}&order=id",
                    headers={"Range": f"{start}-{start + 999}"})
        out += rows
        if len(rows) < 1000:
            return out
        start += 1000


def get_doc(col, id_):
    rows = _req("GET", f"/rest/v1/docs?select=data&collection=eq.{_q(col)}&id=eq.{_q(id_)}")
    return rows[0]["data"] if rows else None


def set_docs(rows):
    """rows: [(collection, id, data)], upserted 200 at a time."""
    for i in range(0, len(rows), 200):
        chunk = [{"collection": c, "id": d, "data": x} for c, d, x in rows[i:i + 200]]
        _req("POST", "/rest/v1/docs?on_conflict=collection,id", chunk,
             headers={"Prefer": "resolution=merge-duplicates,return=minimal"})


def set_doc(col, id_, data):
    set_docs([(col, id_, data)])


def update_doc(col, id_, patch):
    return _req("POST", "/rest/v1/rpc/merge_doc", {"p_collection": col, "p_id": id_, "p_patch": patch})


def delete_doc(col, id_):
    _req("DELETE", f"/rest/v1/docs?collection=eq.{_q(col)}&id=eq.{_q(id_)}")


def upload(local, bucket_path, content_type="application/pdf"):
    _req("POST", f"/storage/v1/object/cois/{urllib.parse.quote(bucket_path)}",
         raw=pathlib.Path(local).read_bytes(), headers={"Content-Type": content_type, "x-upsert": "true"})
    return "/coi/" + bucket_path


def main(a):
    cmd = a[0] if a else ""
    if cmd == "list":
        rows = list_docs(a[1])
        if "--out" in a:
            d = pathlib.Path(a[a.index("--out") + 1]) / a[1]
            d.mkdir(parents=True, exist_ok=True)
            for r in rows:
                (d / f"{r['id']}.json").write_text(json.dumps(r["data"], indent=1))
            print(f"saved {len(rows)} docs to {d}")
        else:
            for r in rows:
                print(json.dumps(r))
    elif cmd == "get":
        print(json.dumps(get_doc(a[1], a[2]), indent=1))
    elif cmd == "set":
        set_doc(a[1], a[2], json.loads(pathlib.Path(a[3]).read_text()))
    elif cmd == "update":
        update_doc(a[1], a[2], json.loads(pathlib.Path(a[3]).read_text()))
    elif cmd == "delete":
        delete_doc(a[1], a[2])
    elif cmd == "import":
        rows = []
        for f in sorted(pathlib.Path(a[1]).glob("*/*.json")):
            rows.append((f.parent.name, f.stem, json.loads(f.read_text())))
        set_docs(rows)
        print(f"imported {len(rows)} docs")
    elif cmd == "upload":
        print(upload(a[1], a[2]))
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
