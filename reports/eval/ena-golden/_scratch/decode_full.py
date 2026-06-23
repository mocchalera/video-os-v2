#!/usr/bin/env python3
"""Full decode of ena event DB - walk all compound clips to extract complete timeline."""
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

def load_db(path):
    con=sqlite3.connect(path)
    rows=con.execute("SELECT c.Z_PK,c.ZTYPE,c.ZNAME,md.ZDICTIONARYDATA FROM ZCOLLECTIONMD md "
                     "JOIN ZCOLLECTION c ON md.ZCOLLECTION=c.Z_PK WHERE md.ZDICTIONARYDATA IS NOT NULL").fetchall()
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
    con.close()
    return bytype, bypk, children, parent_of, all_colls

bytype, bypk, children, parent_of, all_colls = load_db(EVENT_DB)

# List all sequences
print("=== 全シーケンス (FFAnchoredSequence) ===")
for pk,zn,d in bytype.get("FFAnchoredSequence",[]):
    name = d.get("displayName","?") if isinstance(d,dict) else "?"
    mid = d.get("mediaIdentifier","?") if isinstance(d,dict) else "?"
    print(f"  PK={pk} name={name!r} mediaId={mid!r}")

def find_containedItems(root_pk):
    """Walk from a root collection to find containedItems NSArray."""
    # Direct children
    for ch1 in children.get(root_pk,[]):
        ch1_type, ch1_name = all_colls.get(ch1,("?","?"))
        if ch1_name == "containedItems" and ch1_type == "NSArray":
            return children.get(ch1,[])
        if ch1_name == "primaryObject":
            for ch2 in children.get(ch1,[]):
                ch2_type = all_colls.get(ch2,("?",))[0]
                if ch2_type in ("FFAnchoredCollection","FFAnchoredSequence"):
                    for ch3 in children.get(ch2,[]):
                        ch3_name = all_colls.get(ch3,("?","?"))[1]
                        if ch3_name == "containedItems":
                            return children.get(ch3,[])
    # Try through children of children
    for ch1 in children.get(root_pk,[]):
        ch1_type, ch1_name = all_colls.get(ch1,("?","?"))
        if ch1_type in ("FFAnchoredCollection",):
            for ch2 in children.get(ch1,[]):
                ch2_name = all_colls.get(ch2,("?","?"))[1]
                if ch2_name == "containedItems":
                    return children.get(ch2,[])
    return []

# For each sequence, extract timeline clips
all_sequences = {}
for pk,zn,d in bytype.get("FFAnchoredSequence",[]):
    name = d.get("displayName","?") if isinstance(d,dict) else "?"
    mid = d.get("mediaIdentifier","?") if isinstance(d,dict) else "?"
    items = find_containedItems(pk)
    clips = []
    for i,si in enumerate(items):
        si_type = all_colls.get(si,("?",))[0]
        si_md = bypk.get(si)
        if si_md and isinstance(si_md[2],dict):
            dd = si_md[2]
            nm = dd.get("displayName","?")
            cr = rng(dd.get("clippedRange"))
        else:
            nm = "?"
            cr = None
        clips.append({
            "idx": i, "pk": si, "type": si_type, "name": nm,
            "src_start": round(cr[0],4) if cr else None,
            "duration": round(cr[1],4) if cr else None,
        })
    all_sequences[pk] = {"name": name, "mediaId": mid, "clips": clips}

for seq_pk, seq in all_sequences.items():
    print(f"\n=== Sequence PK={seq_pk}: {seq['name']!r} (mediaId={seq['mediaId']!r}) ===")
    total_dur = 0
    clip_count = 0
    for c in seq["clips"]:
        is_clip = c["type"] not in ("FFAnchoredTransition",)
        tag = "CLIP" if is_clip else "TRANS"
        dur_str = f"{c['duration']:.2f}s" if c['duration'] else "?"
        print(f"  [{c['idx']:2d}] {tag:5s} PK={c['pk']:5d} {c['type']:30s} name={c['name']!r:50s} dur={dur_str}")
        if is_clip and c["duration"]:
            total_dur += c["duration"]
            clip_count += 1
    print(f"  --- {clip_count} clips, total duration: {total_dur:.1f}s ({total_dur/60:.1f}min)")

# Also check: which sequences are referenced by the project's FFClipRef
print("\n\n=== FFAssetRef 素材一覧 (最初20件) ===")
for pk,zn,d in bytype.get("FFAssetRef",[])[:20]:
    if isinstance(d,dict):
        nm = d.get("displayName","?")
        mid = d.get("mediaIdentifier","?")
        print(f"  PK={pk} name={nm!r} mediaId={mid!r}")

print(f"\n合計FFAssetRef: {len(bytype.get('FFAssetRef',[]))}")
print(f"合計FFAnchoredMediaComponent: {len(bytype.get('FFAnchoredMediaComponent',[]))}")
