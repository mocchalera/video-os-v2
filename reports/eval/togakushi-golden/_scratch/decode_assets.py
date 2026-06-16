#!/usr/bin/env python3
"""Dump FFAssetRef (imported media pool) from a given .fcpevent SQLite DB."""
import plistlib, sqlite3, sys, re
from collections import Counter

DB = sys.argv[1]

def unarchive(blob):
    root = plistlib.loads(blob); objs = root["$objects"]
    def r(o, seen):
        if isinstance(o, plistlib.UID):
            i=o.data
            return "<cyc>" if i in seen else r(objs[i], seen|{i})
        if isinstance(o, dict):
            if "$class" in o and "NS.keys" in o and "NS.objects" in o:
                return dict(zip([r(k,seen) for k in o["NS.keys"]],[r(v,seen) for v in o["NS.objects"]]))
            if "$class" in o and "NS.objects" in o: return [r(v,seen) for v in o["NS.objects"]]
            return {k:r(v,seen) for k,v in o.items() if k!="$class"}
        if isinstance(o,list): return [r(v,seen) for v in o]
        return o
    return r(root["$top"]["root"], set())

con=sqlite3.connect(DB)
rows=con.execute("SELECT c.ZTYPE, md.ZDICTIONARYDATA FROM ZCOLLECTIONMD md "
                 "JOIN ZCOLLECTION c ON md.ZCOLLECTION=c.Z_PK "
                 "WHERE c.ZTYPE='FFAssetRef' AND md.ZDICTIONARYDATA IS NOT NULL").fetchall()
names=[]
for zt,blob in rows:
    try:
        d=unarchive(blob)
        if isinstance(d,dict) and d.get("displayName"): names.append(str(d["displayName"]))
    except Exception: pass

# base name (strip - aN, (fcpN))
def base(n):
    n=re.sub(r"\s*-\s*a?\d+(-\d+)?$","",n); n=re.sub(r"\s*\(fcp\d+\)","",n); return n
bases=sorted(set(base(n) for n in names))
print(f"DB={DB}")
print(f"FFAssetRef rows={len(rows)}  displayNames={len(names)}  distinct-base={len(bases)}")
# group by prefix
pref=Counter()
for b in bases:
    if b.startswith("NINJAV"): pref["NINJAV"]+=1
    elif b.startswith("DJI"): pref["DJI"]+=1
    elif "AdobeStock" in b or "Stock" in b: pref["Stock/music"]+=1
    elif "timelapse" in b or b.startswith("D8"): pref["timelapse"]+=1
    else: pref["other"]+=1
print("prefix breakdown:", dict(pref))
# NINJAV take-number range
tnums=sorted(int(m.group(1)) for b in bases for m in [re.search(r"_T(\d+)",b)] if m)
if tnums:
    print(f"NINJAV take numbers: T{min(tnums):03d}..T{max(tnums):03d}  count={len(tnums)}")
print("\n-- distinct base names --")
for b in bases: print("  ", b)
con.close()
