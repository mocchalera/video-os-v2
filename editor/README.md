# editor/ — Preview Server and Retired Web Client

`editor/` 全体が retired なのではありません。現行責務は次の通りです。

| Path | Status | Supported ownership |
| --- | --- | --- |
| `editor/server` | Current / supported | ローカル exact-preview job、media delivery、timeline/review API、project WebSocket 通知 |
| `editor/shared` | Current / supported | preview と final render の RenderSpec / filtergraph / encode / caption parity contract |
| `editor/client` | **Retired** (2026-07-07, human-approved) | 履歴参照用の旧 React/Vite UI。新機能・通常保守の対象外 |

現行の正式なオペレーターサーフェスは macOS Studio (`apps/macos-studio`) です。タイムライン編集、パッチレビュー、AI 連携 UI は Swift 側へ実装してください。

## Supported preview server

ローカル preview/API server は明示的に起動します。

```sh
npm --prefix editor ci
npm --prefix editor run server -- --project ../projects/<project-id> --port 3100
curl http://localhost:3100/api/health
```

macOS Studio は canonical artifacts を読み、`runtime/` / `scripts/` entrypoint を直接実行します。Studio は `editor/server` を自動起動せず、通常操作で HTTP / WebSocket API に依存しません。したがって server はサポート対象の独立 infrastructure ですが、canonical product runtime や operator UI ではありません。

CI の `editor-server` job は `editor/tsconfig.json` を使って `server/**/*.ts` と `shared/**/*.ts` を typecheck します。preview parity と server security regression は root の Node test job で実行します。retired client の build は required CI に含めません。

## Retired client policy

`editor/client` は 2026-07-06 の全体監査で macOS Studio と約 90% 機能重複の凍結レガシーと判定され、2026-07-07 に人間承認でリタイアしました。既知の未解決 layout issue を含め、新機能・通常の bug fix・依存更新は行いません。削除や再有効化は、この ownership decision とは別の明示的な判断を必要とします。

旧 Web UI の設計資料 (`docs/editor-v3-design.md` など) は historical reference です。現行 UI は `docs/macos-studio-architecture.md` と `apps/macos-studio` の executable sources を正として参照してください。
