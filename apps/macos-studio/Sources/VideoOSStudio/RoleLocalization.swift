import Foundation
import VideoOSStudioCore

func localizedClipRole(_ role: String) -> String {
    switch role {
    case "hero":
        return "主役"
    case "dialogue":
        return "会話"
    case "support":
        return "補助"
    case "transition":
        return "つなぎ"
    case "texture":
        return "質感"
    case "music", "bgm":
        return "音楽"
    case "nat_sound":
        return "現場音"
    case "ambient":
        return "環境音"
    case "title":
        return "タイトル"
    case "caption":
        return "字幕"
    default:
        return role
    }
}

func localizedEvidenceTag(_ tag: String) -> String {
    switch normalizedLocalizationKey(tag) {
    case "transcript":
        return "文字起こし"
    case "qc":
        return "品質確認"
    case "visual_tag":
        return "画像タグ"
    case "contact_sheet":
        return "コンタクトシート"
    case "key_frame", "keyframe":
        return "代表フレーム"
    case "e5_text":
        return "テキスト検索"
    case "qwen_visual":
        return "画像特徴"
    case "qwen_text":
        return "画像説明"
    case "clap_audio":
        return "音声特徴"
    case "lexical":
        return "単語一致"
    case "marlin_caption":
        return "Marlin説明"
    case "marlin_find":
        return "Marlin検索"
    case "audio_event":
        return "音声イベント"
    case "story_node":
        return "音声ストーリー"
    case "bgm":
        return "BGM"
    case "dialogue":
        return "会話"
    case "interview":
        return "インタビュー"
    case "ai_workshop":
        return "AI研修"
    case "participant_testimonial":
        return "参加者の声"
    case "business_application":
        return "業務活用"
    case "learning_experience":
        return "学習体験"
    case "indoor_scene":
        return "室内シーン"
    case "two_people":
        return "2人"
    case "japanese_language":
        return "日本語"
    case "close_up":
        return "寄り"
    case "enthusiastic":
        return "熱量あり"
    case "manager":
        return "マネージャー"
    case "executive":
        return "経営層"
    case "slow_down":
        return "ペースを落とす"
    case "message":
        return "メッセージ"
    case "hands":
        return "手元"
    case "mug":
        return "マグ"
    case "warmth":
        return "温かさ"
    case "space":
        return "余白"
    case "thought":
        return "思考"
    case "quiet":
        return "静けさ"
    case "river":
        return "川"
    case "sunrise":
        return "日の出"
    case "verse":
        return "バース"
    case "chorus":
        return "サビ"
    case "bridge":
        return "ブリッジ"
    default:
        return tag.replacingOccurrences(of: "_", with: " ")
    }
}

func localizedQualityFlag(_ flag: String) -> String {
    switch normalizedLocalizationKey(flag) {
    case "short":
        return "短尺"
    case "long":
        return "長尺"
    case "low_confidence":
        return "低信頼度"
    case "missing_transcript":
        return "文字起こしなし"
    case "needs_proxy":
        return "プロキシ必要"
    case "missing_media":
        return "素材未接続"
    case "near_silent":
        return "ほぼ無音"
    case "minor_highlight_clip":
        return "軽いハイライト"
    case "slight_wind":
        return "風音あり"
    default:
        return localizedEvidenceTag(flag)
    }
}

func localizedTrackKind(_ kind: TimelineTrackKind) -> String {
    switch kind {
    case .video:
        return "映像"
    case .audio:
        return "音声"
    case .overlay:
        return "重ね映像"
    case .caption:
        return "字幕"
    }
}

func localizedSourcePass(_ value: String) -> String {
    switch normalizedLocalizationKey(value) {
    case "marlin_caption":
        return "Marlin説明"
    case "marlin_find":
        return "Marlin検索"
    case "marlin_temporal_semantics":
        return "Marlin時間理解"
    case "vlm":
        return "画像理解"
    case "audio_events":
        return "音声イベント"
    case "audio_story":
        return "音声ストーリー"
    default:
        return localizedEvidenceTag(value)
    }
}

func localizedPrecisionMode(_ value: String) -> String {
    switch normalizedLocalizationKey(value) {
    case "marlin_temporal_semantics":
        return "Marlin時間理解"
    case "duration_bound":
        return "尺優先の発話境界"
    case "speech_boundary":
        return "発話境界"
    case "never":
        return "未適用"
    default:
        return localizedSourcePass(value)
    }
}

func localizedAudioEventType(_ value: String) -> String {
    switch normalizedLocalizationKey(value) {
    case "laughter", "laugh":
        return "笑い声"
    case "silence":
        return "無音"
    case "speech", "dialogue":
        return "発話"
    case "music", "bgm":
        return "音楽"
    case "applause":
        return "拍手"
    case "noise":
        return "ノイズ"
    case "room_tone":
        return "室内音"
    default:
        return localizedEvidenceTag(value)
    }
}

func localizedAudioStoryType(_ value: String) -> String {
    switch normalizedLocalizationKey(value) {
    case "reaction":
        return "反応"
    case "setup":
        return "導入"
    case "turning_point":
        return "転換点"
    case "resolution":
        return "着地"
    case "speaker":
        return "話者"
    case "dialogue":
        return "会話"
    default:
        return localizedEvidenceTag(value)
    }
}

func localizedMediaPlaybackStatus(_ status: ProjectMediaPreviewStatus.PlaybackStatus) -> String {
    switch status {
    case .directVideo:
        return "元映像を直接再生"
    case .proxyVideo:
        return "プロキシで再生"
    case .directAudio:
        return "音声を直接利用"
    case .needsProxy:
        return "プロキシ作成が必要"
    case .missing:
        return "素材未接続"
    }
}

