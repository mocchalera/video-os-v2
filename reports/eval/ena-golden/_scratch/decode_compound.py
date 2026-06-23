#!/usr/bin/env python3
"""Decode all compound clips in ena event DB to build complete timeline."""
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

# Load all metadata
rows=con.execute("SELECT c.Z_PK,c.ZTYPE,c.ZNAME,md.ZDICTIONARYDATA FROM ZCOLLECTIONMD md "
                 "JOIN ZCOLLECTION c ON md.ZCOLLECTION=c.Z_PK WHERE md.ZDICTIONARYDATA IS NOT NULL").fetchall()
children=defaultdict(list)
for p,ch in con.execute("SELECT Z_3PARENTCOLLECTIONS, Z_3CHILDCOLLECTIONS FROM Z_3CHILDCOLLECTIONS ORDER BY rowid").fetchall():
    children[p].append(ch)

bypk={}
bytype=defaultdict(list)
for pk,zt,zn,blob in rows:
    try: d=unarchive(blob)
    except: d={}
    bypk[pk]=(zt,zn,d)
    bytype[zt].append((pk,zn,d))

all_colls={}
for row in con.execute("SELECT Z_PK,ZTYPE,ZNAME FROM ZCOLLECTION").fetchall():
    all_colls[row[0]]=(row[1],row[2])

# Build mediaId -> PK index for sequences
seq_by_mid = {}
for pk,zn,d in bytype.get("FFAnchoredSequence",[]):
    if isinstance(d,dict):
        mid = d.get("mediaIdentifier","")
        if mid:
            seq_by_mid[mid] = pk

def find_containedItems(root_pk, max_depth=5):
    """Walk from root to find containedItems NSArray, return child PKs."""
    if max_depth <= 0: return []
    for ch1 in children.get(root_pk,[]):
        ch1_type, ch1_name = all_colls.get(ch1,("?","?"))
        if ch1_name == "containedItems" and ch1_type == "NSArray":
            return children.get(ch1,[])
        if ch1_name in ("primaryObject","anchoredObject","anchoredItems"):
            for ch2 in children.get(ch1,[]):
                ch2_type = all_colls.get(ch2,("?",))[0]
                if ch2_type in ("FFAnchoredCollection","FFAnchoredSequence"):
                    result = find_containedItems(ch2, max_depth-1)
                    if result: return result
    return []

def extract_clips(seq_pk, depth=0, seen=None):
    """Recursively extract clips from a sequence, expanding compound clips."""
    if seen is None: seen = set()
    if seq_pk in seen: return []
    seen.add(seq_pk)

    items = find_containedItems(seq_pk)
    clips = []
    for i,si in enumerate(items):
        si_type = all_colls.get(si,("?",))[0]
        si_md = bypk.get(si)
        if si_type == "FFAnchoredTransition":
            if si_md and isinstance(si_md[2],dict):
                dd = si_md[2]
                clips.append({
                    "type": "transition",
                    "name": dd.get("displayName","?"),
                    "duration_s": round(rng(dd.get("clippedRange"))[1],6) if rng(dd.get("clippedRange")) else None,
                })
            continue

        if not si_md or not isinstance(si_md[2],dict):
            continue

        dd = si_md[2]
        nm = dd.get("displayName","?")
        cr = rng(dd.get("clippedRange"))

        # Check if this clip references a compound clip (has assetRef that matches a sequence)
        # Look for children that are FFAnchoredMediaComponent or another compound
        has_media = False
        media_name = None
        media_cr = None

        for child_pk in children.get(si,[]):
            child_type = all_colls.get(child_pk,("?",))[0]
            if child_type == "NSArray":
                for sub_pk in children.get(child_pk,[]):
                    sub_type = all_colls.get(sub_pk,("?",))[0]
                    sub_md = bypk.get(sub_pk)
                    if sub_md and isinstance(sub_md[2],dict) and sub_type == "FFAnchoredMediaComponent":
                        sub_dd = sub_md[2]
                        sub_nm = sub_dd.get("displayName","")
                        if "- v1" in sub_nm:
                            has_media = True
                            media_name = sub_nm.replace(" - v1","")
                            media_cr = rng(sub_dd.get("clippedRange"))

        if has_media:
            clips.append({
                "type": "clip",
                "compound": nm if depth > 0 else None,
                "display_name": media_name or nm,
                "src_start_s": round(media_cr[0],6) if media_cr else (round(cr[0],6) if cr else None),
                "duration_s": round(cr[1],6) if cr else None,
                "depth": depth,
            })
        else:
            # Might be a compound clip reference - try to find it
            # Check if nm matches a known sequence
            found_compound = False
            for child_pk in children.get(si,[]):
                child_type = all_colls.get(child_pk,("?",))[0]
                if child_type in ("NSSet",) and all_colls.get(child_pk,("?","?"))[1] == "anchoredObject":
                    for sub_pk in children.get(child_pk,[]):
                        sub_md = bypk.get(sub_pk)
                        if sub_md and isinstance(sub_md[2],dict):
                            sub_mid = sub_md[2].get("mediaIdentifier","")
                            if sub_mid and sub_mid in seq_by_mid:
                                sub_seq_pk = seq_by_mid[sub_mid]
                                sub_clips = extract_clips(sub_seq_pk, depth+1, seen)
                                clips.extend(sub_clips)
                                found_compound = True
                                break

            if not found_compound:
                clips.append({
                    "type": "clip",
                    "compound": nm if depth > 0 else None,
                    "display_name": nm,
                    "src_start_s": round(cr[0],6) if cr else None,
                    "duration_s": round(cr[1],6) if cr else None,
                    "depth": depth,
                    "note": "unresolved",
                })

    return clips

# Target: "テレビ用" sequence
TARGET_MID = "2Bt+k5//TLCPQdUlZTh2sQ"
tv_seq_pk = seq_by_mid.get(TARGET_MID)
print(f"テレビ用 sequence PK={tv_seq_pk}")

if tv_seq_pk:
    all_clips = extract_clips(tv_seq_pk)
    real_clips = [c for c in all_clips if c["type"]=="clip"]
    transitions = [c for c in all_clips if c["type"]=="transition"]

    print(f"\n=== フルタイムライン ===")
    print(f"クリップ数: {len(real_clips)}")
    print(f"トランジション数: {len(transitions)}")
    total = sum(c["duration_s"] for c in real_clips if c["duration_s"])
    print(f"合計尺: {total:.1f}s ({total/60:.1f}min)")

    print(f"\n--- クリップ一覧 ---")
    for i,c in enumerate(all_clips):
        if c["type"]=="transition":
            print(f"  --- {c['name']:30s} {c['duration_s']:.2f}s")
        else:
            indent = "  " * c.get("depth",0)
            note = f" [{c.get('note','')}]" if c.get('note') else ""
            compound = f" (in:{c['compound']})" if c.get('compound') else ""
            print(f"  {indent}[{i:2d}] {c['display_name'][:50]:50s} {c['duration_s']:.2f}s{compound}{note}")

    # Save
    out = {"clips": all_clips, "real_clip_count": len(real_clips), "total_duration_s": total}
    with open("/Users/mocchalera/Dev/video-os-v2-spec/reports/eval/ena-golden/_scratch/full_timeline.json","w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to full_timeline.json")
else:
    print("テレビ用 sequence not found!")

# Also check: unique source clips
unique = set(c["display_name"] for c in all_clips if c["type"]=="clip")
print(f"\nユニーク素材: {len(unique)}")

con.close()
