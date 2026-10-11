#!/usr/bin/env python3
"""Nightly backup of the Renewal Desk Supabase data (table `docs` + private bucket `cois`).

  python3 tools/backup.py OUT_ROOT [--keep 14]

Creates OUT_ROOT/<YYYY-MM-DD>/ (Pacific date) holding
  docs.jsonl.gz   every docs row as {"collection","id","data","updated_at"}, one per line
  cois/...        a mirror of the `cois` storage bucket
  manifest.json   {created_at, counts (per collection), docs, files, bytes}
A file whose path and size match the most recent earlier backup is hard-linked (or copied) from it
instead of downloaded. The folder is built as .<date>.partial and renamed only when complete; then
dated folders older than --keep days are deleted. Needs SUPABASE_SECRET_KEY (see rd.py); the key is
sent only as the `apikey` header and never printed or written.
"""
import argparse, datetime, gzip, json, os, pathlib, re, shutil, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rd  # noqa: E402

PT = ZoneInfo("America/Los_Angeles")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
BUCKET = "cois"


def dump_docs(path):
    counts, start = {}, 0
    with gzip.open(path, "wt", encoding="utf-8") as f:
        while True:
            rows = rd._req("GET", "/rest/v1/docs?select=collection,id,data,updated_at&order=collection,id",
                           headers={"Range": f"{start}-{start + 999}"})
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
                counts[r["collection"]] = counts.get(r["collection"], 0) + 1
            if len(rows) < 1000:
                return counts
            start += 1000


def list_dir(prefix):
    """One folder's (files, subfolders); folders come back with id null."""
    files, dirs, offset = [], [], 0
    while True:
        items = rd._req("POST", f"/storage/v1/object/list/{BUCKET}",
                        {"prefix": prefix, "limit": 1000, "offset": offset,
                         "sortBy": {"column": "name", "order": "asc"}})
        for it in items:
            p = f"{prefix}/{it['name']}" if prefix else it["name"]
            if it.get("id") is None:
                dirs.append(p)
            else:
                files.append((p, int((it.get("metadata") or {}).get("size") or -1)))
        if len(items) < 1000:
            return files, dirs
        offset += 1000


def list_objects(ex):
    """[(path, size)] for every object in the bucket, listing folders level by level in parallel."""
    out, level = [], [""]
    while level:
        nxt = []
        for files, dirs in ex.map(list_dir, level):
            out += files
            nxt += dirs
        level = nxt
    return sorted(out)


def download(path, dest, tries=3):
    url = rd.base_url() + f"/storage/v1/object/{BUCKET}/" + urllib.parse.quote(path)
    for n in range(tries):
        try:
            req = urllib.request.Request(url, headers={"apikey": rd.api_key()})
            with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
                shutil.copyfileobj(r, f)
            return
        except (urllib.error.URLError, OSError) as e:
            if n == tries - 1:
                code = getattr(e, "code", "")
                raise SystemExit(f"GET storage {BUCKET}/{path} -> {code or type(e).__name__}")
            time.sleep(2 * (n + 1))


def reuse(src, dest):
    try:
        os.link(src, dest)
    except OSError:
        shutil.copy2(src, dest)


def main(argv):
    ap = argparse.ArgumentParser(description="Back up Renewal Desk docs + cois bucket.")
    ap.add_argument("out_root")
    ap.add_argument("--keep", type=int, default=14, help="days of dated folders to keep (default 14)")
    a = ap.parse_args(argv)

    t0 = time.time()
    root = pathlib.Path(a.out_root)
    root.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now(PT)
    today = now.date().isoformat()
    final = root / today
    work = root / f".{today}.partial"
    if work.exists():
        shutil.rmtree(work)
    (work / BUCKET).mkdir(parents=True)

    prev = max((d for d in root.iterdir() if d.is_dir() and DATE_RE.match(d.name) and d.name < today),
               key=lambda d: d.name, default=None)
    # Re-running on the same day: reuse files from today's earlier backup too.
    sources = [d / BUCKET for d in (final, prev) if d is not None and (d / BUCKET).is_dir()]

    counts = dump_docs(work / "docs.jsonl.gz")

    stats = {"downloaded": 0, "reused": 0}

    def fetch(item):
        path, size = item
        dest = work / BUCKET / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        for s in sources:
            old = s / path
            if size >= 0 and old.is_file() and old.stat().st_size == size:
                reuse(old, dest)
                return "reused"
        download(path, dest)
        return "downloaded"

    with ThreadPoolExecutor(8) as ex:
        objs = list_objects(ex)
        for r in ex.map(fetch, objs):
            stats[r] += 1

    nbytes = sum(f.stat().st_size for f in work.rglob("*") if f.is_file())
    files = len(objs)
    manifest = {"created_at": now.isoformat(timespec="seconds"), "counts": counts,
                "docs": sum(counts.values()), "files": files, "bytes": nbytes}
    (work / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True))

    if final.exists():
        shutil.rmtree(final)
    work.rename(final)

    cutoff = (now.date() - datetime.timedelta(days=a.keep)).isoformat()
    pruned = 0
    for d in root.iterdir():
        if d.is_dir() and DATE_RE.match(d.name) and d.name < cutoff:
            shutil.rmtree(d)
            pruned += 1

    print(f"backup {final}: {manifest['docs']} docs in {len(counts)} collections, {files} files "
          f"({stats['downloaded']} downloaded, {stats['reused']} reused), {nbytes / 1e6:.1f} MB, "
          f"pruned {pruned}, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main(sys.argv[1:])
