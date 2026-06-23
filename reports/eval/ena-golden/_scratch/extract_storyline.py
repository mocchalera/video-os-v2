#!/usr/bin/env python3
"""Extract the full video timeline from 最終補正's connected storyline (lane=2)."""
import plistlib, sqlite3, re, json
from collections import defaultdict

EVENT_DB = "/Users/mocchalera/Dev/video-os-v2-spec/reports/eval/ena-golden/_scratch/event.sqlite"

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

def rng(s):
    if not isinstance(s,str): return None
    m=re.findall(r"\(([-\d]+)/([-\d]+)\)", s)
    if len(m)!=2: return None
    return (int(m[0][0])/int(m[0][1]), int(m[1][0])/int(m[1][1]))

con=sqlite3.connect(EVENT_DB)
rows=con.execute("SELECT c.Z_PK,c.ZTYPE,c.ZNAME,md.ZDICTIONARYDATA FROM ZCOLLECTIONMD md "
                 "JOIN ZCOLLECTION c ON md.ZCOLLECTION=c.Z_PK WHERE md.ZDICTIONARYDATA IS NOT NULL").fetchall()
children=defaultdict(list)
for p,ch in con.execute("SELECT Z_3PARENTCOLLECTIONS, Z_3CHILDCOLLECTIONS FROM Z_3CHILDCOLLECTIONS ORDER BY rowid").fetchall():
    children[p].append(ch)

bypk={}
for pk,zt,zn,blob in rows:
    try: d=unarchive(blob)
    except: d={}
    bypk[pk]=(zt,zn,d)

all_colls={}
for row in con.execute("SELECT Z_PK,ZTYPE,ZNAME FROM ZCOLLECTION").fetchall():
    all_colls[row[0]]=(row[1],row[2])

# The storyline is at PK=26673 (lane=2, under ギャップ's anchoredItems in 最終補正)
# Its containedItems (PK=29263) has the full clip list
STORYLINE_PK = 26673

# Find containedItems
contained_pk = None
for ch in children.get(STORYLINE_PK,[]):
    if all_colls.get(ch,("?","?"))[1] == "containedItems":
        contained_pk = ch
        break

if not contained_pk:
    print("containedItems not found!")
    exit(1)

spine_items = children.get(contained_pk,[])
print(f"Storyline items: {len(spine_items)}")

timeline = []
for i, si in enumerate(spine_items):
    si_type = all_colls.get(si,("?",))[0]
    si_md = bypk.get(si)
    if not si_md or not isinstance(si_md[2],dict):
        continue
    dd = si_md[2]
    nm = dd.get("displayName","?")
    cr = rng(dd.get("clippedRange"))

    entry = {
        "position": i,
        "display_name": nm,
        "duration_s": round(cr[1],6) if cr else None,
        "src_start_s": round(cr[0],6) if cr else None,
    }

    if si_type == "FFAnchoredTransition":
        entry["type"] = "transition"
    elif si_type in ("FFAnchoredGapGeneratorComponent",):
        entry["type"] = "gap"
    elif si_type in ("FFAnchoredGeneratorComponent",):
        entry["type"] = "generator"
    elif si_type == "FFAnchoredClip":
        entry["type"] = "compound_clip"
    else:
        entry["type"] = "clip"

    timeline.append(entry)

# Summary
clips = [t for t in timeline if t["type"]=="clip"]
transitions = [t for t in timeline if t["type"]=="transition"]
gaps = [t for t in timeline if t["type"]=="gap"]
generators = [t for t in timeline if t["type"]=="generator"]
compounds = [t for t in timeline if t["type"]=="compound_clip"]

total_clip_dur = sum(c["duration_s"] for c in clips if c["duration_s"])
total_gap_dur = sum(c["duration_s"] for c in gaps if c["duration_s"])

print(f"\n=== タイムライン構成 ===")
print(f"映像クリップ: {len(clips)} (合計 {total_clip_dur:.1f}s)")
print(f"トランジション: {len(transitions)}")
print(f"ギャップ: {len(gaps)} (合計 {total_gap_dur:.1f}s)")
print(f"ジェネレータ: {len(generators)}")
print(f"Compound clip: {len(compounds)}")

unique_sources = set()
for c in clips:
    # Normalize: remove camera prefix for matching
    unique_sources.add(c["display_name"])
print(f"ユニーク素材名: {len(unique_sources)}")

print(f"\n=== タイムライン順 ===")
for t in timeline:
    dur = f"{t['duration_s']:.2f}s" if t["duration_s"] else "?"
    if t["type"] == "clip":
        print(f"  [{t['position']:3d}] CLIP  {t['display_name'][:60]:60s} {dur}")
    elif t["type"] == "transition":
        print(f"  [{t['position']:3d}] TRANS {t['display_name'][:60]:60s} {dur}")
    elif t["type"] == "gap":
        print(f"  [{t['position']:3d}] GAP   {t['display_name'][:60]:60s} {dur}")
    elif t["type"] == "generator":
        print(f"  [{t['position']:3d}] GEN   {t['display_name'][:60]:60s} {dur}")
    elif t["type"] == "compound_clip":
        print(f"  [{t['position']:3d}] COMP  {t['display_name'][:60]:60s} {dur}")

# Save
output = {
    "project": "恵那プロモーション",
    "sequence": "最終補正 / ストーリーライン (lane=2)",
    "export_duration_s": 229.75,
    "clip_count": len(clips),
    "unique_source_count": len(unique_sources),
    "total_clip_duration_s": round(total_clip_dur, 2),
    "timeline": timeline,
    "unique_sources": sorted(unique_sources),
}
out_path = "/Users/mocchalera/Dev/video-os-v2-spec/reports/eval/ena-golden/_scratch/full_timeline.json"
with open(out_path, "w") as f:
    json.dump(output, f, indent=2, ensure_ascii=False)
print(f"\nSaved to {out_path}")

con.close()
