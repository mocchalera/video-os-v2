#!/usr/bin/env python3
"""Extract timeline order, retiming, anchored collections from project DB."""
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
# All collections with metadata
rows=con.execute("SELECT c.Z_PK,c.ZTYPE,c.ZNAME,md.ZDICTIONARYDATA FROM ZCOLLECTIONMD md "
                 "JOIN ZCOLLECTION c ON md.ZCOLLECTION=c.Z_PK WHERE md.ZDICTIONARYDATA IS NOT NULL").fetchall()
# Parent-child tree
tree=con.execute("SELECT Z_3PARENTCOLLECTIONS, Z_3CHILDCOLLECTIONS FROM Z_3CHILDCOLLECTIONS").fetchall()
children=defaultdict(list)
parent_of={}
for p,ch in tree:
    children[p].append(ch)
    parent_of[ch]=p

bytype=defaultdict(list)
bypk={}
for pk,zt,zn,blob in rows:
    try: d=unarchive(blob)
    except: d={}
    bytype[zt].append((pk,zn,d))
    bypk[pk]=(zt,zn,d)

# All ZCOLLECTION (including those without metadata)
all_colls={}
for row in con.execute("SELECT Z_PK,ZTYPE,ZNAME FROM ZCOLLECTION").fetchall():
    all_colls[row[0]]=(row[1],row[2])

# Spine = FFAnchoredSequence
print("=== FFAnchoredSequence (スパイン) ===")
for pk,zn,d in bytype.get("FFAnchoredSequence",[]):
    print(f"  PK={pk} name={zn} keys={list(d.keys()) if isinstance(d,dict) else d}")
    # children of spine = direct clips
    spine_pk = pk
    # But spine is a ZCOLLECTION row; find its Z_PK
    # Actually need to find the ZCOLLECTION row for the spine
    # spine_pk is already the ZCOLLECTION.Z_PK
    spine_children = children.get(pk,[])
    print(f"  direct children count={len(spine_children)}")

# FFAnchoredCollection = compound clips / connected storylines
print(f"\n=== FFAnchoredCollection ({len(bytype.get('FFAnchoredCollection',[]))}) ===")
for pk,zn,d in bytype.get("FFAnchoredCollection",[]):
    if isinstance(d,dict):
        cr=rng(d.get("clippedRange"))
        print(f"  PK={pk} name={d.get('displayName')!r} lane={d.get('anchoredLane')} "
              f"dur={('%.2f'%cr[1]) if cr else '?'}s anchorPair={d.get('anchorPair')!r}")

# Retiming
print(f"\n=== FFRetimingVideoEffect ({len(bytype.get('FFRetimingVideoEffect',[]))}) ===")
for pk,zn,d in bytype.get("FFRetimingVideoEffect",[]):
    if isinstance(d,dict):
        print(f"  PK={pk} parent={parent_of.get(pk)} keys={list(d.keys())}")
        for k,v in d.items():
            vs=repr(v); print(f"    {k}={vs[:120]}")

# Timeline order: follow spine -> children in order
# The Z_3CHILDCOLLECTIONS table preserves insertion order (rowid)
# Walk from spine
print(f"\n=== タイムライン順序（スパインの子→各子の子）===")
# Find the sequence collection (type FFAnchoredSequence) - it should have children
# that are the primary storyline items
for pk,zn,d in bytype.get("FFAnchoredSequence",[]):
    seq_pk = pk
    # Find collection row that has name "sequence" pointing to this
    # Actually in FCP CoreData, the sequence's containedItems -> NSArray -> children
    # Let's find NSArray named "containedItems" that is child of something related
    pass

# Try: find "containedItems" NSArray collections and their children
print("\n=== NSArray コレクション(タイプ別に何の子か) ===")
for pk,zn,d in bytype.get("NSArray",[]):
    par = parent_of.get(pk)
    par_type = all_colls.get(par,("?","?"))[0] if par else "?"
    ch = children.get(pk,[])
    if len(ch) > 0 and par_type in ("FFAnchoredSequence","FFMediaEventProject","FFAnchoredCollection"):
        ch_types = [all_colls.get(c,("?",))[0] for c in ch[:5]]
        print(f"  PK={pk} name={zn!r} parent={par}({par_type}) children={len(ch)} first_types={ch_types}")

# Find the spine's containedItems
print("\n=== スパインの containedItems の子 (=TL順の主クリップ) ===")
for pk,zn,d in bytype.get("FFAnchoredSequence",[]):
    # children of seq
    for ch_pk in children.get(pk,[]):
        ch_type = all_colls.get(ch_pk,("?",))[0]
        ch_name = all_colls.get(ch_pk,("?","?"))[1]
        if ch_name == "containedItems" or ch_type == "NSArray":
            # This NSArray's children are the spine items in order
            spine_items = children.get(ch_pk,[])
            print(f"  NSArray PK={ch_pk} -> {len(spine_items)} spine items")
            for i,si in enumerate(spine_items):
                si_type = all_colls.get(si,("?",))[0]
                si_md = bypk.get(si)
                if si_md and isinstance(si_md[2],dict):
                    nm = si_md[2].get("displayName","?")
                    cr = rng(si_md[2].get("clippedRange"))
                    dur = ('%.2f'%cr[1]) if cr else "?"
                else:
                    nm = "?"
                    dur = "?"
                print(f"    [{i:2d}] PK={si} type={si_type} name={nm!r} dur={dur}s")
con.close()
