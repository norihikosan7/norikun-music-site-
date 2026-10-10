/* のりくんの音楽ひろば ── オフライン保存のしくみ（サービスワーカー）

   このファイルがあると、ページも曲も端末の中に控えておけるので、
   電波がなくても聴けるようになります。
   ページの部品は自動で控えます。曲と表紙は「保存」を押したぶんだけ控えます。 */

const SHELL = "norikun-shell-v2";   // ページの部品（html・js・アイコン）
const MEDIA = "norikun-media-v1";   // 曲と表紙と動画

/* 最初に必ず控えておくもの。1つ失敗しても全体を止めない */
const SHELL_FILES = [
  "./", "./index.html", "./wavedata.js", "./manifest.json",
  "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL && k !== MEDIA).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ページから「保存して」「消して」の指示を受ける */
self.addEventListener("message", e => {
  if(e.data && e.data.type === "skipWaiting") self.skipWaiting();
});

/* 曲の読み込みは「この範囲だけください」という形で来ることがある（とくに iPhone）。
   控えてあるのは丸ごと1本なので、その中から必要な分を切り出して返す。
   これをしないと、保存してあるのに鳴らない、ということが起きる。 */
async function rangeReply(hit, range){
  const buf = await hit.arrayBuffer();
  const total = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(range || "");
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end   = m && m[2] ? parseInt(m[2], 10) : total - 1;
  if(isNaN(start) || start < 0) start = 0;
  if(isNaN(end) || end >= total) end = total - 1;
  if(start > end) start = 0;
  const part = buf.slice(start, end + 1);
  return new Response(part, {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Type": hit.headers.get("Content-Type") || "application/octet-stream",
      "Content-Length": String(part.byteLength),
      "Content-Range": "bytes " + start + "-" + end + "/" + total,
      "Accept-Ranges": "bytes"
    }
  });
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if(req.method !== "GET") return;
  let url;
  try{ url = new URL(req.url); }catch(err){ return; }
  if(url.origin !== location.origin) return;        // 書体などは素通しにする

  /* ページ本体（index.html）は、つながるときは必ず新しいほうを取りに行く。
     こうしないと、作り直しても古い画面が出たままになる。
     曲や表紙は重いので、控えてあるものをそのまま使う。 */
  const isPage = req.mode === "navigate" ||
                 url.pathname.endsWith("/") ||
                 /\.(html|json|webmanifest)$/i.test(url.pathname) ||
                 /wavedata\.js$/i.test(url.pathname);

  if(isPage){
    e.respondWith((async () => {
      try{
        const res = await fetch(req, { cache: "no-store" });
        if(res && res.ok){
          const c = await caches.open(SHELL);
          c.put(url.pathname, res.clone()).catch(() => {});
        }
        return res;
      }catch(err){
        const hit = await caches.match(url.pathname, { ignoreSearch: true })
                 || await caches.match(req, { ignoreSearch: true })
                 || await caches.match("./index.html") || await caches.match("./");
        if(hit) return hit;
        throw err;
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const range = req.headers.get("range");
    const hit = await caches.match(url.pathname, { ignoreSearch: true })
             || await caches.match(req, { ignoreSearch: true });
    if(hit) return range ? rangeReply(hit, range) : hit;

    try{
      const res = await fetch(req);
      /* ページの部品だけ、通りがかりに控えておく（曲は「保存」を押したときだけ） */
      if(res && res.ok && res.status === 200 &&
         (url.pathname.endsWith("/") || /\.(html|js|json|png|webmanifest)$/i.test(url.pathname))){
        const c = await caches.open(SHELL);
        c.put(url.pathname, res.clone()).catch(() => {});
      }
      return res;
    }catch(err){
      /* つながらないとき。ページを開こうとしているなら、控えてあるページを出す */
      if(req.mode === "navigate"){
        const shell = await caches.match("./index.html") || await caches.match("./");
        if(shell) return shell;
      }
      throw err;
    }
  })());
});
