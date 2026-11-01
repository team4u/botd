// 兼容文件：早期版本注册过 sw.js（cache-first 导致前端更新不生效）。
// 已注册的旧 SW 每次更新会重新拉取本文件；本文件唯一职责是清空缓存并自注销。
// 若浏览器从未注册过 SW，此文件永远不会被加载。
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll())
      .then((clients) => clients.forEach((c) => c.navigate(c.url)))
  );
});
