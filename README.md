# links — Quick Link Launcher PWA

## 概要

`links` は、よく使うWebサイトや社内システムへのリンクをワンタップで開くためのPWA（Progressive Web App）です。  
ブラウザのブックマークよりも速く、アプリ感覚でアクセスできることを目的としています。

**コンセプト：**
- ストレスを減らす
- めんどくさいをなくす
- 開くまでの思考と操作を最短にする

## 技術スタック

| 項目 | 選択 | 理由 |
|------|------|------|
| フレームワーク | **なし（素のHTML/CSS/JS）** | シンプルさ最優先。ビルド工程を排除し、保守性を高めるため |
| データ保存 | **IndexedDB** | 端末内に保存。外部DB不要。オフラインでも一覧表示可能 |
| 静的ファイルキャッシュ | **Service Worker + Cache API** | PWAとしてオフライン起動を可能にするため |
| ドラッグ＆ドロップ | **SortableJS**（CDN） | モバイルでも確実に動作する並び替えを実現するため |
| ホスティング | **GitHub Pages** | 無料。静的ファイルのみで十分なため |
| アイコン | **内蔵SVG（Lucide/Feather風）** | 洗練された見た目と、外部依存なしで表示できるため |

## ファイル構成

```

/
├── index.html          # メインアプリ（HTML/CSS/JSを単一ファイルに内包）
├── service-worker.js   # オフラインキャッシュ用Service Worker
├── manifest.json       # PWA設定（アプリ名、アイコン、表示形式）
├── apple-touch-icon.png # iOSホーム画面用アイコン（180x180推奨）
├── icon-192.png        # PWAアイコン（192x192）
├── icon-512.png        # PWAアイコン（512x512）
└── README.md           # 本ドキュメント

```

> **注意：** `index.html` にすべてのCSS/JSを内包しているのは、iPhoneからでも最短でデプロイできるようにするためです。ファイルを分割する場合は、Service Workerのキャッシュリストも更新してください。

## データモデル（IndexedDB）

**データベース名：** `link-launcher`  
**バージョン：** `1`  
**ストア名：** `links`

```js
{
  id: string,          // 自動採番（generateId()）
  url: string,         // 必須。https:// で始まる完全なURL
  title: string,       // 表示用タイトル（空の場合はURLを表示）
  icon: string,        // SVGアイコン名 または 画像URL（デフォルトは 'link'）
  order: number,       // 並び順（0始まり。保存時に連番で振り直し）
  createdAt: number,   // Unix timestamp
  updatedAt: number    // Unix timestamp
}
```

インデックス：

· url（unique）— 重複チェック用
· order — 並び替え用

アイコン仕様：

· icon が SVG_ICONS のキー名（例：'file', 'table'）の場合、内蔵SVGを表示
· icon が http:// または data: で始まる場合は画像として表示（旧データ互換用）
· icon が空または未設定の場合は 'link' SVGアイコンを表示

主要機能の実装詳細

1. Google関連URLの特別処理

目的： 複数アカウントでログインしている場合に、権限エラーを防ぎ、確実に目的のページへアクセスするため。

URLパターン 処理
docs.google.com/spreadsheets googlesheets:// スキームに変換してアプリで開く
docs.google.com/document googledocs:// スキームに変換してアプリで開く
docs.google.com/presentation googleslides:// スキームに変換してアプリで開く
その他のGoogle URL accounts.google.com/AccountChooser を経由してアカウント選択画面を表示

実装上の注意：

· アプリスキームで開いた後、1.5秒後に document.visibilityState === 'visible' の場合のみブラウザでフォールバック表示する
· これはアプリがインストールされていない場合のフォールバックだが、iOSのPWAでは visibilityState が不安定な場合があるため、必要に応じて調整すること

2. SVGアイコンピッカー

