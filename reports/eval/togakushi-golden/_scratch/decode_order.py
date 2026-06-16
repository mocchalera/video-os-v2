#!/usr/bin/env python3
"""Extract timeline-ordered cut list from project DB (PK=55 containedItems children)."""
import plistlib, sqlite3, re
from collections import defaultdict

DB = "/Users/mocchalera/Dev/video-os-v2-spec/reports/eval/togakushi-golden/_scratch/project/CurrentVersion.fcpevent"

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

con=sqlite3.connect(DB)
# Load all metadata
md_rows=con.execute("SELECT c.Z_PK,c.ZTYPE,md.ZDICTIONARYDATA FROM ZCOLLECTIONMD md "
                    "JOIN ZCOLLECTION c ON md.ZCOLLECTION=c.Z_PK WHERE md.ZDICTIONARYDATA IS NOT NULL").fetchall()
bypk={}
for pk,zt,blob in md_rows:
    try: d=unarchive(blob)
    except: d={}
    bypk[pk]=(zt,d)

# Parent-child (ordered by rowid = insertion order)
tree=con.execute("SELECT Z_3PARENTCOLLECTIONS, Z_3CHILDCOLLECTIONS FROM Z_3CHILDCOLLECTIONS ORDER BY rowid").fetchall()
children=defaultdict(list)
for p,ch in tree:
    children[p].append(ch)

# All collections
all_colls={}
for row in con.execute("SELECT Z_PK,ZTYPE,ZNAME FROM ZCOLLECTION").fetchall():
    all_colls[row[0]]=(row[1],row[2])

# PK=55 = containedItems of "Togakushi Family Camp" (PK=11)
spine_items = children.get(55, [])
print(f"タイムライン順 全{len(spine_items)}カット\n")
print(f"{'#':>3} {'素材名':<34} {'再生尺':>7} {'ソース尺':>8} {'retimed':>7}")
print("-"*72)

total_play = 0
for i, cpk in enumerate(spine_items):
    ct, cn = all_colls.get(cpk, ("?","?"))
    md = bypk.get(cpk)
    if md and isinstance(md[1], dict):
        nm = md[1].get("displayName","?")
        cr = rng(md[1].get("clippedRange"))
        play_dur = cr[1] if cr else 0
    else:
        nm = "?"
        play_dur = 0

    # Find the video MediaComponent inside this collection
    inner_items = children.get(cpk, [])
    src_dur = None
    retimed = False
    for inner_pk in inner_items:
        inner_ct = all_colls.get(inner_pk,("?",))[0]
        if inner_ct == "NSArray":
            for leaf_pk in children.get(inner_pk, []):
                leaf_md = bypk.get(leaf_pk)
                if leaf_md and leaf_md[0] == "FFAnchoredMediaComponent" and isinstance(leaf_md[1],dict):
                    leaf_nm = str(leaf_md[1].get("displayName",""))
                    if "- v" in leaf_nm:
                        lcr = rng(leaf_md[1].get("clippedRange"))
                        if lcr: src_dur = lcr[1]
        if inner_ct == "NSSet":
            # effects set, check children for retiming
            for eff_pk in children.get(inner_pk, []):
                eff_md = bypk.get(eff_pk)
                if eff_md and eff_md[0] == "FFEffectStack":
                    for seff_pk in children.get(eff_pk, []):
                        seff_md = bypk.get(seff_pk)
                        if seff_md and seff_md[0] == "FFRetimingVideoEffect":
                            retimed = True

    src_str = f"{src_dur:.2f}" if src_dur else "?"
    total_play += play_dur
    print(f"{i+1:3d} {nm:<34} {play_dur:7.2f}s {src_str:>8}s {'  SLOW' if retimed else ''}")

print("-"*72)
print(f"    合計再生尺: {total_play:.1f}s ({total_play/60:.1f}分)")
con.close()
