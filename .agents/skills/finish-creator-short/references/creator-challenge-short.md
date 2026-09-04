# Creator Challenge Short: 演出・構成・編集リファレンス

SNS縦型ショート動画における構成・演出・テンポ・テロップ・音響の実務リファレンス。対象 platform、
delivery variant、brief、profile の組み合わせは project artifact から読む。

---

## 1. 7-Beat Storytelling Formula & Retention Architecture

beat 順、尺比率、`story_role`、感情価、テンポの正本は次の YAML とする。
秒数はここへ複製せず、brief の目標尺へ比率で伸縮する。

| `narrative_mode` | アーク定義 | 適用対象 |
|---|---|---|
| `personal_challenge` | [`personal-challenge-comeback.yaml`](../../../../runtime/editorial/arcs/personal-challenge-comeback.yaml) | 挑戦宣言、挫折、復活、具体目標、弱さの開示を持つストーリー |
| `day_log` | [`vlog-day-log.yaml`](../../../../runtime/editorial/arcs/vlog-day-log.yaml) | 一日の活動を、説明トークから行動開始、アクション、結果へ進めるログ |

YAML 内の比率・感情価・テンポはすべて provisional である。実 retention データで較正するまで
確定値として扱わない。`narrative_mode` 未指定時は既存経路を維持し、アークを暗黙推定しない。
`editorial.hook_priority: credibility_first` は講演・証言系の別経路なので同時指定しない。

Runtime enforcement は `narrative_mode` と credibility-first の排他、beat ID・順序、全体尺比率
（丸め誤差1 frame以内）、`story_role`、`emotional_valence`、`evidence_required`、および
evidence 必須 beat の候補参照までを対象とする。これらは `edit_blueprint.yaml` から compiler
normalization と deterministic blueprint eval へ保持される。timeline schema に対応 field がないため
`timeline.json` へは投影しない。`tempo` と以下の心理・演出解説は planner/editing guidance であり、
deterministic runtime gate ではない。

以下は YAML の数値を複製する表ではなく、各 beat が効く理由と編集判断の解説である。

### Personal Challenge / Comeback

#### `hook_declaration`
- **目的**: 0秒離脱（スワイプ）の完全防止。
- **心理誘導**: 「何事!?」「どういうこと!?」という強烈な好奇心・違和感の創出。
- **映像・演出**: 素材内で最も勢いのある表情・ポーズ・アクション。
- **テロップ**: 特大黄色グラデーション＋太黒縁取り。
- **SE**: 強烈なアタック音（ドン！/ Boom）。

#### `identity_gap`
- **目的**: キャラクターの確立と「なぜこの人物を見るべきか」の理由提示。
- **心理誘導**: 年代・仕事・経験・目標など、素材で確認できる属性の掛け合わせによる意外性。
- **映像**: 本人トーキングヘッド（正面ミディアムショット）。
- **テロップ**: 属性を短く要約した白文字＋黒縁。

#### `past_struggle`
- **目的**: 完璧な超人ではなく等身大の人間としての親近感・共感の創出。
- **心理誘導**: 「自分と同じように悩んだり挫折したりした過去があるんだ」という安心感。
- **映像**: 活動・練習の追従B-roll（真横、後ろ姿、トラック走行）。
- **テロップ**: 挫折・停滞・ブランクを、発話に忠実な短い要約へ削る。

#### `breakthrough`
- **目的**: 努力と工夫による自己変革。視聴者に知見と希望を与える。
- **心理誘導**: 「正しい理論や努力で変われるんだ！」というワクワク感。
- **映像**: 真剣な表情のトーク＋フォーム確認B-roll。
- **テロップ**: 学び直したことと、素材で裏付けられる変化を要約する。

#### `crisis_cluster` ★最重要リテンション装置
- **目的**: **中盤の離脱ゾーンを、感情のジェットコースターで釘付けにする**。
- **心理誘導**: 「せっかくうまくいったのに、嘘でしょ…!?」「どうなっちゃうの？」というハラハラ感。
- **構成（段階的エスカレーション）**: 親しみのある小さな失敗 → 本番の重大な挫折 → 再開直後の追い打ち、のように、素材内の因果を強めながら谷へ落とす。三段構成を素材が持たない場合は数を捏造しない。
- **演出の鉄則（Big Claim requires Proportional Evidence）**:
  - 大きな主張には、記録画面、医療画像、現場写真、アーカイブ映像などの**実在する証拠素材（Evidence）**を比例して提示する。証拠が無い場合は創作せず、追加取材または degraded plan へ返す。

#### `philosophy_goal`
- **目的**: どん底からの復活宣言、魂の哲学、そして具体的挑戦の宣言。
- **心理誘導**: 「この人は本物だ」「生き様がかっこいい」というリスペクト。
- **演出**:
  - 表情のクローズアップ（寄りのパンチイン）で言葉の熱量をダイレクトに伝える。
  - 話者自身の言葉から、哲学を表す一文を選ぶ。決め台詞を創作しない。
  - 期日・対象・達成条件など、素材で確認できる具体目標を宣言する。
- **無音（Silence）の活用**: 最重要フレーズの直前に、brief と audio policy が許す音の引き（間）を作り、言葉を立てる。

