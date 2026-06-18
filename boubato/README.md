# 棒バトトピックサイト

ニコニコ・YouTube・Twitter(X) の「棒人間バトル（棒バト）」の話題を **1日2回自動更新** でまとめる静的トピックサイト。

- フロント: `docs/`（HTML/CSS/JS のみ。GitHub Pages で公開）
- データ収集: `boubato/scraper.py` → `docs/data/topics.json` を生成
- 自動更新: `.github/workflows/update-boubato-topics.yml`（cron で1日2回）

## データソース

| ソース | 取得方法 | 状態 |
|--------|----------|------|
| ニコニコ動画 | スナップショット検索API v2（`棒バトランキングYYYY` タグ, 2021〜今年） | ✅ 稼働（キー不要） |
| YouTube | YouTube Data API v3（キーワード検索） | ⚙️ `YOUTUBE_API_KEY` 設定で有効化 |
| Twitter (X) | 公式APIが有料のため自動取得は未対応。検索リンクのみ表示 | 🔜 後で差し替え可能 |

## ローカルで実行

```bash
pip install -r boubato/requirements.txt

# ニコニコのみ
python boubato/scraper.py

# YouTubeも含める場合（Windows PowerShell）
$env:YOUTUBE_API_KEY="あなたのキー"; python boubato/scraper.py
# (bash) YOUTUBE_API_KEY=あなたのキー python boubato/scraper.py
```

サイトの確認（`fetch` を使うため http サーバー経由が必要）:

```bash
python -m http.server 8765 --directory docs
# → http://localhost:8765
```

## 公開手順（GitHub Pages）

1. このリポジトリを GitHub に push。
2. **Settings → Pages** で「Build and deployment」を **Deploy from a branch** にし、
   ブランチ `main` / フォルダ `/docs` を選択して保存。
3. 数分後 `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開される。

## YouTube連携を有効にする

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクト作成。
2. 「YouTube Data API v3」を有効化。
3. 「認証情報 → APIキーを作成」でキーを取得。
4. GitHub の **Settings → Secrets and variables → Actions → New repository secret** で
   名前 `YOUTUBE_API_KEY`、値に取得したキーを登録。
5. 次回の自動更新（または Actions タブから手動実行）で YouTube が表示される。

> 無料枠は1日10,000ユニット。本スクリプトは検索3クエリ×2回/日で約600ユニットと十分収まります。

## 自動更新スケジュール

`.github/workflows/update-boubato-topics.yml` の cron:

- `0 22 * * *`（UTC）= JST 07:00
- `0 10 * * *`（UTC）= JST 19:00

変更したい場合はこの cron を編集してください。Actions タブの「Run workflow」で手動実行も可能。

## 既知の注意点

- ニコニコのスナップショットAPIは **同一IPからの過度なアクセスを制限** します。スクリプトは各リクエスト間に待機を入れています。
- 実行環境のIP（クラウド等）が稀にニコニコ側 CloudFront にブロックされ取得0件になることがあります。その場合 `scraper.py` は **前回の `topics.json` を温存** し、空データでの上書きを防ぎます。GitHub Actions で継続的に0件になる場合は、JP回線のローカルPC（Windowsタスクスケジューラ等）での実行に切り替えてください。
- ニコニコの検索インデックスは毎日 AM5:00 に更新されます。

## Twitter(X) を後から追加するには

`scraper.py` の `fetch_twitter()` を、X API v2（有料）や代替手段の取得処理に差し替え、
`items` に `{title, url, ...}` を詰めてください。フロント側（`app.js` の `renderTwitter`）は
`twitter.enabled` を見て表示を切り替えられる作りになっています。
