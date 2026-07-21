"use strict";

// 마음숲 서비스워커 (release-aware).
//
// F-01(레드팀 W8) 조치: 콘텐츠 JSON 을 network-first(+offline 폴백)로 전환하고,
// 하드코딩 날짜 목록을 제거한다. release marker(/data/<tenant>/release.json)의
// manifestHash 를 무효화 신호로 삼아, publish 승격/철회로 release 가 바뀌면 옛 콘텐츠
// 캐시를 통째로 무효화한다. 이로써 (a) 승인 revision·집계가 online 에서 항상 최신,
// (b) tombstone 후 캐시된 본문이 재노출되지 않으며, (c) precache 밖 날짜도
// 한 번 online 으로 열면 offline 에서 저장된 승인본이 보인다.
//
//   · 앱 셸(html/css/js/폰트/아이콘/라우트) = precache + cache-first (SHELL_VERSION 로 버전)
//   · 콘텐츠(/data/<tenant>/*.json)        = network-first + evict-on-non-OK + offline 폴백
//   · release marker(manifestHash)          = release 변경 시 콘텐츠 캐시 무효화

const SHELL_VERSION = "v6";                     // v4=온보딩·v5=BGM·v6=BGM 모바일재생 개선(2026-07-21).
const SHELL_CACHE = `maumsup-shell-${SHELL_VERSION}`;
const CONTENT_CACHE = "maumsup-content-v3";      // 콘텐츠 network-first 캐시(고정 이름)
const META_CACHE = "maumsup-meta";              // release 포인터 보관(SW 재시작 생존)
const RELEASE_KEY = "https://release.local/current"; // meta 캐시 내 합성 key

// 콘텐츠(승인본) 경로 — 날짜/index/tenant_meta/release 전부 network-first.
const DATA_RE = /^\/maeumsup\/data\/[a-z0-9-]+\/[^/]+\.json$/;
const RELEASE_RE = /^\/maeumsup\/data\/[a-z0-9-]+\/release\.json$/;

// 셸 자산 — 콘텐츠 JSON·날짜는 포함하지 않는다(하드코딩 날짜 제거).
const SHELL_ASSETS = [
  "/maeumsup/",
  "/maeumsup/styles.css",
  "/maeumsup/app.js",
  "/maeumsup/manifest.webmanifest",
  "/maeumsup/icons/icon-192.png",
  "/maeumsup/icons/icon-512.png",
  "/maeumsup/fonts/PretendardVariable.woff2",
  "/maeumsup/fonts/OFL.txt",
  "/maeumsup/oosa/today/",
  "/maeumsup/oosa/lanterns/",
  "/maeumsup/oosa/donation/",
  "/maeumsup/oosa/temple/",
  "/maeumsup/oosa/settings/",
  "/maeumsup/oosa/archive/"
];

// ---------------------------------------------------------------------------
// release 포인터 (manifestHash 기반 무효화)
// ---------------------------------------------------------------------------
async function readReleasePointer() {
  const meta = await caches.open(META_CACHE);
  const hit = await meta.match(RELEASE_KEY);
  if (!hit) return null;
  try { return await hit.json(); } catch { return null; }
}

async function writeReleasePointer(rel) {
  const meta = await caches.open(META_CACHE);
  await meta.put(RELEASE_KEY, new Response(JSON.stringify(rel), { headers: { "Content-Type": "application/json" } }));
}

// release.json 응답으로 포인터를 최신화. release 가 실제로 바뀌면(승격/철회)
// 콘텐츠 캐시를 통째로 무효화한다 — online 은 network-first 로 즉시 재적재된다.
// 첫 포인터 확립(prev 없음)은 무효화하지 않는다(방금 캐시한 현재 콘텐츠 보호).
async function reconcileRelease(response) {
  let rel;
  try { rel = await response.clone().json(); } catch { return; }
  if (!rel || (!rel.releaseId && !rel.manifestHash)) return;
  const prev = await readReleasePointer();
  const changed = !!prev && (prev.releaseId !== rel.releaseId || prev.manifestHash !== rel.manifestHash);
  await writeReleasePointer(rel);
  if (changed) await caches.delete(CONTENT_CACHE);
}

// ---------------------------------------------------------------------------
// install / activate
// ---------------------------------------------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // 옛 셸/콘텐츠 캐시 및 v2 단일 캐시(cache-first 시절) 잔재 제거. meta 는 보존.
    await Promise.all(keys.filter((k) =>
      (k.startsWith("maumsup-shell-") && k !== SHELL_CACHE) ||
      (k.startsWith("maumsup-content-") && k !== CONTENT_CACHE) ||
      k === "maumsup-oosa-v2"
    ).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------
async function networkFirstContent(request, isRelease) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (isRelease) await reconcileRelease(response);
    const cache = await caches.open(CONTENT_CACHE);
    if (response.ok) {
      await cache.put(request, response.clone()); // 최신 승인본 저장(offline 폴백용)
    } else {
      await cache.delete(request);                 // 404/410(철회 등): stale 재노출 차단
    }
    return response;
  } catch (err) {
    // 오프라인: 저장된 승인본으로 폴백. 콘텐츠 캐시 → 전 캐시 순으로 탐색.
    const cache = await caches.open(CONTENT_CACHE);
    const cached = (await cache.match(request)) || (await caches.match(request));
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "offline-unavailable" }), {
      status: 503, headers: { "Content-Type": "application/json" }
    });
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (DATA_RE.test(url.pathname)) {
    event.respondWith(networkFirstContent(event.request, RELEASE_RE.test(url.pathname)));
    return;
  }
  // 셸/내비게이션: cache-first + network 폴백(정적 자산은 SHELL_VERSION 으로 무효화).
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