#### `vulnerability_cta`
- **目的**: コメント・フォロー・応援の爆発。
- **心理誘導（Status-Descent Ending）**:
  - 目標宣言（強い姿）で終わると「いいね（称賛）」しか生まれない。
  - 目標の**後**にあえて不確実さや弱さ（Vulnerability）を吐露することで上から目線を消し、応援コメントを生みやすくする。
  - 視聴者を次の小さな行動へ招き、コミュニティの当事者にする。
- **連番タイトル**: 続きがある企画では、連番自体が未完了の心理を作り、次回視聴とフォローの導線になる。

### Vlog / Day Log

#### `double_hook`
- **目的**: 冒頭の主張1点に依存せず、短い宣言または強い画の直後に動きの第2フックを置く。
- **編集**: テロップを発話より先に出して結果をネタバレしない。2つのフックは別の情報を担う。

#### `identity_gap`
- **目的**: 今日の活動を誰が、どんな条件で行うのかを短く確立する。
- **編集**: 属性は素材で確認できるものだけを使い、プロジェクト固有の言い回しは `STYLE.md` に置く。

#### `setup_purpose`
- **目的**: 現地条件とその日の目的を理解させる。
- **編集**: この説明中は話者の顔に貼り付き、無関係なアクション B-roll を連打しない。環境数値を出す場合は実データで裏付ける。

#### `kickoff`
- **目的**: 行動宣言を、説明トークからアクション展開へ切り替える意味的アンカーにする。
- **編集**: 固定 beat 位置ではなく、transcript 内の実際の行動宣言タイミングを境界にする。

#### `action_broll`
- **目的**: 宣言後にアクション、測定データ、短い内的コメントを展開して体験を進める。
- **編集**: データ HUD は実在データだけを使い、主テロップと注釈の階層を分ける。

#### `apex_beat`
- **目的**: 動作の最高到達点を完全静止させ、注釈を読む時間と記憶点を作る。
- **編集**: 静止の著作は `candidate_plan.freeze_frame_hold` と `apex_freeze_hold` で行い、単なるスローや見かけの停止で代用しない。

#### `finish_cta`
- **目的**: 活動結果を報告し、最良の表情で短く閉じる。
- **編集**: 発話終了後の気の緩みや拾い動作を末尾から除き、結果を捏造せず、発話に沿ったCTAだけを残す。

---

## 2. カット割り・画面変化リズム（Visual Rhythm）

カットレート、同一構図の保持、パンチインの scale、A-roll/B-roll/evidence の比率は、arc YAML、
brief、blueprint、composition/retention policy の project-contained 値から選ぶ。固定の秒数、
cuts/minute、zoom、レイヤー比率を generic rule として複製しない。意味的な転換点を選び、
登録済み reframe/content element と source evidence を使い、review/eval の実測で調整する。

---

## 3. テロップ（タイポグラフィ）設計

- **配置セーフエリア**:
  - project-contained の versioned platform safe-zone profile と typography policy を正本にする。
  - UI region が unknown、stale、scope 不一致なら座標を推測せず、fallback/human preview hold にする。
- **文字量と切り替え速度**:
  - wrapping、measurement、行数、切り替え速度は versioned typography policy と caption approval に従う。
  - keyword telop は発話に根拠を持つ要約であり、speech caption text/timing/approval を content element で複製しない。
- **スタイル階層**:
  - `Baseline`、`Positive Hook`、`Crisis / Damage` は project の typography policy と登録済み
    `vos:content.hook-title/v1` / `vos:content.emphasis-word/v1` の範囲で表現する。

---

## 4. サウンドデザイン（Audio & SFX）

※ 音響設計・SE配置・ラウドネス調整は `$short-sound-design` スキルの shared AudioRenderPlan/Executor と連携して適用。

- **ボーカルMA**: コンプレッションとEQで輪郭を際立たせ、声が前に出るミックス。target は versioned audio policy と測定済み report から読む。
- **SE（効果音）の厳密な同期**:
  - テロップ出現・写真カットインの semantic window と source evidence にSEを配置する。
  - アタック音（ドン！）、打撃音（バキッ/ドスン）、ポップ音（ピコッ/シュッ）。
- **無音（Silence / Audio Drop）**:
  - クライマックスの名言直前に、brief と audio policy が許す音の引きを作り、言葉のインパクトを高める。
- **Platform BGM Handoff**:
  - platform-side audio を選ぶ場合は `audio_policy: original_only` とし、動画側にはBGMを焼き込まない。
  - platform preview/handoff は renderer/package と別の human gate として記録し、platform の推薦効果を保証しない。

---

## 5. Creator Short QA チェックリスト

- [ ] **Hook**: brief/retention policy が定める opening window に、実在する宣言テロップとアタックSEがあるか？
- [ ] **Identity**: policy の identity window 内に、素材で裏付けられた話者の属性と意外性が提示されているか？
- [ ] **Evidence**: カメラロールの証拠写真（レントゲン、記録、怪我等）が中盤に配置されているか？
- [ ] **Rhythm**: project の composition/retention policy を超えて同一構図が継続していないか？（必要なら登録済み reframe または B-roll）
- [ ] **Safe Area**: テロップが右側アイコンや下部UIに被っていないか？
- [ ] **Status-Descent CTA**: 目標宣言の後に弱さの吐露と視聴者を巻き込むCTAがあるか？
- [ ] **Audio Mix**: ボーカルがクリアで、SEが視覚イベントと同期しているか？