func localizedArtifactPath(_ path: String) -> String {
    switch path {
    case "03_analysis/assets.json":
        return "解析済み素材: \(path)"
    case "03_analysis/segments.json":
        return "解析セグメント: \(path)"
    case "03_analysis/search/footage.db":
        return "検索インデックス: \(path)"
    case "05_timeline/timeline.json":
        return "タイムラインJSON: \(path)"
    case "07_handoff/editor_annotations.json":
        return "編集メモ: \(path)"
    case "07_package/qa-report.json":
        return "納品QAレポート: \(path)"
    case "07_package/package_manifest.json":
        return "納品マニフェスト: \(path)"
    case "09_output/final.mp4":
        return "最終動画: \(path)"
    case "09_output/final_mix.wav":
        return "最終ミックス: \(path)"
    case "09_output/promo-finish/subtitles.ass":
        return "宣材テロップASS: \(path)"
    case "09_output/promo-finished.mp4":
        return "宣材テロップ動画: \(path)"
    default:
        return path
    }
}

private func normalizedLocalizationKey(_ value: String) -> String {
    value
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
        .replacingOccurrences(of: "-", with: "_")
        .replacingOccurrences(of: " ", with: "_")
}

func localizedAgentJobTitle(_ job: VideoOSAgentJob) -> String {
    switch job {
    case .status:
        return "状態確認"
    case .validate:
        return "検証"
    case .clipAnnotation:
        return "クリップメモ"
    case .triage:
        return "候補抽出"
    case .blueprint:
        return "構成案"
    case .compile:
        return "粗編集生成"
    case .review:
        return "レビュー"
    case .render:
        return "最終書き出し"
    }
}

func localizedAgentJobTitle(_ title: String) -> String {
    switch title {
    case "Status":
        return "状態確認"
    case "Validate":
        return "検証"
    case "Clip Note":
        return "クリップメモ"
    case "Triage":
        return "候補抽出"
    case "Blueprint":
        return "構成案"
    case "Compile":
        return "粗編集生成"
    case "Review":
        return "レビュー"
    case "Render":
        return "最終書き出し"
    default:
        return title
    }
}

func localizedSandboxLabel(_ label: String) -> String {
    switch label {
    case "read-only / network off":
        return "読み取り専用 / ネットワークなし"
    case "workspace-write / user reviewed":
        return "ワークスペース書き込み / ユーザー確認あり"
    default:
        return label
    }
}

func localizedContractMode(_ label: String) -> String {
    switch label {
    case "read-only status":
        return "読み取り専用の状態確認"
    case "read-only validation":
        return "読み取り専用の検証"
    case "read-only selected-clip annotation proposal":
        return "読み取り専用の選択クリップメモ提案"
    case "workspace-write triage contract":
        return "候補抽出の書き込み契約"
    case "workspace-write blueprint contract":
        return "構成案の書き込み契約"
    case "workspace-write compiler contract":
        return "粗編集生成の書き込み契約"
    case "workspace-write review contract":
        return "レビューの書き込み契約"
    case "workspace-write render contract":
        return "最終書き出しの書き込み契約"
    default:
        return label
    }
}

func localizedContractArtifact(_ value: String) -> String {
    if value.contains("selects_candidates.yaml") {
        return "候補選定ファイル: \(value)"
    }
    if value.contains("edit_blueprint.yaml") {
        return "構成案ファイル: \(value)"
    }
    if value.contains("uncertainty_register.yaml") {
        return "不確実性メモ: \(value)"
    }
    if value.contains("script_evaluation.yaml") {
        return "構成評価ファイル: \(value)"
    }
    if value.contains("timeline.json") {
        return "タイムラインJSON: \(value)"
    }
    if value.contains("timeline.otio") {
        return "OTIOタイムライン: \(value)"
    }
    if value.contains("preview-manifest.json") {
        return "プレビュー照合マニフェスト: \(value)"
    }
    if value.contains("review_report.yaml") {
        return "レビュー報告: \(value)"
    }
    if value.contains("review_patch.json") {
        return "レビュー修正案: \(value)"
    }
    if value.contains("qa-report.json") {
        return "納品QAレポート: \(value)"
    }
    if value.contains("package_manifest.json") {
        return "納品マニフェスト: \(value)"
    }
    if value.contains("09_output/final.mp4") {
        return "最終動画: \(value)"
    }
    if value.contains("07_package/") {
        return "納品パッケージ: \(value)"
    }
    if value.contains("05_timeline/") || value.hasSuffix("/05_timeline/") {
        return "タイムライン出力先: \(value)"
    }
    if value.contains("project_state.yaml") {
        return "プロジェクト状態: \(value)"
    }
    if value.contains("progress.json") {
        return "進行状況: \(value)"
    }
    return value
}

func localizedForbiddenWrite(_ value: String) -> String {
    if value == "any repository file mutation" {
        return "リポジトリ内のファイル変更すべて"
    }
    if value == "timeline, review, media proxy, or search-index writes" {
        return "タイムライン、レビュー、メディアプロキシ、検索インデックスへの書き込み"
    }
    if value == "schema repair or artifact generation" {
        return "スキーマ修復または成果物生成"
    }
    if value.contains("editor_annotations.json") {
        return "編集者メモの保存/削除: \(value)"
    }
    if value.hasPrefix("direct edits to analysis artifacts") || value == "analysis artifacts under projects/<id>/03_analysis/" {
        return "解析成果物への直接編集: \(value)"
    }
    if value.hasPrefix("blueprint artifacts under") {
        return "構成案成果物への書き込み: \(value)"
    }
    if value.hasPrefix("timeline writes under") {
        return "タイムライン成果物への書き込み: \(value)"
    }
    if value == "review, render, media proxy, or search-index writes" {
        return "レビュー、レンダー、メディアプロキシ、検索インデックスへの書き込み"
    }
    if value.hasPrefix("direct edits to selects under") {
        return "候補選定ファイルへの直接編集: \(value)"
    }
    if value.hasPrefix("analysis artifacts under") {
        return "解析成果物への書き込み: \(value)"
    }
    if value == "direct edits to planning artifacts outside compiler inputs" {
        return "コンパイラ入力以外の計画成果物への直接編集"
    }
    if value == "manual timeline writes outside scripts/compile-timeline.ts" {
        return "compile-timeline.ts 以外からの手動タイムライン書き込み"
    }
    if value.hasPrefix("review artifacts under") {
        return "レビュー成果物への書き込み: \(value)"
    }
    if value.hasPrefix("auto-compiling or modifying") {
        return "自動コンパイルまたはタイムライン変更: \(value)"
    }
    if value == "direct edits to analysis, triage, or blueprint artifacts" {
        return "解析、候補抽出、構成案成果物への直接編集"
    }
    if value == "direct edits to analysis, triage, blueprint, or review artifacts" {
        return "解析、候補抽出、構成案、レビュー成果物への直接編集"
    }
    if value == "media, proxy, or search-index writes" {
        return "メディア、プロキシ、検索インデックスへの書き込み"
    }
    if value == "media source, proxy, or search-index writes outside render/package outputs" {
        return "レンダー/納品出力以外の素材、プロキシ、検索インデックスへの書き込み"
    }
    return localizedContractArtifact(value)
}

