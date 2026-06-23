#!/usr/bin/env python3
"""Extract complete timeline from ena demo.sqlite as JSON for golden assembly."""
import plistlib, sqlite3, re, json
from collections import defaultdict

DEMO_DB = "/Users/mocchalera/Dev/video-os-v2-spec/reports/eval/ena-golden/_scratch/demo.sqlite"

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

con=sqlite3.connect(DEMO_DB)
rows=con.execute("SELECT c.Z_PK,c.ZTYPE,c.ZNAME,md.ZDICTIONARYDATA FROM ZCOLLECTIONMD md "
                 "JOIN ZCOLLECTION c ON md.ZCOLLECTION=c.Z_PK WHERE md.ZDICTIONARYDATA IS NOT NULL").fetchall()
children=defaultdict(list)
for p,ch in con.execute("SELECT Z_3PARENTCOLLECTIONS, Z_3CHILDCOLLECTIONS FROM Z_3CHILDCOLLECTIONS ORDER BY rowid").fetchall():
    children[p].append(ch)

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

# Navigate spine -> containedItems
timeline_clips = []
for pk,zn,d in bytype.get("FFAnchoredSequence",[]):
    for ch1 in children.get(pk,[]):
        ch1_name = all_colls.get(ch1,("?","?"))[1]
        if ch1_name == "primaryObject":
            for ch2 in children.get(ch1,[]):
                ch2_type = all_colls.get(ch2,("?",))[0]
                if ch2_type == "FFAnchoredCollection":
                    for ch3 in children.get(ch2,[]):
                        ch3_name = all_colls.get(ch3,("?","?"))[1]
                        if ch3_name == "containedItems":
                            spine_items = children.get(ch3,[])
                            for i,si in enumerate(spine_items):
                                si_type = all_colls.get(si,("?",))[0]
                                si_md = bypk.get(si)
                                if si_md and isinstance(si_md[2],dict):
                                    dd = si_md[2]
                                    nm = dd.get("displayName","?")
                                    cr = rng(dd.get("clippedRange"))
                                    is_transition = si_type == "FFAnchoredTransition"
                                    entry = {
                                        "position": i,
                                        "type": "transition" if is_transition else "clip",
                                        "fcp_type": si_type,
                                        "display_name": nm,
                                        "src_start_s": round(cr[0],6) if cr else None,
                                        "duration_s": round(cr[1],6) if cr else None,
                                    }
                                    # For clips, find children that are FFAnchoredMediaComponent
                                    if not is_transition:
                                        for child_pk in children.get(si,[]):
                                            child_type = all_colls.get(child_pk,("?",))[0]
                                            if child_type == "NSArray":
                                                for sub_pk in children.get(child_pk,[]):
                                                    sub_type = all_colls.get(sub_pk,("?",))[0]
                                                    sub_md = bypk.get(sub_pk)
                                                    if sub_md and isinstance(sub_md[2],dict) and sub_type == "FFAnchoredMediaComponent":
                                                        sub_dd = sub_md[2]
                                                        sub_nm = sub_dd.get("displayName","")
                                                        if "- v1" in sub_nm or sub_nm.endswith("- v1"):
                                                            sub_cr = rng(sub_dd.get("clippedRange"))
                                                            entry["media_name"] = sub_nm.replace(" - v1","")
                                                            entry["media_src_start_s"] = round(sub_cr[0],6) if sub_cr else None
                                                            entry["media_duration_s"] = round(sub_cr[1],6) if sub_cr else None
                                                    # Also check for retiming
                                                    if sub_type == "FFRateConformVideoEffect":
                                                        if sub_md and isinstance(sub_md[2],dict):
                                                            entry["has_retiming"] = True
                                                            entry["retiming_data"] = {k:repr(v)[:100] for k,v in sub_md[2].items()}
                                    timeline_clips.append(entry)

# Also check for retiming effects on collections
for pk,zn,d in bytype.get("FFRateConformVideoEffect",[]):
    if isinstance(d,dict):
        for tc in timeline_clips:
            if tc.get("display_name") and tc.get("media_name") and tc["display_name"].startswith(tc["media_name"][:30]):
                # Check if this retiming is a child of this clip's collection
                pass

result = {
    "project_name": "恵那映像デモ",
    "export_duration_s": 229.75,
    "clips_count": len([c for c in timeline_clips if c["type"]=="clip"]),
    "transitions_count": len([c for c in timeline_clips if c["type"]=="transition"]),
    "timeline": timeline_clips,
}

out_path = "/Users/mocchalera/Dev/video-os-v2-spec/reports/eval/ena-golden/_scratch/timeline_decoded.json"
with open(out_path, "w") as f:
    json.dump(result, f, indent=2, ensure_ascii=False)

print(f"Wrote {out_path}")
print(f"Clips: {result['clips_count']}, Transitions: {result['transitions_count']}")
total_clip_dur = sum(c["duration_s"] for c in timeline_clips if c["type"]=="clip" and c["duration_s"])
print(f"Total clip duration: {total_clip_dur:.1f}s ({total_clip_dur/60:.1f}min)")
print()
for c in timeline_clips:
    if c["type"]=="clip":
        print(f"  [{c['position']:2d}] {c['display_name'][:55]:55s} dur={c['duration_s']:.2f}s media={c.get('media_name','?')[:40]}")
    else:
        print(f"  [{c['position']:2d}] --- {c['display_name']:50s} dur={c['duration_s']:.2f}s")

con.close()
