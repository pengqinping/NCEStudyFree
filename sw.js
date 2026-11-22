/* NCE StudyFree service worker：离线缓存（壳文件静态清单 + 资源包内容编程式预缓存）。 */
const CACHE = 'nce-study-v8';
const CORE = [
  './',
  './index.html',
  './404.html',
  './css/styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/router.js',
  './js/profiles.js',
  './js/store.js',
  './js/srs.js',
  './js/exercises.js',
  './js/ui.js',
  './js/tts.js',
  './js/recorder.js',
  './js/content/content-id.js',
  './js/content/pack-format.js',
  './js/content/pack-storage.js',
  './js/content/pack-manager.js',
  './js/content/provider.js',
  './js/vendor/fflate.js',
  './js/views/home.js',
  './js/views/book.js',
  './js/views/lesson.js',
  './js/views/review.js',
  './js/views/stats.js',
  './js/views/settings.js',
  './js/views/search.js',
  './data/packs/bundled.json',
  './data/catalog.json',
  './data/packs/nce-core-1-4/manifest.json',
  './data/packs/nce-core-1-4/search-index.json',
  './data/packs/nce-core-1-4/content/book1/book.json',
  './data/packs/nce-core-1-4/content/book2/book.json',
  './data/packs/nce-core-1-4/content/book3/book.json',
  './data/packs/nce-core-1-4/content/book4/book.json',
  './assets/icons/favicon.svg',
  './assets/icons/favicon.ico',
  './assets/icons/favicon-16.png',
  './assets/icons/favicon-32.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      let failed = 0;
      await Promise.all(
        CORE.map(async (url) => {
          try {
            await cache.add(url);
          } catch {
            failed += 1;
          }
        }),
      );

      // 课程资源包内容：按 manifest 编程式预缓存（276 个单元 JSON，约 4MB），
      // 保证与旧版整册数据一致的离线体验；单元文件是按需 fetch 的，必须装进首装缓存
      let packEntries = 0;
      try {
        const bundled = await (await fetch('./data/packs/bundled.json')).json();
        for (const pack of bundled.packs || []) {
          const base = pack.base;
          await cache.add(`${base}/manifest.json`);
          const manifest = await (await fetch(`${base}/manifest.json`)).json();
          await cache.add(`${base}/search-index.json`);
          for (const book of manifest.books || []) {
            // manifest.books[].entry 相对包根，必须拼上 base
            await cache.add(`${base}/${book.entry}`);
            const bookData = await (await fetch(`${base}/${book.entry}`)).json();
            for (const unit of bookData.units || []) {
              await cache.add(
                `${base}/content/book${book.id}/units/u${String(unit.unit).padStart(2, '0')}.json`,
              );
              packEntries += 1;
            }
          }
        }
      } catch (error) {
        console.warn('[sw] 资源包预缓存失败', error);
        failed += 1;
      }

      if (failed) {
        // 安装失败时保留旧缓存，避免用不完整的离线包替换可用版本
        await caches.delete(CACHE);
        throw new Error(`NCE StudyFree: ${failed} 个核心资源缓存失败（${packEntries} 个单元已缓存）`);
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            // 只清理本项目自己的旧缓存，避免影响同源（cencyzp.github.io）其它项目
            .filter((key) => key.startsWith('nce-study-') && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html').then((response) => response || caches.match('./'))),
    );
    return;
  }

  const isData = url.pathname.includes('/data/');
  if (isData) {
    // 课程数据：先给缓存，同时后台更新
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
    return;
  }

  // 静态资源：先给缓存保证离线，同时后台回源更新，下次访问即为新版本
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