func localizedWriteViolationReason(_ reason: String) -> String {
    switch reason {
    case "read-only job changed a canonical artifact":
        return "読み取り専用ジョブが正準成果物を変更しました"
    case "outside allowed write contract":
        return "許可された書き込み範囲の外です"
    default:
        return reason
    }
}

func localizedArtifactDiffKind(_ kind: ProjectArtifactDiff.Kind) -> String {
    switch kind {
    case .added:
        return "追加"
    case .modified:
        return "変更"
    case .removed:
        return "削除"
    }
}

func localizedRunStatus(_ status: String) -> String {
    switch status {
    case "completed":
        return "完了"
    case "failed":
        return "失敗"
    case "running":
        return "実行中"
    case "pending":
        return "待機中"
    case "cancelled", "canceled":
        return "キャンセル"
    default:
        return status
    }
}

func localizedStudioLabel(_ label: String) -> String {
    if label.hasPrefix("exportable with temporary source map and ") {
        let count = label
            .replacingOccurrences(of: "exportable with temporary source map and ", with: "")
            .replacingOccurrences(of: " relinks", with: "")
        return "一時素材マップで書き出し可能 / 再リンク \(count)件"
    }
    if label.hasPrefix("exportable with ") && label.hasSuffix(" relinks") {
        let count = label
            .replacingOccurrences(of: "exportable with ", with: "")
            .replacingOccurrences(of: " relinks", with: "")
        return "書き出し可能 / 再リンク \(count)件"
    }
    if label.hasPrefix("exportable; ") && label.hasSuffix(" native proxies pending") {
        let count = label
            .replacingOccurrences(of: "exportable; ", with: "")
            .replacingOccurrences(of: " native proxies pending", with: "")
        return "書き出し可能 / ネイティブプロキシ未作成 \(count)件"
    }
    if label.hasPrefix("packet ready with ") && label.hasSuffix(" notes") {
        let count = label
            .replacingOccurrences(of: "packet ready with ", with: "")
            .replacingOccurrences(of: " notes", with: "")
        return "パケット準備完了 / メモ \(count)件"
    }
    switch label {
    case "missing creative brief":
        return "編集意図が未作成"
    case "waiting for analysis":
        return "素材解析待ち"
    case "dialogue evidence missing":
        return "音声根拠が不足"
    case "ready for triage":
        return "候補抽出可能"
    case "ready for blueprint":
        return "構成案作成可能"
    case "blueprint stale":
        return "構成案が古い"
    case "planning ready":
        return "計画準備完了"
    case "studio ready":
        return "Studio準備完了"
    case "packaged":
        return "パッケージ済み"
    case "ready for finishing":
        return "仕上げ可能"
    case "review loop active":
        return "レビュー対応中"
    case "ready to compile":
        return "粗編集生成可能"
    case "ready for planning":
        return "計画作成可能"
    case "needs ingest":
        return "取り込みが必要"
    case "needs revision pass":
        return "修正反映が必要"
    case "review blocked":
        return "レビューで停止"
    case "needs review":
        return "レビューが必要"
    case "ready to render":
        return "書き出し可能"
    case "configured":
        return "設定済み"
    case "repo runtime missing":
        return "リポジトリ実行環境なし"
    case "missing analyze script":
        return "素材解析スクリプトなし"
    case "source folder missing":
        return "素材フォルダなし"
    case "no source media":
        return "取り込み素材なし"
    case "not analyzed":
        return "未解析"
    case "media relink needed":
        return "素材の再接続が必要"
    case "preview proxies needed":
        return "プレビュープロキシが必要"
    case "index missing":
        return "検索インデックスなし"
    case "library ready":
        return "素材ライブラリ準備完了"
    case "ready for compile":
        return "粗編集生成に進めます"
    case "source map incomplete":
        return "素材対応表が未完了"
    case "source map has broken paths":
        return "素材対応表に切れた参照あり"
    case "analysis missing":
        return "解析成果物なし"
    case "missing blockers artifact":
        return "制約メモが未作成"
    case "intent blocked":
        return "編集意図に未解決の制約あり"
    case "intent ready":
        return "編集意図は準備済み"
    case "intent aligned":
        return "編集意図に合致"
    case "brief mismatch":
        return "編集意図とのずれあり"
    case "review needs revision":
        return "レビュー修正が必要"
    case "missing policy":
        return "解析ポリシーなし"
    case "hybrid opt-in":
        return "ハイブリッド解析を使用"
    case "model access ready":
        return "モデルアクセス可能"
    case "model access denied":
        return "モデルアクセス拒否"
    case "model access unchecked":
        return "モデルアクセス未確認"
    case "HF_TOKEN missing":
        return "HF_TOKEN未設定"
    case "missing dependencies":
        return "依存関係不足"
    case "live runtime ready":
        return "ライブ実行環境準備完了"
    case "device unavailable":
        return "実行デバイスを使用できません"
    case "mock evaluation":
        return "モック評価"
    case "artifact unreadable":
        return "成果物を読めません"
    case "no temporal events":
        return "時間イベントなし"
    case "needs more footage evaluation":
        return "追加素材の評価が必要"
    case "candidate evidence exists":
        return "候補根拠あり"
    case "candidate evidence":
        return "候補根拠あり"
    case "representative evaluation ready":
        return "代表評価を実行可能"
    case "partial representative coverage":
        return "代表カバレッジ一部あり"
    case "ready to evaluate":
        return "評価可能"
    case "blocked by media":
        return "素材未接続で停止"
    case "missing representative project":
        return "代表プロジェクトなし"
    case "missing representative coverage":
        return "代表カバレッジ不足"
    case "not rendered":
        return "未書き出し"
    case "qa failed":
        return "QA失敗"
    case "ready to validate package":
        return "パッケージ検証可能"
    case "state must be approved or packaged":
        return "承認またはパッケージ済み状態が必要"
    case "missing edit blueprint":
        return "構成案なし"
    case "missing render worker":
        return "書き出しワーカーなし"
    case "missing timeline":
        return "タイムラインなし"
    case "missing review":
        return "レビューなし"
    case "supplied final missing":
        return "指定された最終動画なし"
    case "assembly file missing":
        return "組み立てファイルなし"
    case "audio ready":
        return "音声根拠あり"
    case "audio evidence missing":
        return "音声根拠なし"
    case "ready":
        return "準備完了"
    case "candidate":
        return "候補"
    case "materialize peaks":
        return "ピーク反映"
    case "relink media":
        return "素材再接続"
    case "no unevaluated sources":
        return "未評価素材なし"
    case "missing script":
        return "スクリプトなし"
    case "missing marlin artifact":
        return "Marlin成果物なし"
    case "missing segments":
        return "セグメントなし"
    case "no video sources":
        return "映像素材なし"
    case "no analyzed assets":
        return "解析済み素材なし"
    case "render packaged":
        return "レンダーパッケージ済み"
    case "promo finish ready":
        return "宣材テロップ仕上げ済み"
    case "promo finish no captions":
        return "宣材動画あり / テロップなし"
    case "promo subtitles ready":
        return "テロップ生成済み"
    case "promo subtitles unreadable":
        return "テロップASSを読めません"
    case "promo video ready":
        return "宣材動画あり"
    case "promo finish incomplete":
        return "テロップ仕上げ途中"
    case "promo finish missing":
        return "未生成"
    case "ready to promo finish":
        return "テロップ仕上げ可能"
    case "missing promo finish worker":
        return "テロップ仕上げワーカーなし"
    case "missing transcripts":
        return "文字起こしなし"
    case "not evaluated":
        return "未評価"
    case "no projects":
        return "プロジェクトなし"
    case "not ready":
        return "未準備"
    case "partially ready":
        return "一部準備済み"
    case "needs more evidence":
        return "追加根拠が必要"
    case "candidate for preferred VLM":
        return "優先VLM候補"
    case "needs representative coverage":
        return "代表カバレッジ不足"
    case "needs representative category evidence":
        return "代表カテゴリ根拠が不足"
    case "ready for Marlin-first temporal VLM":
        return "Marlin優先VLMに切り替え可能"
    case "needs segment materialization":
        return "セグメント反映が必要"
    case "source map ready":
        return "素材対応表は準備済み"
    case "source map missing":
        return "素材対応表なし"
    case "timeline missing":
        return "タイムラインなし"
    case "media relink required":
        return "素材の再接続が必要"
    case "no runnable evaluation":
        return "実行可能な評価なし"
    case "packet ready without notes":
        return "パケット準備完了 / メモなし"
    case "packet missing":
        return "パケットなし"
    case "manifest missing":
        return "マニフェストなし"
    case "manifest unreadable":
        return "マニフェストを読めません"
    case "packet incomplete":
        return "パケット未完了"
    case "packet has no media":
        return "パケットに素材なし"
    case "final media missing":
        return "最終動画なし"
    case "packet verified without final audio":
        return "パケット検証済み / 最終音声なし"
    case "packet verified":
        return "パケット検証済み"
    case "visual QA passed":
        return "ビジュアルQA合格"
    case "visual QA missing":
        return "ビジュアルQAなし"
    case "visual QA unreadable":
        return "ビジュアルQAを読めません"
    case "visual QA not passed":
        return "ビジュアルQA未合格"
    case "visual QA screenshot missing":
        return "ビジュアルQA画像なし"
    case "visual QA incomplete":
        return "ビジュアルQA未完了"
    case "visual QA failed":
        return "ビジュアルQA失敗"
    default:
        return label
    }
}

