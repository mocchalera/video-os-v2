#!/usr/bin/env python3
"""Decode each compound clip sequence individually to build full timeline."""
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
bytype=defaultdict(list)
for pk,zt,zn,blob in rows:
    try: d=unarchive(blob)
    except: d={}
    bypk[pk]=(zt,zn,d)
    bytype[zt].append((pk,zn,d))

all_colls={}
for row in con.execute("SELECT Z_PK,ZTYPE,ZNAME FROM ZCOLLECTION").fetchall():
    all_colls[row[0]]=(row[1],row[2])

# Build seq lookup by mediaId AND by displayName
seq_by_mid = {}
seq_by_name = {}
for pk,zn,d in bytype.get("FFAnchoredSequence",[]):
    if isinstance(d,dict):
        mid = d.get("mediaIdentifier","")
        name = d.get("displayName","")
        if mid: seq_by_mid[mid] = pk
        if name: seq_by_name.setdefault(name, []).append(pk)

# Target compound clips and their sequence PKs
COMPOUNDS = {
    "オープニング": 25671,
    "栗": 25914,
    "感動接続": 26080,
    "ライトノイズ": 26168,
    "最終補正": 30118,
}

def walk_to_containedItems(pk, depth=0, max_d=8):
    """BFS to find containedItems under pk."""
    if depth > max_d: return []
    for ch in children.get(pk,[]):
        typ, name = all_colls.get(ch,("?","?"))
        if name == "containedItems" and typ == "NSArray":
            return children.get(ch,[])
        if name in ("primaryObject",):
            for ch2 in children.get(ch,[]):
                typ2 = all_colls.get(ch2,("?",))[0]
                if typ2 in ("FFAnchoredCollection","FFAnchoredSequence"):
                    r = walk_to_containedItems(ch2, depth+1, max_d)
                    if r: return r
    return []

def get_clips_from_seq(seq_pk, name="", seen=None):
    """Extract clips from a sequence, resolving nested compound clips."""
    if seen is None: seen = set()
    if seq_pk in seen: return []
    seen.add(seq_pk)

    items = walk_to_containedItems(seq_pk)
    clips = []

    for si in items:
        si_type = all_colls.get(si,("?",))[0]
        si_md = bypk.get(si)

        if si_type == "FFAnchoredTransition":
            if si_md and isinstance(si_md[2],dict):
                clips.append({"type":"transition", "name": si_md[2].get("displayName","?"),
                              "duration_s": round(rng(si_md[2].get("clippedRange"))[1],6) if rng(si_md[2].get("clippedRange")) else None})
            continue

        if not si_md or not isinstance(si_md[2],dict): continue
        dd = si_md[2]
        nm = dd.get("displayName","?")
        cr = rng(dd.get("clippedRange"))

        # Try to find video media component (- v1)
        found_media = False
        for ch1 in children.get(si,[]):
            ch1_type = all_colls.get(ch1,("?",))[0]
            if ch1_type == "NSArray":
                for ch2 in children.get(ch1,[]):
                    ch2_type = all_colls.get(ch2,("?",))[0]
                    ch2_md = bypk.get(ch2)
                    if ch2_type == "FFAnchoredMediaComponent" and ch2_md and isinstance(ch2_md[2],dict):
                        sub_nm = ch2_md[2].get("displayName","")
                        if "- v1" in sub_nm:
                            sub_cr = rng(ch2_md[2].get("clippedRange"))
                            clips.append({
                                "type":"clip",
                                "display_name": sub_nm.replace(" - v1",""),
                                "src_start_s": round(sub_cr[0],6) if sub_cr else None,
                                "duration_s": round(cr[1],6) if cr else None,
                                "media_full_dur_s": round(sub_cr[1],6) if sub_cr else None,
                            })
                            found_media = True
                            break
                if found_media: break

        if not found_media:
            # Try to resolve as compound clip reference via 'media' NSSet -> FFClipRef
            resolved = False
            for ch1 in children.get(si,[]):
                ch1_type, ch1_name = all_colls.get(ch1,("?","?"))
                if ch1_name == "media":
                    for ch2 in children.get(ch1,[]):
                        ch2_md = bypk.get(ch2)
                        if ch2_md and ch2_md[0] == "FFClipRef" and isinstance(ch2_md[2],dict):
                            ref_mid = ch2_md[2].get("mediaIdentifier","")
                            ref_name = ch2_md[2].get("displayName","")
                            if ref_mid in seq_by_mid:
                                sub_clips = get_clips_from_seq(seq_by_mid[ref_mid], ref_name, seen)
                                clips.extend(sub_clips)
                                resolved = True
                                break
                    if resolved: break
                # Also try via anchoredObject -> collection -> containedItems
                if ch1_name == "anchoredObject":
                    for ch2 in children.get(ch1,[]):
                        ch2_md = bypk.get(ch2)
                        if ch2_md and isinstance(ch2_md[2],dict):
                            sub_mid = ch2_md[2].get("mediaIdentifier","")
                            if sub_mid and sub_mid in seq_by_mid:
                                sub_clips = get_clips_from_seq(seq_by_mid[sub_mid], nm, seen)
                                clips.extend(sub_clips)
                                resolved = True
                                break
                    if resolved: break

            if not resolved:
                clips.append({
                    "type":"clip",
                    "display_name": nm,
                    "duration_s": round(cr[1],6) if cr else None,
                    "note": "unresolved",
                })

    return clips

# Decode each compound clip
full_timeline = []
for comp_name, seq_pk in COMPOUNDS.items():
    clips = get_clips_from_seq(seq_pk, comp_name)
    real = [c for c in clips if c["type"]=="clip"]
    dur = sum(c["duration_s"] for c in real if c.get("duration_s"))
    print(f"\n=== {comp_name} (PK={seq_pk}) ===")
    print(f"  クリップ: {len(real)}, 合計尺: {dur:.1f}s")
    for i,c in enumerate(clips):
        if c["type"]=="transition":
            print(f"    --- {c['name']:30s} {c.get('duration_s',0):.2f}s")
        else:
            note = f" [{c.get('note','')}]" if c.get("note") else ""
            print(f"    [{i:2d}] {c['display_name'][:55]:55s} {c.get('duration_s',0):.2f}s{note}")
    full_timeline.append({"compound": comp_name, "clips": clips})

# Save combined
all_clips = []
for section in full_timeline:
    for c in section["clips"]:
        if c["type"] == "clip":
            c["section"] = section["compound"]
            all_clips.append(c)

unique_names = set(c["display_name"] for c in all_clips if "unresolved" not in c.get("note",""))
total_dur = sum(c["duration_s"] for c in all_clips if c.get("duration_s"))

print(f"\n\n=== 全体サマリ ===")
print(f"セクション数: {len(COMPOUNDS)}")
print(f"総クリップ数: {len(all_clips)}")
print(f"ユニーク素材: {len(unique_names)}")
print(f"合計尺: {total_dur:.1f}s ({total_dur/60:.1f}min)")
print(f"エクスポート尺: 229.75s (3.8min)")

with open("/Users/mocchalera/Dev/video-os-v2-spec/reports/eval/ena-golden/_scratch/full_timeline.json","w") as f:
    json.dump({"sections": full_timeline, "all_clips": all_clips,
               "unique_sources": sorted(unique_names),
               "total_clip_count": len(all_clips),
               "total_duration_s": total_dur}, f, indent=2, ensure_ascii=False)
print("Saved to full_timeline.json")

con.close()
