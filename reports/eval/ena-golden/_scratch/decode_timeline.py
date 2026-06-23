#!/usr/bin/env python3
"""Extract timeline order, retiming, anchored collections from ena project DB."""
import plistlib, sqlite3, re, json
from collections import defaultdict

DB = "/Users/mocchalera/Dev/video-os-v2-spec/reports/eval/ena-golden/_scratch/project.sqlite"

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
rows=con.execute("SELECT c.Z_PK,c.ZTYPE,c.ZNAME,md.ZDICTIONARYDATA FROM ZCOLLECTIONMD md "
                 "JOIN ZCOLLECTION c ON md.ZCOLLECTION=c.Z_PK WHERE md.ZDICTIONARYDATA IS NOT NULL").fetchall()

# Parent-child tree
tree_table = None
for t in ["Z_3CHILDCOLLECTIONS", "Z_3PARENTCOLLECTIONS"]:
    try:
        con.execute(f"SELECT * FROM {t} LIMIT 1")
        tree_table = t
        break
    except: pass

children=defaultdict(list)
parent_of={}
if tree_table:
    tree=con.execute(f"SELECT * FROM {tree_table}").fetchall()
    # columns: parent, child (order may vary)
    cols = [d[0] for d in con.execute(f"PRAGMA table_info({tree_table})").fetchall()]
    print(f"Tree table: {tree_table} columns={cols}")
    for row in tree:
        p, ch = row[0], row[1]
        children[p].append(ch)
        parent_of[ch]=p
else:
    print("No parent-child tree table found, trying Z_3CHILDCOLLECTIONS directly...")
    try:
        tree=con.execute("SELECT Z_3PARENTCOLLECTIONS, Z_3CHILDCOLLECTIONS FROM Z_3CHILDCOLLECTIONS").fetchall()
        for p,ch in tree:
            children[p].append(ch)
            parent_of[ch]=p
    except Exception as e:
        print(f"  Error: {e}")

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

# 1. Summary
print(f"\n=== タイプ別集計 ===")
type_counts = defaultdict(int)
for pk,(zt,zn) in all_colls.items():
    type_counts[zt] += 1
for t,c in sorted(type_counts.items(), key=lambda x:-x[1]):
    if t: print(f"  {t}: {c}")

# 2. FFAnchoredSequence = spine
print(f"\n=== FFAnchoredSequence (スパイン) ===")
for pk,zn,d in bytype.get("FFAnchoredSequence",[]):
    print(f"  PK={pk} name={zn}")
    if isinstance(d, dict):
        for k,v in d.items():
            vs = repr(v)[:200]
            print(f"    {k} = {vs}")

# 3. Asset references
print(f"\n=== FFAssetRef (素材参照, 最初の10件) ===")
asset_refs = bytype.get("FFAssetRef",[])
for pk,zn,d in asset_refs[:10]:
    if isinstance(d,dict):
        print(f"  PK={pk} displayName={d.get('displayName',d.get('name','?'))!r} "
              f"mediaPaths={d.get('mediaPaths','?')!r}")

# 4. ClipRefs
print(f"\n=== FFClipRef ({len(bytype.get('FFClipRef',[]))}) ===")
for pk,zn,d in bytype.get("FFClipRef",[]):
    if isinstance(d,dict):
        cr = rng(d.get("clippedRange"))
        print(f"  PK={pk} displayName={d.get('displayName','?')!r} "
              f"dur={('%.2fs'%cr[1]) if cr else '?'} "
              f"clippedRange={d.get('clippedRange','?')!r}")

# 5. AnchoredCollections
print(f"\n=== FFAnchoredCollection ({len(bytype.get('FFAnchoredCollection',[]))}) ===")
for pk,zn,d in bytype.get("FFAnchoredCollection",[]):
    if isinstance(d,dict):
        cr=rng(d.get("clippedRange"))
        print(f"  PK={pk} name={d.get('displayName')!r} lane={d.get('anchoredLane')} "
              f"dur={('%.2fs'%cr[1]) if cr else '?'}")

# 6. NSArray containedItems -> spine items
print(f"\n=== スパインの containedItems ===")
for pk,zn,d in bytype.get("FFAnchoredSequence",[]):
    for ch_pk in children.get(pk,[]):
        ch_type = all_colls.get(ch_pk,("?",))[0]
        ch_name = all_colls.get(ch_pk,("?","?"))[1]
        if ch_name == "containedItems" or ch_type == "NSArray":
            spine_items = children.get(ch_pk,[])
            print(f"  NSArray PK={ch_pk} -> {len(spine_items)} spine items")
            for i,si in enumerate(spine_items):
                si_type = all_colls.get(si,("?",))[0]
                si_md = bypk.get(si)
                if si_md and isinstance(si_md[2],dict):
                    nm = si_md[2].get("displayName","?")
                    cr = rng(si_md[2].get("clippedRange"))
                    dur = ('%.2fs'%cr[1]) if cr else "?"
                    aref = si_md[2].get("anchoredAssetRef","?")
                else:
                    nm = "?"
                    dur = "?"
                    aref = "?"
                print(f"    [{i:2d}] PK={si} type={si_type} name={nm!r} dur={dur} assetRef={str(aref)[:60]}")

# 7. AnchoredClip detail
print(f"\n=== FFAnchoredClip detail ===")
for pk,zn,d in bytype.get("FFAnchoredClip",[]):
    if isinstance(d,dict):
        print(f"  PK={pk}")
        for k,v in d.items():
            print(f"    {k} = {repr(v)[:200]}")

con.close()