func localizedStudioText(_ text: String) -> String {
    if let localizedMarlinText = localizedMarlinDynamicText(text) {
        return localizedMarlinText
    }

    switch text {
    case "Define the editing intent before selecting footage.":
        return "素材を選ぶ前に、編集意図を定義してください。"
    case "Run source analysis so Codex has assets and segments to select from.":
        return "Codexが候補を選べるように、素材解析で素材とセグメントを作成してください。"
    case "Run audio, diarization, transcript, and BGM analysis before selecting interview or dialogue clips.":
        return "インタビューや対話素材を選ぶ前に、音声、話者分離、文字起こし、BGM解析を実行してください。"
    case "Run the Triage Codex job to create selects_candidates.yaml from analyzed material.":
        return "候補抽出ジョブを実行し、解析済み素材から selects_candidates.yaml を作成してください。"
    case "Run the Blueprint Codex job to turn selects into an edit_blueprint.yaml.":
        return "構成案ジョブを実行し、選定候補を edit_blueprint.yaml に変換してください。"
    case "Run the Blueprint Codex job again because edit_blueprint.yaml is older than its planning inputs.":
        return "構成案が候補または意図より古いため、構成案ジョブを再実行してください。"
    case "Planning artifacts are ready; compile the rough cut.":
        return "計画成果物は準備済みです。粗編集を生成してください。"
    case "Run app-server-smoke after the repository runtime is available.":
        return "リポジトリ実行環境が使える状態で app-server-smoke を実行してください。"
    case "Run audio, diarization, transcript, and BGM analysis so cuts can follow sound as well as picture.":
        return "映像だけでなく音にも合わせてカットできるように、音声、話者分離、文字起こし、BGM解析を実行してください。"
    case "Relink source media or export the editor packet once timeline and source mapping are ready.":
        return "タイムラインと素材対応表が準備できたら、素材を再接続するか編集者パケットを書き出してください。"
    case "Approve the reviewed rough cut, then run render/package validation.":
        return "レビュー済みの粗編集を承認し、レンダー/パッケージ検証を実行してください。"
    case "Render the final package or export the editor handoff packet.":
        return "最終パッケージを書き出すか、編集者ハンドオフパケットを書き出してください。"
    case "Resolve the current review gate before continuing.":
        return "続行する前に、現在のレビューゲートを解決してください。"
    case "Apply Marlin-first temporal semantics to the analysis defaults after operator confirmation.":
        return "オペレーター確認後、解析の既定設定をMarlin優先の時間理解に切り替えてください。"
    case "Marlin evidence is affecting segment peak selection. Keep hybrid fallback, but this project is a candidate for Marlin-first temporal semantics.":
        return "Marlin根拠がセグメントのピーク選択に反映されています。既存VLMへのフォールバックは残しつつ、このプロジェクトはMarlin優先の時間理解候補です。"
    case "This Marlin artifact was produced in mock mode. Use it for workflow QA only; run a live Marlin-2B pass before counting it as preference evidence.":
        return "このMarlin成果物はモックモードで作成されています。ワークフローQA用として扱い、優先根拠に含める前にライブMarlin-2B評価を実行してください。"
    case "Marlin events exist, but segments do not show Marlin-derived peaks yet. Run marlin-materialize to apply existing evidence before changing VLM priority.":
        return "Marlinイベントはありますが、セグメントのピークにはまだ反映されていません。VLM優先度を変える前に marlin-materialize で既存根拠を反映してください。"
    case "Marlin produced evidence, but coverage is still too low for a default preference decision. Test more representative interview and music-video footage.":
        return "Marlin根拠はありますが、既定設定を切り替えるにはカバレッジが不足しています。代表的なインタビュー素材とミュージックビデオ素材で追加評価してください。"
    case "The artifact decoded, but no timestamped event or find evidence was produced.":
        return "成果物は読み込めましたが、タイムスタンプ付きイベントや検索根拠は生成されていません。"
    case "Fix or regenerate 03_analysis/marlin_events.json before evaluating Marlin.":
        return "Marlin評価の前に 03_analysis/marlin_events.json を修正または再生成してください。"
    case "Run a local Marlin-2B analysis pass before considering it as the preferred temporal VLM.":
        return "時間理解VLMの優先候補として扱う前に、ローカルのMarlin-2B解析を実行してください。"
    case "Marlin is affecting segment peaks across representative projects. It is reasonable to promote Marlin-first temporal semantics while keeping the existing VLM fallback.":
        return "代表プロジェクト全体でMarlinがセグメントピークに反映されています。既存VLMへのフォールバックを残したまま、Marlin優先の時間理解へ切り替えられる状態です。"
    case "Some evaluated projects are not Marlin candidates yet. Re-run materialization or evaluate why those projects lack Marlin-derived peak coverage before changing defaults.":
        return "評価済みプロジェクトの一部はまだMarlin候補ではありません。既定設定を変える前に、再マテリアライズするか、Marlin由来ピークの不足理由を確認してください。"
    case "Marlin candidates must cover interview/dialogue, music/beat-sync, and documentary/growth projects before changing the default temporal VLM policy.":
        return "時間理解VLMの既定ポリシーを変える前に、インタビュー/会話、音楽/ビート同期、ドキュメンタリー/成長ストーリーをMarlin候補で網羅してください。"
    case "Marlin artifacts exist, but no evaluated project has enough Marlin-derived segment peak evidence to justify a default preference.":
        return "Marlin成果物はありますが、既定で優先するほどのMarlin由来セグメントピーク根拠を持つ評価済みプロジェクトがありません。"
    case "Run Marlin evaluation on representative interview and music-video footage before deciding whether Marlin-2B should become preferred.":
        return "Marlin-2Bを優先するか判断する前に、代表的なインタビュー素材とミュージックビデオ素材でMarlin評価を実行してください。"
    case "Create or import projects, then run Marlin evaluation before making a default preference decision.":
        return "既定の優先設定を判断する前に、プロジェクトを作成または読み込み、Marlin評価を実行してください。"
    case "Collect more Marlin evidence and segment peak materialization before changing defaults.":
        return "既定設定を変える前に、Marlin根拠とセグメントピークへの反映をさらに集めてください。"
    case "Review marlin-preference-status before changing the VLM default.":
        return "VLMの既定設定を変える前に marlin-preference-status を確認してください。"
    case "Import or analyze video projects before Marlin preference evaluation.":
        return "Marlin優先設定を評価する前に、映像プロジェクトを読み込むか解析してください。"
    case "Already a Marlin preference candidate; keep this project in the representative set.":
        return "このプロジェクトはMarlin優先候補です。代表セットに残してください。"
    case "No unevaluated ready source files remain for the bounded skip-existing run; relink missing source media before retrying Marlin evaluation.":
        return "skip-existingの範囲内に未評価かつ準備済みの素材は残っていません。Marlin評価を再試行する前に、未接続の元素材を再リンクしてください。"
    case "No unevaluated ready source files remain for the bounded skip-existing run; inspect marlin-status before rerunning completed sources.":
        return "skip-existingの範囲内に未評価かつ準備済みの素材は残っていません。評価済み素材を再実行する前に marlin-status を確認してください。"
    case "Relink source media or build synthetic media before running Marlin evaluation.":
        return "Marlin評価を実行する前に、元素材を再リンクするか仮素材を作成してください。"
    case "Add or link at least one video source; audio-only sources are skipped for Marlin.":
        return "少なくとも1つの映像素材を追加またはリンクしてください。音声のみの素材はMarlin評価ではスキップされます。"
    case "Restore the Marlin evaluation script or project analysis artifacts before evaluation.":
        return "評価の前に、Marlin評価スクリプトまたはプロジェクト解析成果物を復旧してください。"
    case "Run live Marlin evaluation on the representative queue.":
        return "代表キューでライブMarlin評価を実行してください。"
    case "Run a live Marlin evaluation on the next representative project.":
        return "次の代表プロジェクトでライブMarlin評価を実行してください。"
    case "Verify the HF_TOKEN belongs to an account with accepted NemoStation/Marlin-2B gated model access.":
        return "HF_TOKENが、NemoStation/Marlin-2Bのゲート付きモデルアクセスを承認済みのアカウントに紐づいているか確認してください。"
    case "Export the editor packet before handoff verification.":
        return "受け渡し検証の前に、編集者パケットを書き出してください。"
    case "Tests whether temporal semantics help testimonial, interview, and speaker-driven edits.":
        return "参加者の声、インタビュー、話者中心の編集で時間理解が有効かを確認します。"
    case "Tests whether Marlin moments can support MV-like action, BGM, and beat-synced rough cuts.":
        return "MV的な動き、BGM、ビート同期の粗編集にMarlinモーメントが使えるかを確認します。"
    case "Tests whether Marlin improves chronological, emotional, and observational story arcs.":
        return "時系列、感情、観察型のストーリー構成でMarlinが改善につながるかを確認します。"
    case "Apply the review patch, then run Review again before render.":
        return "レビュー修正を反映し、書き出し前にもう一度レビューを実行してください。"
    case "Address review weaknesses, recompile, then run Review again.":
        return "レビューで指摘された弱点を直し、再生成してからもう一度レビューしてください。"
    case "Compile the rough cut before review or render.":
        return "レビューまたは書き出しの前に、粗編集を生成してください。"
    case "Run Review with Codex to generate review_report.yaml and review_patch.json.":
        return "Codexレビューを実行し、review_report.yaml と review_patch.json を作成してください。"
    case "Read current project gate state and report the next safe action.":
        return "現在のプロジェクトゲートを読み取り、次に安全な操作を報告します。"
    case "Run schema validation and report violations without changing artifacts.":
        return "成果物を変更せずにスキーマ検証を実行し、違反を報告します。"
    case "Draft a selected-clip editor note from timeline, transcript, Marlin, and audio evidence without writing files.":
        return "ファイルを書き込まず、タイムライン、文字起こし、Marlin、音声根拠から選択クリップの編集者メモ案を作成します。"
    case "Select candidate segments from analyzed material and write selects only.":
        return "解析済み素材から候補セグメントを選び、候補選定成果物だけを書き込みます。"
    case "Design the rough-cut structure from selected candidates and write blueprint artifacts only.":
        return "選定候補から粗編集の構成を設計し、構成案成果物だけを書き込みます。"
    case "Run the deterministic compiler after Codex confirms gates and planned writes.":
        return "Codexがゲートと書き込み計画を確認した後、決定的コンパイラを実行します。"
    case "Run review against an existing compiled timeline and emit review artifacts only.":
        return "既存の生成済みタイムラインをレビューし、レビュー成果物だけを書き込みます。"
    case "Run final render/package after approval and emit package/output artifacts only.":
        return "承認後に最終レンダー/パッケージを実行し、パッケージと出力成果物だけを書き込みます。"
    case "Run analysis before source-map management.":
        return "素材対応表を管理する前に、素材解析を実行してください。"
    case "Relink missing media to create a durable source_map.json for preview, render, and editor handoff.":
        return "プレビュー、書き出し、編集者への受け渡しで使えるように、未リンク素材を再接続して source_map.json を作成してください。"
    case "Relink the missing assets so every analyzed asset has a source-map entry.":
        return "すべての解析済み素材に対応表の項目ができるよう、足りない素材を再接続してください。"
    case "Fix or relink broken source-map entries before render or editor handoff.":
        return "書き出しや編集者への受け渡しの前に、切れている素材対応表の参照を修正または再接続してください。"
    case "Source map covers every analyzed asset and all mapped sources are reachable.":
        return "解析済み素材はすべて素材対応表で網羅され、対応する素材ファイルにも到達できます。"
    case "Run analysis to create assets, segments, transcripts, and searchable project evidence.":
        return "素材解析を実行し、素材、セグメント、文字起こし、検索可能な根拠を作成してください。"
    case "Relink missing source media or add a source map before native preview and handoff.":
        return "ネイティブプレビューや受け渡しの前に、未リンク素材を再接続するか素材対応表を追加してください。"
    case "Build preview proxies so unsupported source media can play in the native viewer.":
        return "ネイティブViewerで再生しにくい素材のために、プレビュープロキシを作成してください。"
    case "Rebuild the SQLite project index so Codex turns can use material search/RAG context.":
        return "Codexが素材検索/RAG文脈を使えるように、SQLiteプロジェクトインデックスを再構築してください。"
    case "Run segment analysis before compile or clip-level agent work.":
        return "粗編集生成やクリップ単位のエージェント作業の前に、セグメント解析を実行してください。"
    case "Library evidence is ready; compile a rough cut from the current brief and selects.":
        return "素材根拠は準備済みです。現在の編集意図と候補から粗編集を生成してください。"
    case "Library, media preview, RAG cache, and timeline are ready for review, render, or editor handoff.":
        return "素材ライブラリ、プレビュー、RAGキャッシュ、タイムラインはレビュー、書き出し、編集者への受け渡しに使える状態です。"
    default:
        return text
    }
}

