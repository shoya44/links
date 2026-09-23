# links コードガイド

`links` はフレームワークを使わず、`index.html` 1枚に HTML・CSS・JSを内包したPWA（Progressive Web App）です。
このガイドは、このリポジトリを初めて読む人が「どこから読めばいいか」「なぜこう書かれているか」をつかめるように、実際のコードを引用しながら解説します。

対象ファイル: `index.html` / `service-worker.js` / `manifest.json`（2026年9月時点の実装）

## 目次

1. [全体像](#1-全体像--アーキテクチャ)
2. [処理の流れ](#2-処理の流れ--状態遷移)
3. [PWAの実装](#3-pwaの実装)
4. [iOSの制約](#4-iosの制約)
5. [IndexedDBの仕様](#5-indexeddbの仕様)
6. [よく使う記法](#6-よく使う記法)

---

## 1. 全体像 ― アーキテクチャ

links はビルド工程を持ちません。`index.html` をブラウザが直接読み込み、中のJavaScriptが起動時に **IndexedDB**（データの保存先）と **Service Worker**（オフライン対応の仕組み）をそれぞれ準備します。

```mermaid
flowchart LR
    GH["GitHub Pages<br/>（静的ファイル配信）"] -- "①配信" --> APP

    subgraph Browser["ブラウザ（タブ）"]
        APP["index.html<br/>HTML+CSS+JS<br/>（アプリ本体）"]
        MANIFEST["manifest.json"]
        IDB[("IndexedDB<br/>link-launcher")]
        SW["Service Worker<br/>service-worker.js<br/>（fetchを中継）"]
        CACHE[("Cache Storage<br/>CACHE_NAME")]
    end

    APP -- "&lt;link rel=manifest&gt;" --> MANIFEST
    MANIFEST -- "追加時にOSが読む" --> HOME["ホーム画面アイコン"]
    APP -- "②register()" --> SW
    SW -- "installでcache.addAll" --> CACHE
    SW -- "③fetchを中継（オンライン時）" --> NET["ネットワーク"]
    APP -- "④CRUD（Promiseでラップ）" --> IDB
```

ポイントは、**ビルドサーバーもバックエンドAPIも存在しない**ことです。「アプリのロジック」「見た目」「データの保存」「オフライン対応」の4つが、すべてブラウザというひとつの実行環境の中で完結しています。これは README にある「シンプルさ最優先」というコンセプトそのものの現れです。

---

## 2. 処理の流れ ― 状態遷移

links の画面は「通常モード（リンクをタップして開く）」と「編集モード（追加・削除・並び替え・保存）」の2つしかありません。グローバル変数 `links`（保存済みの配列）と `editModeItems`（編集中の作業コピー）の2つの配列が、この状態遷移の主役です。

```mermaid
flowchart TD
    A["① アプリ起動<br/>openDB() → getAllLinks()"] --> B

    B["② 通常モード<br/>renderNormalMode()"] -- "Editタップ" --> C

    C["③ 編集モード<br/>showEditMode()<br/>追加・削除・並び替え・貼り付け・Import"]
    C -- "Cancel（未保存なら確認して破棄）" --> B
    C -- "Saveタップ" --> D{"URLが有効で<br/>重複なし?"}

    D -- "No" --> E["該当URL欄を赤枠表示<br/>保存を中断（編集モードのまま）"]
    E --> C

    D -- "Yes" --> F["Titleが空欄なら<br/>ホスト名を補完<br/>defaultTitleFromUrl()"]
    F --> G["IndexedDBへ反映<br/>replaceAllLinks()<br/>（clear→全件put）"]
    G -- "renderNormalMode()" --> B
```

編集モードに入ると `links` 配列を丸ごとコピーして `editModeItems` を作ります（`editModeItems=links.map(l=>({...l}))`）。編集中の操作はすべてこのコピーの上で行われるため、**Cancelを押せば何も保存せずに元へ戻せます**（未保存の変更がある場合は `hasUnsavedChanges()` で検知して確認ダイアログを出します）。Saveが押されたときだけ、`editModeItems` を検証してIndexedDBに反映します。

```js
// index.html — 初期化処理（アプリ起動時に一度だけ実行される）
(async()=>{
  try{
    await openDB();
    links=await getAllLinks()
  }catch(err){
    console.error('Failed to open IndexedDB',err)
  }
  renderNormalMode();
  registerServiceWorker()   // load済みなら即時、まだなら load 時に register()
})();
```

---

## 3. PWAの実装

PWAは特別なフレームワークではなく、**3つの決まりごと**を満たしたWebサイトです。links ではそれぞれ次のファイル・記述が対応します。

| 要件 | 実装場所 | 役割 |
|---|---|---|
| Webアプリマニフェスト | `manifest.json` + `<link rel="manifest">` | アプリ名・アイコン・起動時の見た目をOSに伝える |
| Service Worker | `service-worker.js` + `register()` | オフラインでも起動できるようにする |
| HTTPS配信 | GitHub Pages | Service Workerはhttps（またはlocalhost）でしか動かない |

### manifest.json

```json
{
  "name": "links",
  "short_name": "links",      // ホーム画面アイコン下の文字
  "start_url": "./",          // アイコンタップ時に開くURL
  "display": "standalone",    // ブラウザUIを消し、アプリ風に表示
  "background_color": "#0a0a0f",
  "theme_color": "#0a0a0f",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

`display:"standalone"` が「Safariのアドレスバーなしで、アプリのように起動する」ための鍵です。

### Service Worker のライフサイクル

Service Workerは「install → activate → fetch」という3つのイベントで動く、**ページとは別スレッドで動く常駐スクリプト**です。links の実装はこの3つに素直に対応しています。

```js
// service-worker.js
const CACHE_NAME = 'link-launcher-v6';
const STATIC_ASSETS = ['./', './index.html', './manifest.json'];

// ① install: 初回登録時。オフラインで使うファイルを先読みキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ② activate: 新バージョン適用時。古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ネットワークから取得できたら、次回のオフライン起動に備えてキャッシュも更新する
async function fetchAndCache(request, init) {
  const response = await fetch(request, init);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

// ③ fetch: 同一オリジンのGET通信をこの関数が「横取り」する
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // ページ本体はネットワーク優先（HTTPキャッシュも再検証）。失敗したらキャッシュのindex.htmlを返す
    event.respondWith(fetchAndCache(request, { cache: 'no-cache' }).catch(() => caches.match('./index.html')));
    return;
  }
  // それ以外（manifest等）はキャッシュ優先、無ければ取得してキャッシュに追加
  event.respondWith(caches.match(request).then((cached) => cached || fetchAndCache(request)));
});
```

> **キャッシュ更新のお作法：** ファイルを書き換えたら `CACHE_NAME` の末尾（v6→v7など）を上げること。ページ本体（`index.html`）はネットワーク優先なのでオンラインなら更新が届くが、オフライン用のキャッシュと `manifest.json` はこの名前で世代管理しているため、古い世代を確実に捨てるには名前を変える必要がある。

---

## 4. iOSの制約

links の実装には、iOS Safari特有の癖に対応するためだけに存在するコードが多くあります。これらを知らずに読むと「なぜこんな回りくどいことを」と感じる箇所も、理由がわかれば納得できます。

| 制約 | 内容 | 対応コード |
|---|---|---|
| DnD非対応 | iOS SafariはHTML標準のDrag&Drop APIをタッチ操作向けにきちんとサポートしていない | `pointerdown/pointermove/pointerup` を自前で処理する実装（`attachDragHandle`）に置き換え |
| キーボード | URL入力時に先頭が自動で大文字になったり、自動修正で書き換えられたりする | URL欄に `inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false"`、`enterkeyhint` で「次へ」「完了」を出す |
| ズーム | 意図しない拡大・縮小が起きやすい | `user-scalable=no` + `gesturestart`/`dblclick` を `preventDefault()` |
| ノッチ | セーフエリアに要素が被る | `env(safe-area-inset-top/bottom)` を `--safe-top`/`--safe-bottom` に取り込む |
| アプリ連携 | アプリスキーム（`googlesheets://`等）が開けたかJSから検知できない | 遷移後1.5秒待ち、`document.visibilityState==='visible'` ならブラウザで開き直すフォールバック |
| ストレージ | 7日間PWAを起動しないと、SafariがIndexedDBとCacheを消す可能性がある | ホーム画面に追加したPWAは比較的安全。念のため編集モードの **Export**（`navigator.share` で共有シートへ）で手動バックアップできる |
| タップ感触 | 長押しメニューやハイライトがネイティブアプリらしくない | `-webkit-tap-highlight-color:transparent` / `-webkit-touch-callout:none` / `touch-action:manipulation` |

```js
// ズーム防止（index.html）
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault());
```

```js
// アプリスキームのフォールバック（index.html openLink()）
const app = GOOGLE_APP_SCHEMES.find(a => url.includes(a.path)); // 例: googlesheets://
window.location.href = url.replace(/^https?:\/\//, app.scheme);
setTimeout(() => {
  if (document.visibilityState === 'visible') {
    window.open(url, '_blank', 'noopener')
  }
}, APP_SCHEME_FALLBACK_MS); // 1500ms
```

---

## 5. IndexedDBの仕様

IndexedDBは、ブラウザに内蔵された「非同期・トランザクション制」のオブジェクトデータベースです。SQLは使わず、JavaScriptのオブジェクトをそのまま保存します。ただしAPIがコールバック形式で古い書き方のため、links では最初にPromiseでラップして、以降は `await` で扱えるようにしています。

### 用語

| 用語 | 意味 |
|---|---|
| オブジェクトストア | SQLでいう「テーブル」。linksでは `links` という1つだけ |
| keyPath | 各レコードの主キーに使うフィールド名。ここでは `id` |
| インデックス | 特定フィールドで高速検索・重複チェックするための索引 |
| トランザクション | 一連の読み書きをまとめる単位。`readonly`/`readwrite` がある |

### データモデル

| フィールド | 型 | 役割 |
|---|---|---|
| `id` | string | 主キー。`generateId()` で自動採番 |
| `url` | string | 一意インデックス（重複URL防止） |
| `title` | string | 空なら保存時にホスト名で補完 |
| `icon` | string | SVGアイコン名 or 画像URL |
| `order` | number | 並び順。インデックス化して高速ソート |

### DBを開いてスキーマを定義

```js
const DB_NAME='link-launcher', DB_VERSION=1, STORE_NAME='links';

function openDB(){
  return new Promise((res,rej)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=e=>{
      // DBが初めて作られる時 / DB_VERSIONを上げた時だけ呼ばれる
      const d=e.target.result;
      const s=d.createObjectStore(STORE_NAME,{keyPath:'id'});
      s.createIndex('url','url',{unique:true}); // URL重複を防ぐ
      s.createIndex('order','order');           // 並び順で引けるように
    };
    req.onsuccess=()=>{db=req.result; res(db)};
    req.onerror=()=>rej(req.error)
  })
}
```

### コールバックAPIをPromiseでラップするパターン

```js
function replaceAllLinks(items){
  return new Promise((res,rej)=>{
    const tx=db.transaction(STORE_NAME,'readwrite');
    const st=tx.objectStore(STORE_NAME);
    st.clear();                   // いったん全消去して…
    items.forEach(it=>st.put(it)); // …編集後の全件を入れ直す（同じトランザクション内）
    tx.oncomplete=()=>res();      // トランザクション全体の完了を待つ
    tx.onerror=()=>rej(tx.error);
    tx.onabort=()=>rej(tx.error)
  })
}
```

この形（`new Promise` で包み、`onsuccess`/`oncomplete` で `resolve`、`onerror` で `reject`）は `openDB` / `getAllLinks` / `replaceAllLinks` の3関数すべてで繰り返し使われています。一度読めば残りは同じパターンです。

保存が「差分のput/delete」ではなく「clear→全件put」なのは、`url` の一意インデックスとの相性のためです。たとえば2件のURLを入れ替えると、差分方式では先にputした方が既存のURLと衝突して `ConstraintError` になります。1トランザクションで clear→put すれば途中で失敗しても丸ごとロールバックされ、データが壊れることもありません。

---

## 6. よく使う記法

links 全体で繰り返し登場する書き方をまとめました。知っておくと読むスピードが上がります。

| 記法 | 例 | 説明 |
|---|---|---|
| アロー関数 + 即時実行 | `(async()=>{ await openDB(); })();` | ページ読み込み直後に一度だけ実行したい初期化処理を、名前を付けずにその場で実行する定番パターン |
| 省略形catch | `try{ return new URL(s); }catch{ return false }` | ES2019以降、`catch(e)`の変数を使わないなら丸ごと省略できる。`isValidUrl()`で多用 |
| オブジェクトのコピー | `editModeItems = links.map(l => ({...l}));` | スプレッド構文で「浅いコピー」を作る。元の配列を書き換えずに編集用コピーを作る |
| 文字列連結でHTML生成 | `li.innerHTML = '<div class="link-icon"></div><span class="link-title"></span>';` | 骨組みだけ`+`連結で作り、ユーザー入力（タイトル・URL）は `textContent` / `.value` プロパティで後から流し込む。属性文字列に埋め込まないので `"` を含む値でも壊れず、XSSにもならない |
| 配列の破壊的操作 | `const [moved]=arr.splice(from,1); arr.splice(to,0,moved);` | `splice`で「取り出して」「差し込む」。並び替えロジックの中心 |
| requestAnimationFrame | `requestAnimationFrame(()=>{ input.focus() });` | DOM追加直後は描画が確定していないことがあるため、次の描画フレームまで待ってから操作する |

### よく使う関数

| 関数 | 役割 |
|---|---|
| `setIcon(container, link)` | `link.icon` に応じて内蔵SVG／画像／既定アイコンを `container` に描画する |
| `isValidUrl(s)` | `new URL()`が例外を投げないかでURLの妥当性を判定 |
| `normalizeUrlInput(s)` | 前後の空白を除き、`http(s)://` が無ければ `https://` を補う |
| `haptic()` | `navigator.vibrate(10)`で短い振動フィードバック |
| `generateId()` | タイムスタンプ+乱数文字列でID採番（衝突をほぼ無視できる簡易実装） |

### アニメーションと transform の落とし穴

`.link-item` / `.edit-item` はフェードイン（`fadeInUp`）で現れますが、`animation-fill-mode` は **`backwards`** にしてあります。`both` や `forwards` にすると、アニメーション終了後も `to` の `transform: translateY(0)` が「アニメーション由来の値」として残り続け、`:active` の縮小やドラッグ中にJSで設定するインラインの `transform` を上書きしてしまいます（CSSのカスケードではアニメーションの値がインラインスタイルより優先されるため）。同じ理由で、`beginDrag()` では全行の `animation` を `none` にしてからドラッグを始めます。

---

このガイドは `index.html` / `service-worker.js` / `manifest.json`（2026年9月時点の実装）を元に作成しています。実際の挙動は各ファイルのソースを一次情報として参照してください。
