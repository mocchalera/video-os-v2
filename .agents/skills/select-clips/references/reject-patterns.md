# Reject Patterns

`select-clips` で `role: reject` を付けるべき典型パターン。
単に relevance が低いだけの素材は omission でもよいが、**避ける理由を operator に見せる必要がある場合は reject を使う。**

## 1. brief の `must_avoid` に該当する素材

- brief の `must_avoid[i]` に一致する scene, line, framing, mood は `role: reject` を基本とする
- `rejection_reason` には must_avoid の文言をそのまま近い形で残す
- `evidence` には `brief.must_avoid[i]` と、該当根拠になった transcript / tag / visual confirmation を入れる

## 2. 技術的 NG

### 2.1 hard reject

以下は原則 reject。

- 重大な手ブレや被写体判別不能な blur
- recover 困難な露出不足 / 白飛び
- `clipped_audio` のような音割れ
- 内容理解に支障が出るレベルの technical failure

### 2.2 risk に留めるケース

以下は brief と代替候補次第で候補に残してよい。

- `slight_wind`
- `minor_highlight_clip`
- 軽微な noise や小さな framing issue

この場合は reject ではなく `risks` / `quality_flags` に落とす。

## 3. プライバシー / 対象外人物

- contact sheet や filmstrip で、対象外の人の顔や秘匿情報が見える場合は reject を優先する
- analysis artifact が自動で flag しなくても、視認できたなら human judgment で reject してよい
- 「主題に不要だが映り込みがある」素材は、使いどころを探す前に privacy risk として扱う

## 4. 重複と別テイク

- 同じ scene の別テイクは最良テイクのみ positive candidate にする
- 他の近似テイクは omit してもよいが、比較対象として残すなら `role: reject` と `rejection_reason: duplicate_take` 相当の説明を書く
- 同一 scene を複数残す場合は、役割が異なることを説明できるときだけにする

## 5. reject と omission の使い分け

- `role: reject` を使う:
  must_avoid, privacy, hard technical NG, duplicate take のように「避ける理由」が重要な場合
- omit だけでよい:
  relevance が低いだけで、特に共有すべき拒否理由が無い場合

## 6. reject candidate の必須項目

- `segment_id`, `asset_id`, `src_in_us`, `src_out_us`
- `role: reject`
- `why_it_matches`
  exclusion rationale として使う。なぜ「採らないべきか」を短く明示する
- `risks`
- `confidence`
- `rejection_reason`

positive candidate と reject candidate を混同しないこと。reject は「悪い素材」ではなく、「この brief では採らない理由が明確な素材」を示す。