func localizedMarlinRepresentativeBucketLabel(_ label: String) -> String {
    switch label {
    case "Interview / dialogue":
        return "インタビュー / 会話"
    case "Music / beat-sync":
        return "音楽 / ビート同期"
    case "Documentary / growth story":
        return "ドキュメンタリー / 成長ストーリー"
    default:
        return label
    }
}

func localizedMarlinPolicyMode(_ mode: String) -> String {
    switch mode {
    case "hybrid":
        return "ハイブリッド"
    case "primary":
        return "主系統"
    case "marlin_first":
        return "Marlin優先"
    case "vlm_first":
        return "既存VLM優先"
    case "disabled":
        return "無効"
    default:
        return localizedStudioLabel(mode)
    }
}

func localizedRAGCoverageLabel(_ label: String) -> String {
    if label == "missing" {
        return "なし"
    }
    if label.hasSuffix(" docs") {
        let count = label.replacingOccurrences(of: " docs", with: "")
        return "\(count)件"
    }
    return label
}

func localizedTimelineMarkerLabel(_ label: String) -> String {
    if label == "marker" {
        return "マーカー"
    }
    if let separator = label.range(of: ": ") {
        let prefix = String(label[..<separator.lowerBound])
        let suffix = String(label[separator.upperBound...])
        return "\(prefix): \(localizedTimelineFreeText(suffix))"
    }
    return localizedTimelineFreeText(label)
}

