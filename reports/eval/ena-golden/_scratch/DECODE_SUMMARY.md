# 恵那プロモーション FCP decode summary

## Source
- External drive: `/Volumes/BUFFALO/恵那プロモーション/`
- FCP library: `ena/20151217_1656_GMT+9.fcpbundle` (final backup)
- Export: `恵那市観光プロモーション.mp4` (229.75s, 583MB)

## FCP structure (compound clip nesting)
```
テレビ用 (229.75s, master sequence)
  └─ 最終補正 (wrapper with color correction)
      ├─ Spine: ギャップ(6.38s) + Clepsydra BGM(223.38s)
      └─ Connected storyline (lane=2): 161 items
          ├─ 100 video clips (93 unique sources, 173.3s)
          ├─ 41 transitions (クロスディゾルブ, カラーフェード, etc.)
          ├─ 12 gaps (22.8s)
          ├─ 4 generators (テキスト・ファブリック)
          └─ 4 compound clips (オープニング/栗/感動接続/ライトノイズ)
```

## Compound clips (to be expanded)
- **オープニング** (PK=25671): 4 clips
- **栗** (PK=25914): 2 clips (same source, different in/out)
- **感動接続** (PK=26080): 2 clips (1 text + 1 DJI)
- **ライトノイズ** (PK=26168): 2 clips (1 gap + 1 Blackmagic)

## Source media
- Total pool: ~340 files in 素材/ + Final Cut Original Media/
- Used in edit: 93 unique source clips
- Found on disk: 89/93 (31.6GB)
- Missing: DJI_0008, DJI_0011, DJI_0021, DJI_0023 (drone footage, different source)

## Databases decoded
- `event.sqlite` = 恵那デモ event (all raw clips + compound clips)
- `demo.sqlite` = 恵那映像デモ project (earlier partial edit, 28 clips)
- `project.sqlite` = 恵那市プロモーション project (final master)

## Key output
- `full_timeline.json` = Complete timeline extracted from connected storyline
