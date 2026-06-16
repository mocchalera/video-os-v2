#!/usr/bin/env python3
"""Decode FCP CoreData (.fcpevent SQLite) NSKeyedArchiver blobs to characterize the human edit."""
import plistlib, sqlite3, sys
from collections import Counter, defaultdict

DB = "/tmp/togakushi-probe/project/CurrentVersion.fcpevent"

def unarchive(blob):
    """Resolve an NSKeyedArchiver plist blob into plain Python objects."""
    root = plistlib.loads(blob)
    objs = root["$objects"]
    def resolve(o, seen):
        if isinstance(o, plistlib.UID):
            idx = o.data
            if idx in seen:
                return f"<cycle:{idx}>"
            return resolve(objs[idx], seen | {idx})
        if isinstance(o, dict):
            if "$class" in o and "NS.keys" in o and "NS.objects" in o:
                ks = [resolve(k, seen) for k in o["NS.keys"]]
                vs = [resolve(v, seen) for v in o["NS.objects"]]
                return dict(zip(ks, vs))
            if "$class" in o and "NS.objects" in o:  # NSArray/NSSet
                return [resolve(v, seen) for v in o["NS.objects"]]
            return {k: resolve(v, seen) for k, v in o.items() if k != "$class"}
        if isinstance(o, list):
            return [resolve(v, seen) for v in o]
        return o
    top = root["$top"]["root"]
    return resolve(top, set())

con = sqlite3.connect(DB)
rows = con.execute(
    "SELECT c.Z_PK, c.ZTYPE, c.ZNAME, md.ZDICTIONARYDATA "
    "FROM ZCOLLECTIONMD md JOIN ZCOLLECTION c ON md.ZCOLLECTION=c.Z_PK "
    "WHERE md.ZDICTIONARYDATA IS NOT NULL"
).fetchall()

by_type = defaultdict(list)
for pk, ztype, zname, blob in rows:
    try:
        d = unarchive(blob)
    except Exception as e:
        d = {"__decode_error__": str(e)}
    by_type[ztype].append((pk, zname, d))

print("=== ZTYPE別 メタデータ件数 ===")
for t, items in sorted(by_type.items(), key=lambda kv: -len(kv[1])):
    print(f"{t}: {len(items)}")

print("\n=== FFAssetRef = 人間が使用した素材(mediaIdentifier -> displayName) ===")
assets = {}
for pk, zname, d in by_type.get("FFAssetRef", []):
    if isinstance(d, dict):
        mid = d.get("mediaIdentifier")
        nm = d.get("displayName")
        assets[mid] = nm
        print(f"  {nm}   [{mid}]")
print(f"  -- 計 {len(assets)} 素材 --")

# 使用素材のベース名(synced/角度違いの (fcp1)(fcp2) や - a1-1 等を集約)
import re
bases = Counter()
for nm in assets.values():
    if not nm: continue
    base = re.sub(r"\s*-\s*a?\d+(-\d+)?$", "", str(nm))
    base = re.sub(r"\s*\(fcp\d+\)", "", base)
    bases[base] += 1
print("\n=== 使用素材のベース名(集約) ===")
for b, c in bases.most_common():
    print(f"  {b}  x{c}")

print("\n=== FFAnchoredMediaComponent(タイムライン上のクリップ)サンプル5件 ===")
comps = by_type.get("FFAnchoredMediaComponent", [])
for pk, zname, d in comps[:5]:
    if isinstance(d, dict):
        print(f"  displayName={d.get('displayName')!r} lane={d.get('anchoredLane')} "
              f"role={d.get('roleUID')!r} clippedRange={d.get('clippedRange')!r}")
print(f"  -- FFAnchoredMediaComponent 計 {len(comps)} --")
con.close()