func localizedTimelineMarkerKind(_ kind: String) -> String {
    switch kind {
    case "beat":
        return "テンポ"
    case "note":
        return "メモ"
    case "warning":
        return "注意"
    case "chapter":
        return "章"
    case "marker":
        return "マーカー"
    default:
        return localizedTimelineFreeText(kind)
    }
}

func localizedTimelineAudioCueKind(_ kind: TimelineAudioCue.Kind) -> String {
    switch kind {
    case .audioEvent:
        return "音声イベント"
    case .audioStory:
        return "音声ストーリー"
    case .bgmBeat:
        return "BGMビート"
    case .bgmDownbeat:
        return "BGM頭拍"
    case .bgmSection:
        return "BGMセクション"
    }
}

func localizedTimelineFreeText(_ text: String) -> String {
    let replacements: [(String, String)] = [
        ("original clip audio", "元クリップ音声"),
        ("talking head", "話者正面カット"),
        ("testimonial", "証言"),
        ("audio-story", "音声ストーリー"),
        ("utterance", "発話"),
        ("payoff", "回収"),
        ("beat-sync", "ビート同期"),
        ("beat synced", "ビート同期"),
        ("beat-synced", "ビート同期"),
        ("cutaway", "差し込み"),
        ("導入が hook として", "導入として"),
        ("hook", "導入"),
        ("value", "価値訴求"),
        ("breakthrough", "転機"),
        ("application", "活用"),
        ("conviction", "確信"),
        ("warmth", "温かさ"),
        ("quiet", "静けさ")
    ]

    return replacements.reduce(text) { result, replacement in
        result.replacingOccurrences(of: replacement.0, with: replacement.1)
    }
}

