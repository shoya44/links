// キャッシュ名。index.html などを更新したら必ず末尾のバージョンを上げること
// （同じ名前のままだと古いキャッシュがヒットし続け、新しい内容が届かない）。
const CACHE_NAME = 'link-launcher-v6';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// install: オフラインで使うファイルを先読みキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// activate: 古いバージョンのキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // 同一オリジンのGETだけを扱う（外部サイトや画像はブラウザにそのまま任せる）
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // ページ本体はネットワーク優先（常に最新を表示）。オフライン時はキャッシュのindex.htmlを返す。
    // cache:'no-cache' でブラウザのHTTPキャッシュを必ず再検証し、古いindex.htmlが居座るのを防ぐ
    event.respondWith(fetchAndCache(request, { cache: 'no-cache' }).catch(() => caches.match('./index.html')));
    return;
  }
  // それ以外（manifest等）はキャッシュ優先、無ければ取得してキャッシュに追加
  event.respondWith(caches.match(request).then((cached) => cached || fetchAndCache(request)));
});
