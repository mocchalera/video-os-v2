#!/usr/bin/env python3
"""Extract the human edit: ordered video cut list, runtime, source ranges, roles."""
import plistlib, sqlite3, re
from collections import defaultdict

DB = "/tmp/togakushi-probe/project/CurrentVersion.fcpevent"

def unarchive(blob):
    root = plistlib.loads(blob)
    objs = root["$objects"]
    def resolve(o, seen):
        if isinstance(o, plistlib.UID):
            i = o.data
            if i in seen: return f"<cycle:{i}>"
            return resolve(objs[i], seen | {i})
        if isinstance(o, dict):
            if "$class" in o and "NS.keys" in o and "NS.objects" in o:
                ks=[resolve(k,seen) for k in o["NS.keys"]]
                vs=[resolve(v,seen) for v in o["NS.objects"]]
                return dict(zip(ks,vs))
            if "$class" in o and "NS.objects" in o:
                return [resolve(v,seen) for v in o["NS.objects"]]
            return {k:resolve(v,seen) for k,v in o.items() if k!="$class"}
        if isinstance(o, list): return [resolve(v,seen) for v in o]
        return o
    return resolve(root["$top"]["root"], set())

def rng(s):
    """Parse '{(n1/d1),(n2/d2)}' -> (start_sec, dur_sec)."""
    if not isinstance(s,str): return None
    m=re.findall(r"\(([-\d]+)/([-\d]+)\)", s)
    if len(m)!=2: return None
    (n1,d1),(n2,d2)=m
    return (int(n1)/int(d1), int(n2)/int(d2))

con=sqlite3.connect(DB)
rows=con.execute("SELECT c.Z_PK,c.ZTYPE,md.ZDICTIONARYDATA FROM ZCOLLECTIONMD md "
                 "JOIN ZCOLLECTION c ON md.ZCOLLECTION=c.Z_PK WHERE md.ZDICTIONARYDATA IS NOT NULL").fetchall()
bytype=defaultdict(list)
for pk,zt,blob in rows:
    try: d=unarchive(blob)
    except Exception as e: d={"__err__":str(e)}
    bytype[zt].append((pk,d))

# role UID -> name : search any blob carrying role definitions
print("=== FFSequenceInfo / ProjectData のキー(role定義・総尺の所在) ===")
for t in ("FFSequenceInfo","FFMediaEventProjectData","FFMediaEventProject"):
    for pk,d in bytype.get(t,[]):
        if isinstance(d,dict):
            print(f"[{t}] keys={list(d.keys())}")
            for k,v in d.items():
                vs=repr(v)
                if len(vs)>120: vs=vs[:120]+"..."
                print(f"    {k} = {vs}")

# Video components = those whose clippedRange uses a video timebase / name '- v'
comps=bytype.get("FFAnchoredMediaComponent",[])
video=[]; audio=[]
for pk,d in comps:
    if not isinstance(d,dict): continue
    nm=str(d.get("displayName",""))
    cr=rng(d.get("clippedRange"))
    rec={"pk":pk,"name":nm,"lane":d.get("anchoredLane"),"role":d.get("roleUID"),
         "anchor":d.get("anchorPair"),"start":cr[0] if cr else None,"dur":cr[1] if cr else None}
    if re.search(r"-\s*v\d*$", nm) or (cr and "720000" not in str(d.get("clippedRange"))):
        video.append(rec)
    else:
        audio.append(rec)

print(f"\n=== ビデオ系コンポーネント {len(video)} / 音声系 {len(audio)} (合計{len(comps)}) ===")
tot=sum(r["dur"] for r in video if r["dur"])
print(f"ビデオ総尺(重複/接続込み) = {tot:.1f}s  ({tot/60:.1f}分)  クリップ数={len(video)}")

print("\n=== ビデオカット一覧(source-start順) name | dur(s) | src_start(s) | lane | role ===")
for r in sorted(video, key=lambda r:(r["start"] or 0)):
    print(f"  {r['name']:<34} {('%.2f'%r['dur']) if r['dur'] else '?':>7} | "
          f"{('%.1f'%r['start']) if r['start'] else '?':>10} | lane={r['lane']} | {r['role']}")

# role distribution
from collections import Counter
print("\n=== roleUID 別ビデオ本数 ===")
for ro,c in Counter(r["role"] for r in video).most_common():
    print(f"  {ro} : {c}")
con.close()