private func localizedMarlinDynamicText(_ text: String) -> String? {
    if text.hasPrefix("Some evaluated projects are blocked by missing source media: "),
       text.hasSuffix(". Relink those media roots or mount the original source volume before changing defaults.") {
        let projectList = text
            .replacingOccurrences(of: "Some evaluated projects are blocked by missing source media: ", with: "")
            .replacingOccurrences(of: ". Relink those media roots or mount the original source volume before changing defaults.", with: "")
        let localizedList = projectList.replacingOccurrences(of: " missing", with: "件未接続")
        return "評価済みプロジェクトの一部は元素材の未接続で停止しています: \(localizedList)。既定設定を変える前に、素材ルートを再リンクするか元素材ボリュームをマウントしてください。"
    }

    if text.hasPrefix("At least "),
       text.hasSuffix(" representative projects should be Marlin candidates before changing the default temporal VLM policy.") {
        let count = text
            .replacingOccurrences(of: "At least ", with: "")
            .replacingOccurrences(of: " representative projects should be Marlin candidates before changing the default temporal VLM policy.", with: "")
        return "時間理解VLMの既定ポリシーを変える前に、少なくとも\(count)件の代表プロジェクトをMarlin候補にしてください。"
    }

    if text.hasPrefix("Import or relink a "),
       text.hasSuffix(" project before promoting Marlin-2B.") {
        let label = text
            .replacingOccurrences(of: "Import or relink a ", with: "")
            .replacingOccurrences(of: " project before promoting Marlin-2B.", with: "")
        return "Marlin-2Bを優先にする前に、\(localizedMarlinRepresentativeBucketLabel(label))プロジェクトを読み込むか再リンクしてください。"
    }

    if text.hasPrefix("Run marlin-eval-run "),
       text.contains(" to collect evidence for "),
       text.hasSuffix(".") {
        let remainder = text.replacingOccurrences(of: "Run marlin-eval-run ", with: "")
        let parts = remainder.components(separatedBy: " to collect evidence for ")
        if parts.count == 2 {
            let projectID = parts[0]
            let tagLabel = parts[1].trimmingCharacters(in: CharacterSet(charactersIn: "."))
            return "\(projectID) で marlin-eval-run を実行し、\(localizedMarlinTagLabel(tagLabel))の根拠を収集してください。"
        }
    }

    if text.hasPrefix("Relink media for "),
       text.hasSuffix(" so bounded skip-existing Marlin evaluation can continue.") {
        let projectID = text
            .replacingOccurrences(of: "Relink media for ", with: "")
            .replacingOccurrences(of: " so bounded skip-existing Marlin evaluation can continue.", with: "")
        return "\(projectID) の素材を再リンクし、skip-existing付きMarlin評価を続行できるようにしてください。"
    }

    if text.hasPrefix("Run marlin-materialize "),
       text.hasSuffix(" so existing Marlin events affect segment peaks.") {
        let projectID = text
            .replacingOccurrences(of: "Run marlin-materialize ", with: "")
            .replacingOccurrences(of: " so existing Marlin events affect segment peaks.", with: "")
        return "\(projectID) で marlin-materialize を実行し、既存のMarlinイベントをセグメントピークに反映してください。"
    }

    if text.hasPrefix("Run marlin-eval-run "),
       text.hasSuffix(" to start representative Marlin evaluation.") {
        let projectID = text
            .replacingOccurrences(of: "Run marlin-eval-run ", with: "")
            .replacingOccurrences(of: " to start representative Marlin evaluation.", with: "")
        return "\(projectID) で marlin-eval-run を実行し、代表Marlin評価を開始してください。"
    }

    if text.hasPrefix("Run marlin-materialize "),
       text.hasSuffix(" to materialize existing Marlin events into segment peaks and refresh search.") {
        let projectID = text
            .replacingOccurrences(of: "Run marlin-materialize ", with: "")
            .replacingOccurrences(of: " to materialize existing Marlin events into segment peaks and refresh search.", with: "")
        return "\(projectID) で marlin-materialize を実行し、既存のMarlinイベントをセグメントピークへ反映して検索を更新してください。"
    }

    if text.hasPrefix("Run marlin-eval-run "),
       text.hasSuffix(" to collect temporal semantic evidence for this project.") {
        let projectID = text
            .replacingOccurrences(of: "Run marlin-eval-run ", with: "")
            .replacingOccurrences(of: " to collect temporal semantic evidence for this project.", with: "")
        return "\(projectID) で marlin-eval-run を実行し、このプロジェクトの時間理解根拠を収集してください。"
    }

    if text.hasPrefix("Relink media for "),
       text.hasSuffix(" so Marlin can evaluate real footage.") {
        let projectID = text
            .replacingOccurrences(of: "Relink media for ", with: "")
            .replacingOccurrences(of: " so Marlin can evaluate real footage.", with: "")
        return "\(projectID) の素材を再リンクし、Marlinが実素材を評価できるようにしてください。"
    }

    if text.hasSuffix(" is a candidate; evaluate another representative project before changing defaults.") {
        let projectID = text.replacingOccurrences(of: " is a candidate; evaluate another representative project before changing defaults.", with: "")
        return "\(projectID) は候補です。既定設定を変える前に、別の代表プロジェクトも評価してください。"
    }

    return nil
}

