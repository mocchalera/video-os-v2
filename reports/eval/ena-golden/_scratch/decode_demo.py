#!/usr/bin/env python3
"""Extract timeline clips from 恵那映像デモ (the actual edit timeline)."""
import plistlib, sqlite3, re, json
from collections import defaultdict

DB = "/Users/mocchalera/Dev/video-os-v2-spec/reports/eval/ena-golden/_scratch/demo.sqlite"

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
    """Parse CMTimeRange string like '{(start_n/start_d),(dur_n/dur_d)}' -> (start_sec, dur_sec)"""
    if not isinstance(s,str): return None
    m=re.findall(r"\(([-\d]+)/([-\d]+)\)", s)
    if len(m)!=2: return None
    return (int(m[0][0])/int(m[0][1]), int(m[1][0])/int(m[1][1]))

con=sqlite3.connect(DB)

# Load all collections with metadata
rows=con.execute("SELECT c.Z_PK,c.ZTYPE,c.ZNAME,md.ZDICTIONARYDATA FROM ZCOLLECTIONMD md "
                 "JOIN ZCOLLECTION c ON md.ZCOLLECTION=c.Z_PK WHERE md.ZDICTIONARYDATA IS NOT NULL").fetchall()

# Parent-child tree
children=defaultdict(list)
parent_of={}
for p,ch in con.execute("SELECT Z_3PARENTCOLLECTIONS, Z_3CHILDCOLLECTIONS FROM Z_3CHILDCOLLECTIONS ORDER BY rowid").fetchall():
    children[p].append(ch)
    parent_of[ch]=p

bytype=defaultdict(list)
bypk={}
for pk,zt,zn,blob in rows:
    try: d=unarchive(blob)
    except: d={}
    bytype[zt].append((pk,zn,d))
    bypk[pk]=(zt,zn,d)

all_colls={}
for row in con.execute("SELECT Z_PK,ZTYPE,ZNAME FROM ZCOLLECTION").fetchall():
    all_colls[row[0]]=(row[1],row[2])

# Summary
type_counts = defaultdict(int)
for pk,(zt,zn) in all_colls.items():
    if zt: type_counts[zt] += 1
print("=== タイプ別集計 ===")
for t,c in sorted(type_counts.items(), key=lambda x:-x[1]):
    print(f"  {t}: {c}")

# Find spine
print("\n=== FFAnchoredSequence ===")
for pk,zn,d in bytype.get("FFAnchoredSequence",[]):
    print(f"  PK={pk} name={d.get('displayName','?')!r}")

# Navigate: spine -> primaryObject -> FFAnchoredCollection -> containedItems -> clips
print("\n=== スパイン → containedItems ===")
for pk,zn,d in bytype.get("FFAnchoredSequence",[]):
    # Get children of spine
    for ch1 in children.get(pk,[]):
        ch1_type, ch1_name = all_colls.get(ch1,("?","?"))
        if ch1_name == "primaryObject":
            for ch2 in children.get(ch1,[]):
                ch2_type = all_colls.get(ch2,("?",))[0]
                if ch2_type == "FFAnchoredCollection":
                    # Find containedItems under this
                    for ch3 in children.get(ch2,[]):
                        ch3_name = all_colls.get(ch3,("?","?"))[1]
                        if ch3_name == "containedItems":
                            spine_items = children.get(ch3,[])
                            print(f"  containedItems PK={ch3} -> {len(spine_items)} items")

                            timeline_clips = []
                            for i,si in enumerate(spine_items):
                                si_type = all_colls.get(si,("?",))[0]
                                si_md = bypk.get(si)
                                if si_md and isinstance(si_md[2],dict):
                                    dd = si_md[2]
                                    nm = dd.get("displayName","?")
                                    cr = rng(dd.get("clippedRange"))
                                    start_s = cr[0] if cr else None
                                    dur_s = cr[1] if cr else None
                                    lane = dd.get("anchoredLane", 0)
                                    asset_ref = dd.get("anchoredAssetRef", "")
                                else:
                                    nm = "?"; start_s = None; dur_s = None; lane = "?"; asset_ref = ""

                                entry = {
                                    "idx": i,
                                    "pk": si,
                                    "type": si_type,
                                    "name": nm,
                                    "src_start": round(start_s,4) if start_s is not None else None,
                                    "duration": round(dur_s,4) if dur_s is not None else None,
                                    "lane": lane,
                                }
                                timeline_clips.append(entry)

                                tag = "CLIP" if si_type in ("FFAnchoredMediaComponent",) else si_type.replace("FF","").replace("Anchored","")
                                dur_str = f"{dur_s:.2f}s" if dur_s else "?"
                                print(f"    [{i:2d}] {tag:12s} PK={si:5d} name={nm!r:50s} dur={dur_str:8s} lane={lane}")

# Also check FFAnchoredMediaComponent directly for asset references
print(f"\n=== FFAnchoredMediaComponent 全量 ({len(bytype.get('FFAnchoredMediaComponent',[]))}) ===")
clips_with_asset = []
for pk,zn,d in bytype.get("FFAnchoredMediaComponent",[]):
    if isinstance(d,dict):
        nm = d.get("displayName","?")
        cr = rng(d.get("clippedRange"))
        dur = cr[1] if cr else None
        start = cr[0] if cr else None
        lane = d.get("anchoredLane", 0)
        clips_with_asset.append({
            "pk": pk,
            "name": nm,
            "src_start": round(start,4) if start else None,
            "duration": round(dur,4) if dur else None,
            "lane": lane,
        })
        if len(clips_with_asset) <= 60:
            print(f"  PK={pk:5d} name={nm!r:50s} dur={dur:.2f}s lane={lane}" if dur else f"  PK={pk:5d} name={nm!r:50s}")

print(f"\n=== 合計クリップ数: {len(clips_with_asset)} ===")
main_lane = [c for c in clips_with_asset if c["lane"] == 0]
print(f"  メインレーン(lane=0): {len(main_lane)}")
if main_lane:
    total_dur = sum(c["duration"] for c in main_lane if c["duration"])
    print(f"  合計尺: {total_dur:.1f}s ({total_dur/60:.1f}min)")

# Count unique source clips
unique_names = set(c["name"] for c in clips_with_asset)
print(f"  ユニーク素材名: {len(unique_names)}")

con.close()