· 編集モードでアイコン領域をタップすると、24種類のSVGアイコンから選択できるモーダルが表示される
· SVG_ICONS オブジェクトにアイコン名とSVG文字列を定義
· アイコンを追加する場合は、SVG_ICONS に追記し、ICON_NAMES が自動的に更新される
· 現在選択中のアイコンは青背景でハイライトされる

3. 並び替え（SortableJS）

設定値：

```js
{
  handle: '.drag-handle',
  animation: 300,
  easing: 'cubic-bezier(0.25,0.46,0.45,0.94)',
  forceFallback: false,       // ネイティブDnDを優先
  fallbackTolerance: 3,
  swapThreshold: 0.65,
  delay: 200,                  // 200ms長押しで開始
  delayOnTouchOnly: true,      // タッチのみ遅延
  ghostClass: 'sortable-ghost',
  chosenClass: 'sortable-chosen',
  dragClass: 'sortable-drag'
}
```

UX上の意図：

· 長押し200ms後にドラッグ開始（誤操作防止）
· ドラッグ中のカードは scale(1.03) + 強い影で「浮いている」ように見せる
· animation: 300 とカスタムイージングで滑らかな移動を実現
· ドラッグ開始時に haptic() で触覚フィードバック

4. ズーム・文字列選択の防止

ズーム防止：

· <meta name="viewport" content="..., user-scalable=no, maximum-scale=1.0, minimum-scale=1.0">
· CSS： touch-action: manipulation
· JS： gesturestart と dblclick イベントを preventDefault()

文字列選択防止：

· CSS： user-select: none + -webkit-touch-callout: none（全要素に適用）
· ただし input と textarea には user-select: text を上書きして入力可能にする

5. ヘッダーロゴ

· 左上のテキスト「links」はリンク型SVGロゴに置き換えている
· 通常モード・編集モードの両方に同じロゴを表示
· テキストに戻したい場合は、.header-logo 内のSVGをテキストに置き換える

デプロイ手順（GitHub Pages）

1. GitHubでリポジトリを作成（Public）
2. 上記ファイル構成のすべてのファイルをリポジトリのルートに配置
3. リポジトリの Settings → Pages で、Source を Deploy from a branch、Branch を main、フォルダを / (root) に設定
4. 1〜2分待つと https://<username>.github.io/<repo-name>/ でアクセス可能
5. iPhoneのSafariで開き、「共有」→「ホーム画面に追加」でPWAとしてインストール

注意：

· アイコン画像: apple-touch-icon.png, icon-192.png, icon-512.png
· 画像を差し替える場合は、同じファイル名でルートに配置すれば自動的に反映される
· Service Workerのキャッシュバージョン（CACHE_NAME）は、ファイルを更新するたびに変更すること（例：v4 → v5）

既知の制約と注意点

iOSのPWA制約

· 7日ルール： 7日間PWAを起動しないと、IndexedDBとCacheが削除される可能性がある（ホーム画面に追加したPWAは比較的安全だが、定期的な起動を推奨）
· Googleアカウント選択： AccountChooser は完全には自動化できない。ユーザーがアカウントを選択する必要がある
· アプリスキームのフォールバック： googlesheets:// などのアプリスキームは、アプリがインストールされていない場合に動作しない。フォールバックとしてブラウザで開くが、タイミングによっては正しく動作しない場合がある

外部依存

· SortableJS： CDNから読み込んでいる。Service Workerのキャッシュリストに含まれているため、一度読み込めばオフラインでも動作する
· Google Favicon API： 現在は使用していない（自動ファビコン取得を廃止）。将来復活させる場合は、getFaviconUrl() 関数が残っているので活用できる

開発時の注意

· index.html を編集する際は、GitHubのWebエディタで直接編集するのが最も簡単
· ローカル開発する場合は、任意の静的サーバー（python -m http.server など）で起動できるが、iOSでの動作確認はGitHub Pages経由で行うこと
· IndexedDBのスキーマを変更する場合は、DB_VERSION を上げ、onupgradeneeded に移行処理を追加すること