private func localizedMarlinTagLabel(_ label: String) -> String {
    label
        .components(separatedBy: ", ")
        .map { tag in
            switch tag {
            case "interview-dialogue":
                return "インタビュー/会話"
            case "music-beat":
                return "音楽/ビート同期"
            case "documentary-growth":
                return "ドキュメンタリー/成長ストーリー"
            case "general-footage":
                return "一般素材"
            default:
                return tag
            }
        }
        .joined(separator: "、")
}

func localizedStudioStatusText(_ text: String) -> String {
    if text.hasPrefix("Marlin evaluation is not runnable: ") {
        return localizedStatusLine(
            text,
            rawPrefix: "Marlin evaluation is not runnable: ",
            localizedPrefix: "Marlin評価はまだ実行できません: "
        )
    }
    if text.hasPrefix("Marlin live runtime is not ready: ") {
        return localizedStatusLine(
            text,
            rawPrefix: "Marlin live runtime is not ready: ",
            localizedPrefix: "Marlin実行環境はまだ準備できていません: "
        )
    }
    if text.hasPrefix("Marlin model access is not ready: ") {
        return localizedStatusLine(
            text,
            rawPrefix: "Marlin model access is not ready: ",
            localizedPrefix: "Marlinモデルへまだアクセスできません: "
        )
    }
    if text.hasPrefix("Ready to evaluate ") {
        return text
            .replacingOccurrences(of: "Ready to evaluate ", with: "評価準備完了: ")
            .replacingOccurrences(of: " source files.", with: "素材")
    }
    if text.hasPrefix("Running Marlin evaluation for ") {
        return text
            .replacingOccurrences(of: "Running Marlin evaluation for ", with: "Marlin評価を実行中: ")
            .replacingOccurrences(of: " source files...", with: "素材...")
    }
    if text.hasPrefix("Marlin evaluation completed and refreshed ") {
        return text
            .replacingOccurrences(of: "Marlin evaluation completed and refreshed ", with: "Marlin評価が完了し、")
            .replacingOccurrences(of: " search documents.", with: "件の検索ドキュメントを更新しました。")
    }
    if text.contains(": ") {
        let parts = text.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        if parts.count == 2 {
            let prefix = String(parts[0])
            let suffix = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
            let punctuation = suffix.hasSuffix("。") ? "。" : (suffix.hasSuffix(".") ? "." : "")
            let strippedSuffix = suffix.trimmingCharacters(in: CharacterSet(charactersIn: "。."))
            let localizedSuffix = localizedStudioLabel(strippedSuffix)
            if localizedSuffix != strippedSuffix {
                return "\(localizedStudioStatusPrefix(prefix)): \(localizedSuffix)\(punctuation)"
            }
        }
    }
    return text
}

private func localizedStatusLine(_ text: String, rawPrefix: String, localizedPrefix: String) -> String {
    let remainder = text.replacingOccurrences(of: rawPrefix, with: "")
    let firstSentence = remainder.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
    guard let first = firstSentence.first else {
        return localizedPrefix.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    let status = String(first).trimmingCharacters(in: .whitespacesAndNewlines)
    let localizedStatus = localizedStudioLabel(status)
    if firstSentence.count > 1 {
        let rest = String(firstSentence[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        return rest.isEmpty ? "\(localizedPrefix)\(localizedStatus)." : "\(localizedPrefix)\(localizedStatus). \(localizedStudioText(rest))"
    }
    return "\(localizedPrefix)\(localizedStatus)"
}

private func localizedStudioStatusPrefix(_ prefix: String) -> String {
    switch prefix {
    case "Compile is not runnable", "Studio patch compile is not runnable":
        return "粗編集生成はまだ実行できません"
    case "Render is not runnable":
        return "書き出しはまだ実行できません"
    case "Audio story graph is not runnable":
        return "音声ストーリーはまだ構築できません"
    case "Marlin materialization is not runnable":
        return "Marlinセグメント反映はまだ実行できません"
    default:
        return prefix
    }
}
