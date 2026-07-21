(() => {
  "use strict";

  // 배포 스테이저(stage_maeumsup.mjs)가 이 한 줄만 `const BASE = "/maeumsup";` 로 치환한다.
  // 앱 내부의 모든 절대경로(데이터 fetch·라우트 링크·SW·오디오)는 BASE 를 접두해 base-무관하게 동작한다.
  const BASE = "/maeumsup";

  const EXPECTED_SCHEMA = "1";              // 콘텐츠/인덱스/릴리스 스키마
  const EXPECTED_TENANT_SCHEMA = "2";       // tenant_meta v2 (다절 포털)
  const EXPECTED_TEMPLES_SCHEMA = "1";      // temples.json 디렉터리
  const APP_NS = "maumsup:v1:_app:";        // 앱 전역 상태(기기)
  const ALL_NS = "maumsup:v1:";             // 전체 기기 데이터 접두(초기화 대상)

  // 절-종속 화면(슬러그 필요) / 앱-전역 화면(슬러그 불필요)
  const TENANT_ROUTES = new Set(["today", "lanterns", "schedule", "news", "temple", "donation", "settings", "archive"]);
  const APP_ROUTES = new Set(["discover"]);
  const BOTTOM_ROUTES = new Set(["today", "lanterns", "schedule"]);   // 하단 네비 핵심(나머지는 더보기)

  let currentSlug = null;                   // 동적 (구 TENANT 하드코딩 제거)
  let temples = [];                         // temples.json (1회 로드 후 메모리 유지)
  const TEMPLE_SLUGS = new Set();

  const screenRoot = document.getElementById("screen-root");
  const loadingState = document.getElementById("loading-state");
  const offlineBanner = document.getElementById("offline-banner");
  const toast = document.getElementById("toast");
  let timerId = null;
  let rolloverDate = getKstDate();
  let toastId = null;

  class ContractError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ContractError";
      this.code = code;
    }
  }

  function node(tag, options = {}) {
    const element = document.createElement(tag);
    if (options.id) element.id = options.id;
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = String(options.text);
    if (options.attrs) {
      for (const [name, value] of Object.entries(options.attrs)) {
        element.setAttribute(name, String(value));
      }
    }
    return element;
  }

  function append(parent, ...children) {
    for (const child of children) if (child) parent.appendChild(child);
    return parent;
  }

  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  // 경로 파싱: BASE 접두를 벗겨 base-무관하게 slug/route 를 뽑는다.
  //   /<slug>/<route>/    (절 화면)     ·   /discover/  (앱 화면)   ·   /  (진입 결정)
  function parseAppPath(pathname) {
    let p = pathname;
    if (BASE && (p === BASE || p.startsWith(BASE + "/"))) p = p.slice(BASE.length) || "/";
    const parts = p.split("/").filter(Boolean);
    if (!parts.length) return { slug: null, route: null };
    if (APP_ROUTES.has(parts[0])) return { slug: null, route: parts[0] };
    if (TEMPLE_SLUGS.has(parts[0])) {
      const r = parts[1];
      return { slug: parts[0], route: TENANT_ROUTES.has(r) ? r : "today" };
    }
    // 알려진 슬러그가 아니지만 절 화면 라우트가 선두면 슬러그 없는 라우트로 간주(진입 결정에서 lastSlug 사용)
    if (TENANT_ROUTES.has(parts[0])) return { slug: null, route: parts[0] };
    // 그 외 선두 세그먼트는 미지의 슬러그 후보(진입 결정에서 유효성 검사 → discover 폴백)
    return { slug: parts[0], route: TENANT_ROUTES.has(parts[1]) ? parts[1] : "today" };
  }

  function getKstDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = {};
    for (const part of parts) values[part.type] = part.value;
    return `${values.year}-${values.month}-${values.day}`;
  }

  function formatKoreanDate(dateString, includeWeekday = true) {
    const [year, month, day] = dateString.split("-").map(Number);
    const value = new Date(Date.UTC(year, month - 1, day, 3));
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "long",
      day: "numeric",
      weekday: includeWeekday ? "long" : undefined
    }).format(value);
  }

  function formatShortDate(dateString) {
    const [, month, day] = dateString.split("-").map(Number);
    return `${month}.${String(day).padStart(2, "0")}`;
  }

  // ---- 저장소 (per-tenant + app-global, 전부 기기 localStorage — 서버 전송 0) ----
  function tenantNS() { return `maumsup:v1:${currentSlug}:`; }

  function rawGet(fullKey) {
    try { return localStorage.getItem(fullKey); }
    catch { return null; }
  }

  function rawSet(fullKey, value) {
    try {
      localStorage.setItem(fullKey, value);
      return true;
    } catch {
      showToast("이 브라우저에서는 기기 저장을 사용할 수 없어요");
      return false;
    }
  }

  function safeGet(key) { return currentSlug ? rawGet(tenantNS() + key) : null; }   // per-tenant (기도기록 등)
  function safeSet(key, value) { return currentSlug ? rawSet(tenantNS() + key, value) : false; }
  function appGet(key) { return rawGet(APP_NS + key); }                              // app-global (글자·BGM·내 절)
  function appSet(key, value) { return rawSet(APP_NS + key, value); }

  // "이 기기 데이터 초기화": 모든 절 + 앱 전역 상태를 통째로 지운다(기기 전용, 전송 없음).
  function clearAllDeviceData() {
    try {
      const keys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && key.startsWith(ALL_NS)) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  function getRitual(date) {
    const raw = safeGet(`ritual:${date}`);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveRitual(date, state) {
    safeSet(`ritual:${date}`, JSON.stringify(state));
  }

  // ---- 내 절(따라가는 절) 앱 전역 상태 ----
  function getMyTemples() {
    const raw = appGet("myTemples");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((slug) => typeof slug === "string" && TEMPLE_SLUGS.has(slug)) : [];
    } catch {
      return [];
    }
  }

  function setMyTemples(list) { appSet("myTemples", JSON.stringify([...new Set(list)])); }
  function isFollowing(slug) { return getMyTemples().includes(slug); }
  function toggleFollow(slug) {
    const list = getMyTemples();
    if (list.includes(slug)) setMyTemples(list.filter((item) => item !== slug));
    else setMyTemples([...list, slug]);
    return isFollowing(slug);
  }

  function applyTextScale(value) {
    const scale = value === "large" ? "large" : "normal";
    document.documentElement.dataset.textScale = scale;
  }

  function showToast(message) {
    clearTimeout(toastId);
    toast.textContent = message;
    toast.hidden = false;
    toastId = setTimeout(() => { toast.hidden = true; }, 2600);
  }

  function showScreen(element) {
    if (timerId) { clearInterval(timerId); timerId = null; }   // 이전 화면(목탁) 타이머 정리 — SPA 전환 중복 방지
    clear(screenRoot);
    screenRoot.appendChild(element);
    loadingState.hidden = true;
  }

  function pageHero(eyebrow, title, copy) {
    const hero = node("header", { className: "page-hero" });
    append(hero,
      node("p", { className: "eyebrow", text: eyebrow }),
      node("h1", { text: title }),
      copy ? node("p", { className: "hero-copy", text: copy }) : null
    );
    return hero;
  }

  function sectionWrap(...children) {
    const wrap = node("div", { className: "section-wrap" });
    append(wrap, ...children);
    return wrap;
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function exactKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
  }

  function isStr(value, min, max) {
    return typeof value === "string" && value.length >= min && value.length <= max;
  }

  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-([12]\d|3[01]|0[1-9])$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function validHttps(value) {
    if (typeof value !== "string" || value.length > 2048 || !value.startsWith("https://")) return false;
    try { return new URL(value).protocol === "https:"; }
    catch { return false; }
  }

  // 참여/연락/결제 URL 계약: 빈 문자열(=링크 없음, 문의 안내) 또는 유효한 https 만 허용.
  // 비-https 값이 들어오면 링크를 열지 않고 계약 위반으로 거부한다(법무 게이트).
  function optionalHttps(value) { return value === undefined || value === "" || validHttps(value); }

  function validSlug(value) {
    return typeof value === "string" && value.length >= 2 && value.length <= 32
      && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value);
  }

  function assertSchemaVersion(value, expected, label) {
    if (!hasOwn(value, "schemaVersion")) throw new ContractError("schema-missing", `${label} schemaVersion 누락`);
    if (value.schemaVersion !== expected) throw new ContractError("schema-mismatch", `${label} schemaVersion 불일치`);
  }

  function validateContent(value, expectedDate) {
    if (!isPlainObject(value)) throw new ContractError("invalid-content", "콘텐츠가 객체가 아닙니다");
    assertSchemaVersion(value, EXPECTED_SCHEMA, "content");
    const allowed = ["schemaVersion", "tenantSlug", "date", "title", "body", "mediaUrl", "revision", "publishedAt"];
    const required = ["tenantSlug", "date", "title", "body", "revision", "publishedAt", "schemaVersion"];
    if (!exactKeys(value, allowed) || !required.every((key) => hasOwn(value, key))) {
      throw new ContractError("invalid-content", "콘텐츠 공개 필드 계약 위반");
    }
    if (value.tenantSlug !== currentSlug || !validSlug(value.tenantSlug)) {
      throw new ContractError("invalid-content", "절 식별자 계약 위반");
    }
    if (!validDate(value.date) || (expectedDate && value.date !== expectedDate)) throw new ContractError("invalid-content", "콘텐츠 날짜 계약 위반");
    if (!isStr(value.title, 1, 120)) throw new ContractError("invalid-content", "콘텐츠 제목 계약 위반");
    if (!isStr(value.body, 1, 5000)) throw new ContractError("invalid-content", "콘텐츠 본문 계약 위반");
    if (!Number.isInteger(value.revision) || value.revision < 1) throw new ContractError("invalid-content", "개정 번호 계약 위반");
    if (typeof value.publishedAt !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-([12]\d|3[01]|0[1-9])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value.publishedAt)) {
      throw new ContractError("invalid-content", "공개 시각 계약 위반");
    }
    if (value.mediaUrl !== undefined && !validHttps(value.mediaUrl)) throw new ContractError("invalid-content", "미디어 주소 계약 위반");
    return value;
  }

  // tenant_meta v2 — 다절 포털 표시 계약. 금액·결제·PG 필드가 끼어들지 못하도록 exactKeys 로 잠근다(법무 게이트).
  function validateTenant(value) {
    if (!isPlainObject(value)) throw new ContractError("invalid-tenant", "절 정보가 객체가 아닙니다");
    assertSchemaVersion(value, EXPECTED_TENANT_SCHEMA, "tenant");
    const allowed = ["schemaVersion", "tenantSlug", "name", "intro", "profile", "schedule", "news", "lantern", "campaigns", "donationInfo", "settings"];
    const required = ["schemaVersion", "tenantSlug", "name", "intro"];
    if (!exactKeys(value, allowed) || !required.every((key) => hasOwn(value, key))) {
      throw new ContractError("invalid-tenant", "절 정보 공개 필드 계약 위반");
    }
    if (value.tenantSlug !== currentSlug || !validSlug(value.tenantSlug)) throw new ContractError("invalid-tenant", "절 식별자 불일치");
    if (!isStr(value.name, 1, 60)) throw new ContractError("invalid-tenant", "절 이름 계약 위반");
    if (!isStr(value.intro, 1, 2000)) throw new ContractError("invalid-tenant", "절 소개 계약 위반");

    if (value.profile !== undefined) {
      const profile = value.profile;
      const profileKeys = ["order", "region", "address", "phone", "directions", "hours", "foundedNote"];
      if (!isPlainObject(profile) || !exactKeys(profile, profileKeys)) throw new ContractError("invalid-tenant", "절 프로필 필드 계약 위반");
      for (const key of profileKeys) if (profile[key] !== undefined && !isStr(profile[key], 0, 600)) throw new ContractError("invalid-tenant", "절 프로필 타입 계약 위반");
    }

    if (value.schedule !== undefined) {
      if (!Array.isArray(value.schedule) || value.schedule.length > 60) throw new ContractError("invalid-tenant", "일정 목록 계약 위반");
      for (const item of value.schedule) {
        if (!isPlainObject(item) || !exactKeys(item, ["id", "kind", "title", "when", "place", "desc", "recurring"])) throw new ContractError("invalid-tenant", "일정 항목 계약 위반");
        if (!isStr(item.id, 1, 60) || !isStr(item.kind, 1, 40) || !isStr(item.title, 1, 120)) throw new ContractError("invalid-tenant", "일정 항목 필드 계약 위반");
        for (const key of ["when", "place", "desc"]) if (item[key] !== undefined && !isStr(item[key], 0, 600)) throw new ContractError("invalid-tenant", "일정 항목 필드 계약 위반");
        if (item.recurring !== undefined && typeof item.recurring !== "boolean") throw new ContractError("invalid-tenant", "일정 반복 타입 계약 위반");
      }
    }

    if (value.news !== undefined) {
      if (!Array.isArray(value.news) || value.news.length > 100) throw new ContractError("invalid-tenant", "소식 목록 계약 위반");
      for (const item of value.news) {
        if (!isPlainObject(item) || !exactKeys(item, ["id", "date", "title", "body"])) throw new ContractError("invalid-tenant", "소식 항목 계약 위반");
        if (!isStr(item.id, 1, 60) || !validDate(item.date) || !isStr(item.title, 1, 120) || !isStr(item.body, 0, 2000)) throw new ContractError("invalid-tenant", "소식 항목 필드 계약 위반");
      }
    }

    if (value.lantern !== undefined) {
      const lantern = value.lantern;
      if (!isPlainObject(lantern) || !exactKeys(lantern, ["notice", "types", "howto", "contactLabel", "contactUrl"])) throw new ContractError("invalid-tenant", "연등 안내 계약 위반");
      for (const key of ["notice", "howto", "contactLabel"]) if (lantern[key] !== undefined && !isStr(lantern[key], 0, 1000)) throw new ContractError("invalid-tenant", "연등 안내 필드 계약 위반");
      if (!optionalHttps(lantern.contactUrl)) throw new ContractError("invalid-tenant", "연등 연락 주소 계약 위반");
      if (lantern.types !== undefined) {
        if (!Array.isArray(lantern.types) || lantern.types.length > 20) throw new ContractError("invalid-tenant", "연등 종류 계약 위반");
        for (const item of lantern.types) {
          if (!isPlainObject(item) || !exactKeys(item, ["name", "desc"]) || !isStr(item.name, 1, 60) || !isStr(item.desc, 0, 400)) throw new ContractError("invalid-tenant", "연등 종류 항목 계약 위반");
        }
      }
    }

    if (value.campaigns !== undefined) {
      if (!Array.isArray(value.campaigns) || value.campaigns.length > 40) throw new ContractError("invalid-tenant", "후원 목록 계약 위반");
      const campaignKeys = ["id", "title", "purpose", "unit", "receiptNote", "progressNote", "goalDisplay", "participateLabel", "participateUrl"];
      for (const item of value.campaigns) {
        if (!isPlainObject(item) || !exactKeys(item, campaignKeys)) throw new ContractError("invalid-tenant", "후원 항목 계약 위반");
        if (!isStr(item.id, 1, 60) || !isStr(item.title, 1, 120)) throw new ContractError("invalid-tenant", "후원 항목 식별 계약 위반");
        for (const key of ["purpose", "unit", "receiptNote", "progressNote", "goalDisplay", "participateLabel"]) if (item[key] !== undefined && !isStr(item[key], 0, 1000)) throw new ContractError("invalid-tenant", "후원 항목 필드 계약 위반");
        if (!optionalHttps(item.participateUrl)) throw new ContractError("invalid-tenant", "후원 참여 주소 계약 위반");
      }
    }

    if (value.donationInfo !== undefined) {
      const info = value.donationInfo;
      if (!isPlainObject(info) || !exactKeys(info, ["payeeName", "notice", "paymentUrl"])) throw new ContractError("invalid-tenant", "시주 안내 필드 계약 위반");
      if (info.payeeName !== undefined && !isStr(info.payeeName, 1, 60)) throw new ContractError("invalid-tenant", "시주 명의 계약 위반");
      if (info.notice !== undefined && !isStr(info.notice, 0, 2000)) throw new ContractError("invalid-tenant", "시주 유의사항 계약 위반");
      if (!optionalHttps(info.paymentUrl)) throw new ContractError("invalid-tenant", "결제 주소 계약 위반");
    }

    if (value.settings !== undefined) {
      const settings = value.settings;
      if (!isPlainObject(settings) || !exactKeys(settings, ["timezone", "lanternEnabled", "donationEnabled"])) throw new ContractError("invalid-tenant", "공개 설정 필드 계약 위반");
      if (settings.timezone !== undefined && settings.timezone !== "Asia/Seoul") throw new ContractError("invalid-tenant", "시간대 계약 위반");
      for (const key of ["lanternEnabled", "donationEnabled"]) if (settings[key] !== undefined && typeof settings[key] !== "boolean") throw new ContractError("invalid-tenant", "공개 설정 타입 계약 위반");
    }
    return value;
  }

  function validateTemples(value) {
    if (!isPlainObject(value)) throw new ContractError("invalid-temples", "사찰 목록이 객체가 아닙니다");
    assertSchemaVersion(value, EXPECTED_TEMPLES_SCHEMA, "temples");
    if (!Array.isArray(value.temples) || value.temples.length < 1 || value.temples.length > 500) throw new ContractError("invalid-temples", "사찰 목록 계약 위반");
    const seen = new Set();
    for (const item of value.temples) {
      if (!isPlainObject(item)) throw new ContractError("invalid-temples", "사찰 항목 계약 위반");
      if (!exactKeys(item, ["slug", "name", "order", "region", "summary", "pilot"]) && !["slug", "name"].every((key) => hasOwn(item, key))) {
        throw new ContractError("invalid-temples", "사찰 항목 필드 계약 위반");
      }
      if (!validSlug(item.slug) || seen.has(item.slug)) throw new ContractError("invalid-temples", "사찰 슬러그 계약 위반");
      seen.add(item.slug);
      if (!isStr(item.name, 1, 60)) throw new ContractError("invalid-temples", "사찰 이름 계약 위반");
      for (const key of ["order", "region", "summary"]) if (item[key] !== undefined && !isStr(item[key], 0, 600)) throw new ContractError("invalid-temples", "사찰 항목 필드 계약 위반");
      if (item.pilot !== undefined && typeof item.pilot !== "boolean") throw new ContractError("invalid-temples", "사찰 파일럿 타입 계약 위반");
    }
    return value.temples;
  }

  async function fetchJson(path) {
    let response;
    try {
      response = await fetch(path, { credentials: "same-origin" });
    } catch {
      throw new ContractError("unavailable", "정적 승인본을 가져오지 못했습니다");
    }
    if (!response.ok) throw new ContractError("missing-json", `승인 JSON 누락: ${response.status}`);
    try { return await response.json(); }
    catch { throw new ContractError("invalid-json", "JSON 형식 오류"); }
  }

  async function loadTemples() {
    if (temples.length) return temples;
    temples = validateTemples(await fetchJson(`${BASE}/data/temples.json`));
    TEMPLE_SLUGS.clear();
    for (const item of temples) TEMPLE_SLUGS.add(item.slug);
    return temples;
  }

  function templeBySlug(slug) { return temples.find((item) => item.slug === slug) || null; }

  async function loadTenant() {
    return validateTenant(await fetchJson(`${BASE}/data/${currentSlug}/tenant_meta.json`));
  }

  async function loadContent(date) {
    return validateContent(await fetchJson(`${BASE}/data/${currentSlug}/${date}.json`), date);
  }

  async function loadIndex() {
    const value = await fetchJson(`${BASE}/data/${currentSlug}/index.json`);
    const allowed = ["schemaVersion", "tenantSlug", "dates", "anonymousLanternCount", "aggregateAsOf"];
    const required = ["schemaVersion", "tenantSlug", "dates"];
    const datesValid = isPlainObject(value)
      && Array.isArray(value.dates)
      && value.dates.every(validDate)
      && new Set(value.dates).size === value.dates.length;
    const aggregateValid = value && (value.aggregateAsOf === undefined || value.aggregateAsOf === null || validDate(value.aggregateAsOf));
    const lanternValid = value && (value.anonymousLanternCount === undefined
      || (Number.isInteger(value.anonymousLanternCount) && value.anonymousLanternCount >= 0));
    if (!isPlainObject(value)
      || !exactKeys(value, allowed)
      || !required.every((key) => hasOwn(value, key))
      || value.schemaVersion !== EXPECTED_SCHEMA
      || value.tenantSlug !== currentSlug
      || !datesValid
      || !aggregateValid
      || !lanternValid) {
      throw new ContractError("invalid-index", "승인 목록 계약 위반");
    }
    return value;
  }

  function renderDataError(error) {
    const section = node("div");
    append(section, pageHero("승인 데이터 확인", "잠시 쉬어 가세요", "검증된 말씀만 보여드리기 위해 이 화면을 멈췄습니다."));
    const card = node("div", { className: "error-card", attrs: { "data-testid": "data-error" } });
    const title = error && (error.code === "schema-mismatch" || error.code === "schema-missing")
      ? "데이터 버전을 확인할 수 없어요"
      : "말씀을 불러오지 못했어요";
    const message = error && error.code === "schema-mismatch"
      ? "이 앱과 맞지 않는 데이터 버전이라 안전하게 거부했습니다."
      : error && error.code === "schema-missing"
        ? "데이터 버전 정보가 없어 안전하게 거부했습니다."
        : "오늘 승인된 파일이 없거나 네트워크가 잠시 불안정합니다.";
    const fallbackHref = currentSlug ? `${BASE}/${currentSlug}/archive/` : `${BASE}/discover/`;
    const fallbackText = currentSlug ? "최근 승인된 지난 말씀 보기" : "사찰 찾기로 가기";
    append(card,
      node("div", { className: "error-icon", text: "!", attrs: { "aria-hidden": "true" } }),
      node("h1", { text: title }),
      node("p", { text: message }),
      node("a", { className: "secondary-link", text: fallbackText, attrs: { href: fallbackHref, "data-testid": "archive-fallback" } })
    );
    append(section, sectionWrap(card));
    showScreen(section);
    document.title = `안내 · 마음숲`;
  }

  async function renderToday() {
    const date = getKstDate();
    const [tenant, content] = await Promise.all([loadTenant(), loadContent(date)]);
    setTenantName(tenant.name);
    const page = node("div", { attrs: { "data-screen": "today" } });
    append(page, pageHero(formatKoreanDate(date), content.title, "말씀을 읽고, 3분의 목탁 호흡 뒤 오늘의 기도를 마쳐 보세요."));

    const contentCard = node("article", { className: "content-card", attrs: { "aria-labelledby": "daily-title" } });
    const title = node("h2", { id: "daily-title", className: "content-title", text: content.title });
    let media = null;
    if (content.mediaUrl) {
      media = node("img", {
        className: "content-media",
        attrs: {
          alt: `${content.title} 관련 이미지`,
          loading: "lazy",
          decoding: "async",
          referrerpolicy: "no-referrer",
          "data-testid": "daily-media"
        }
      });
      media.addEventListener("error", () => {
        media.hidden = true;
        media.removeAttribute("src");
        media.dataset.loadFailed = "true";
      }, { once: true });
    }
    append(contentCard,
      node("p", { className: "content-kicker", text: "오늘의 말씀" }),
      title,
      node("p", { className: "content-body", text: content.body }),
      media,
      append(node("div", { className: "content-meta" }),
        node("span", { text: `${tenant.name} 마음편지` }),
        node("span", { text: `개정 ${content.revision}` })
      )
    );
    if (media) media.src = content.mediaUrl;

    const state = getRitual(date);
    const steps = node("div", { className: "ritual-steps", attrs: { "aria-label": "오늘 의례 순서" } });
    const stepWord = node("span", { className: "ritual-step is-done", text: "1 말씀" });
    const stepTimer = node("span", { className: `ritual-step${state.timerCompletedAt ? " is-done" : ""}`, text: "2 목탁" });
    const stepPrayer = node("span", { className: `ritual-step${state.prayerCompletedAt ? " is-done" : ""}`, text: "3 기도" });
    append(steps, stepWord, stepTimer, stepPrayer);

    const ritualCard = node("section", { className: "ritual-card", attrs: { "aria-labelledby": "timer-heading" } });
    const timerHeading = node("h2", { id: "timer-heading", className: "card-label", text: "목탁 호흡 · 3분" });
    const timerOrb = node("div", { className: "timer-orb" });
    const timerValue = node("span", { id: "timer-value", className: "timer-value", text: "03:00", attrs: { role: "timer", "aria-live": "off" } });
    append(timerOrb, timerValue, node("span", { className: "timer-caption", text: "남은 시간" }));
    const progress = node("progress", { id: "timer-progress", className: "timer-progress", attrs: { max: "180", value: "0", "aria-label": "목탁 타이머 진행" } });
    const startButton = node("button", { id: "timer-start", className: "primary-button", text: "목탁 3분 시작", attrs: { type: "button" } });
    const soundStatus = node("p", { id: "sound-status", className: "sound-status", text: "소리가 나지 않아도 시각 타이머는 계속됩니다" });
    append(ritualCard, timerHeading, timerOrb, progress, startButton, soundStatus);

    const prayerWrap = node("div", { className: "prayer-check-wrap" });
    const label = node("label", { className: "prayer-check-label" });
    const check = node("input", { id: "prayer-check", attrs: { type: "checkbox" } });
    check.disabled = !state.timerCompletedAt;
    check.checked = Boolean(state.prayerCompletedAt);
    append(label, check, node("span", { text: state.prayerCompletedAt ? "오늘 기도를 마쳤습니다" : "기도 완료" }));
    const hint = node("p", { id: "prayer-hint", className: "prayer-hint", text: state.timerCompletedAt ? "완료 기록은 이 기기에만 남습니다." : "목탁 3분을 마치면 체크할 수 있어요." });
    append(prayerWrap, label, hint);
    if (state.prayerCompletedAt) {
      prayerWrap.appendChild(node("a", { id: "lantern-link", className: "secondary-link", text: "함께 밝힌 연등 보기", attrs: { href: `${BASE}/${currentSlug}/lanterns/` } }));
    }

    const wrap = sectionWrap(contentCard, steps, ritualCard, prayerWrap);
    append(page, wrap);
    showScreen(page);
    document.title = `${content.title} · 마음숲`;

    wireTimer({ date, state, timerValue, progress, timerOrb, startButton, soundStatus, check, hint, stepTimer, stepPrayer, prayerWrap, label });
  }

  function wireTimer(elements) {
    const durationMs = 180000;
    const currentState = { ...elements.state };

    function updateDisplay() {
      if (currentState.timerCompletedAt) {
        elements.timerValue.textContent = "00:00";
        elements.progress.value = 180;
        elements.startButton.textContent = "목탁 호흡을 마쳤습니다";
        elements.startButton.disabled = true;
        elements.timerOrb.classList.remove("is-running");
        elements.stepTimer.classList.add("is-done");
        elements.check.disabled = false;
        elements.hint.textContent = "완료 기록은 이 기기에만 남습니다.";
        if (timerId) clearInterval(timerId);
        timerId = null;
        return;
      }
      if (!currentState.timerStartedAt) return;
      const elapsed = Math.max(0, Date.now() - currentState.timerStartedAt);
      if (elapsed >= durationMs) {
        currentState.timerCompletedAt = Date.now();
        saveRitual(elements.date, currentState);
        updateDisplay();
        showToast("목탁 호흡 3분을 마쳤어요");
        return;
      }
      const remainSeconds = Math.ceil((durationMs - elapsed) / 1000);
      const minutes = Math.floor(remainSeconds / 60);
      const seconds = remainSeconds % 60;
      elements.timerValue.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      elements.progress.value = Math.min(180, Math.floor(elapsed / 1000));
      elements.timerOrb.classList.add("is-running");
      elements.startButton.textContent = "호흡을 이어가고 있어요";
      elements.startButton.disabled = true;
    }

    async function playWoodblock() {
      const AudioEngine = window.AudioContext || window.webkitAudioContext;
      if (!AudioEngine) throw new Error("audio unavailable");
      const context = new AudioEngine();
      if (context.state === "suspended") await context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(430, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(185, context.currentTime + 0.17);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.22, context.currentTime + 0.009);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.34);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.36);
      oscillator.addEventListener("ended", () => context.close().catch(() => {}), { once: true });
    }

    elements.startButton.addEventListener("click", async () => {
      if (currentState.timerStartedAt || currentState.timerCompletedAt) return;
      currentState.timerStartedAt = Date.now();
      saveRitual(elements.date, currentState);
      try {
        await playWoodblock();
        elements.soundStatus.textContent = "첫 목탁 소리와 함께 천천히 숨을 쉽니다";
      } catch {
        elements.soundStatus.textContent = "소리를 재생할 수 없어 무음으로 진행합니다";
      }
      updateDisplay();
      timerId = setInterval(updateDisplay, 250);
    });

    elements.check.addEventListener("change", () => {
      if (!currentState.timerCompletedAt) {
        elements.check.checked = false;
        return;
      }
      if (elements.check.checked) {
        currentState.prayerCompletedAt = Date.now();
        saveRitual(elements.date, currentState);
        elements.stepPrayer.classList.add("is-done");
        elements.label.querySelector("span").textContent = "오늘 기도를 마쳤습니다";
        if (!document.getElementById("lantern-link")) {
          elements.prayerWrap.appendChild(node("a", { id: "lantern-link", className: "secondary-link", text: "함께 밝힌 연등 보기", attrs: { href: `${BASE}/${currentSlug}/lanterns/` } }));
        }
        showToast("오늘의 기도를 이 기기에 기록했어요");
      } else {
        delete currentState.prayerCompletedAt;
        saveRitual(elements.date, currentState);
        elements.stepPrayer.classList.remove("is-done");
        elements.label.querySelector("span").textContent = "기도 완료";
        const link = document.getElementById("lantern-link");
        if (link) link.remove();
      }
    });

    updateDisplay();
    if (currentState.timerStartedAt && !currentState.timerCompletedAt) timerId = setInterval(updateDisplay, 250);
  }

  async function renderLanterns() {
    const [tenant, index] = await Promise.all([loadTenant(), loadIndex()]);
    setTenantName(tenant.name);
    const page = node("div", { attrs: { "data-screen": "lanterns" } });
    append(page, pageHero("연등", "함께 밝힌 마음", "누가 기도했는지는 남기지 않고, 함께한 마음의 수만 보여드립니다."));
    const field = node("section", { className: "lantern-field", attrs: { "aria-labelledby": "lantern-count-label" } });
    const lights = node("div", { className: "lantern-lights", attrs: { "aria-hidden": "true" } });
    for (let indexValue = 0; indexValue < 6; indexValue += 1) lights.appendChild(node("span", { className: "lantern-light" }));
    const count = Number.isInteger(index.anonymousLanternCount) ? index.anonymousLanternCount : 0;
    append(field, lights,
      node("p", { id: "lantern-count-label", className: "card-label", text: `${tenant.name} · 최근 승인 집계` }),
      node("strong", { className: "aggregate-number", text: count.toLocaleString("ko-KR"), attrs: { "data-testid": "lantern-count" } }),
      node("p", { className: "aggregate-unit", text: "개의 마음이 함께 밝혀졌습니다" })
    );

    const children = [field];

    // 연등 프로그램(종류·접수 안내) — tenant_meta.lantern. 참여는 결제 미처리, 링크(https) 또는 문의 안내만.
    const lantern = tenant.lantern;
    if (lantern) {
      const program = node("article", { className: "info-card lantern-program", attrs: { "data-testid": "lantern-program" } });
      append(program, node("span", { className: "status-chip", text: "연등 접수 안내" }), node("h2", { text: "연등 밝히기" }));
      if (lantern.notice) append(program, node("p", { text: lantern.notice }));
      if (Array.isArray(lantern.types) && lantern.types.length) {
        const typeList = node("div", { className: "pill-list" });
        for (const type of lantern.types) {
          const pill = node("div", { className: "pill-item" });
          append(pill, node("strong", { text: type.name }), type.desc ? node("span", { text: type.desc }) : null);
          typeList.appendChild(pill);
        }
        append(program, typeList);
      }
      if (lantern.howto) append(program, node("div", { className: "notice-box", text: lantern.howto }));
      append(program, participateAction(lantern.contactUrl, lantern.contactLabel || "연등 접수 문의", "연등 접수·점등·금액은 절 종무소 안내를 따릅니다. 마음숲은 접수를 처리하지 않습니다."));
      children.push(program);
    }

    const infoStack = node("div", { className: "info-stack" });
    const mine = getRitual(getKstDate()).prayerCompletedAt;
    const local = node("article", { className: "info-card" });
    append(local,
      node("span", { className: "status-chip", text: mine ? "이 기기 · 기도 완료" : "이 기기 · 기록 없음" }),
      node("h2", { text: mine ? "오늘의 마음을 밝혔어요" : "기도를 마치면 이곳에서 확인해요" }),
      node("p", { text: "내 완료 기록은 이 기기에만 남으며 익명 집계로 전송되지 않습니다." })
    );
    const privacy = node("article", { className: "info-card" });
    append(privacy, node("h2", { text: "개인정보를 모으지 않아요" }), node("p", { text: "이름, 계정, 기도 제목을 입력하는 칸이 없습니다. 공개 화면에는 승인된 합계만 표시합니다." }));
    append(infoStack, local, privacy);
    children.push(infoStack);

    append(page, sectionWrap(...children));
    showScreen(page);
    document.title = `연등 · ${tenant.name} · 마음숲`;
  }

  // 참여/연락 액션: 유효한 https 가 있으면 외부 링크(_blank·noopener), 없으면 결제 미처리 문의 안내 박스.
  function participateAction(url, label, fallbackText) {
    if (url && validHttps(url)) {
      return node("a", {
        className: "secondary-link participate-link",
        text: label,
        attrs: { href: url, target: "_blank", rel: "noopener noreferrer", "data-testid": "participate", "data-external": "true" }
      });
    }
    const box = node("div", { className: "contact-note", attrs: { "data-testid": "participate", "data-external": "false" } });
    append(box, node("strong", { text: label }), node("span", { text: fallbackText }));
    return box;
  }

  async function renderSchedule() {
    const tenant = await loadTenant();
    setTenantName(tenant.name);
    const page = node("div", { attrs: { "data-screen": "schedule" } });
    append(page, pageHero("일정", `${tenant.name} 일정`, "정기 법회와 재·행사, 프로그램, 접수 기간을 안내합니다."));
    const items = Array.isArray(tenant.schedule) ? tenant.schedule : [];
    const list = node("div", { className: "schedule-list", attrs: { "data-testid": "schedule-list" } });
    if (!items.length) {
      append(list, append(node("div", { className: "empty-state" }),
        node("strong", { text: "등록된 일정이 없습니다" }),
        node("span", { text: "절 일정이 확정되면 이곳에 표시됩니다." })
      ));
    } else {
      const order = ["정기법회", "재·행사", "프로그램", "접수기간"];
      const groups = new Map();
      for (const item of items) {
        const key = item.kind || "안내";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      const keys = [...groups.keys()].sort((a, b) => {
        const ia = order.indexOf(a); const ib = order.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
      for (const key of keys) {
        list.appendChild(node("p", { className: "group-label", text: key }));
        for (const item of groups.get(key)) {
          const card = node("article", { className: "schedule-card", attrs: { "data-testid": "schedule-item" } });
          const head = node("div", { className: "schedule-head" });
          append(head, node("h2", { text: item.title }), item.recurring ? node("span", { className: "recurring-badge", text: "정기" }) : null);
          append(card, head);
          const meta = node("div", { className: "schedule-meta" });
          if (item.when) append(meta, node("span", { className: "schedule-when", text: item.when }));
          if (item.place) append(meta, node("span", { className: "schedule-place", text: item.place }));
          if (meta.childNodes.length) append(card, meta);
          if (item.desc) append(card, node("p", { className: "schedule-desc", text: item.desc }));
          list.appendChild(card);
        }
      }
    }
    append(page, sectionWrap(list));
    showScreen(page);
    document.title = `일정 · ${tenant.name} · 마음숲`;
  }

  async function renderNews() {
    const tenant = await loadTenant();
    setTenantName(tenant.name);
    const page = node("div", { attrs: { "data-screen": "news" } });
    append(page, pageHero("소식", `${tenant.name} 소식`, "절의 안내와 공지를 최근 순으로 전합니다."));
    const items = (Array.isArray(tenant.news) ? tenant.news.slice() : []).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const list = node("div", { className: "news-list", attrs: { "data-testid": "news-list" } });
    if (!items.length) {
      append(list, append(node("div", { className: "empty-state" }),
        node("strong", { text: "등록된 소식이 없습니다" }),
        node("span", { text: "새 소식이 올라오면 이곳에 표시됩니다." })
      ));
    } else {
      for (const item of items) {
        const card = node("article", { className: "news-card", attrs: { "data-testid": "news-item" } });
        append(card,
          node("time", { className: "news-date", text: formatKoreanDate(item.date, false), attrs: { datetime: item.date } }),
          node("h2", { className: "news-title", text: item.title }),
          item.body ? node("p", { className: "news-body", text: item.body }) : null
        );
        list.appendChild(card);
      }
    }
    append(page, sectionWrap(list));
    showScreen(page);
    document.title = `소식 · ${tenant.name} · 마음숲`;
  }

  async function renderDonation() {
    const tenant = await loadTenant();
    setTenantName(tenant.name);
    const info = tenant.donationInfo || {};
    const page = node("div", { attrs: { "data-screen": "donation" } });
    append(page, pageHero("시주·기부", `${tenant.name} 명의로만`, "시주와 불사 후원은 마음을 보태는 일입니다. 서두르지 않고 명의와 안내를 먼저 확인해 주세요."));

    const children = [];
    const card = node("article", { className: "info-card" });
    append(card,
      node("p", { className: "card-label", text: "표시 명의" }),
      node("p", { className: "strong-copy", text: info.payeeName || tenant.name, attrs: { "data-testid": "payee-name" } }),
      node("div", { className: "disabled-payment", text: "절 명의 연결 준비 중", attrs: { "aria-disabled": "true" } }),
      node("div", { className: "notice-box", text: info.notice || "시주 연결은 절 정책 확인 뒤 제공됩니다." })
    );
    children.push(card);

    // 불사·후원 캠페인 — tenant_meta.campaigns. 각 참여는 결제 미처리(외부 링크 또는 문의). 기부금영수증 안내 노출.
    const campaigns = Array.isArray(tenant.campaigns) ? tenant.campaigns : [];
    if (campaigns.length) {
      const list = node("div", { className: "campaign-list", attrs: { "data-testid": "campaign-list" } });
      for (const campaign of campaigns) {
        const item = node("article", { className: "info-card campaign-card", attrs: { "data-testid": "campaign-item" } });
        append(item, node("span", { className: "status-chip", text: "불사·후원" }), node("h2", { text: campaign.title }));
        if (campaign.purpose) append(item, node("p", { text: campaign.purpose }));
        const facts = node("div", { className: "campaign-facts" });
        if (campaign.unit) append(facts, factRow("후원 단위", campaign.unit));
        if (campaign.goalDisplay) append(facts, factRow("목표", campaign.goalDisplay));
        if (campaign.progressNote) append(facts, factRow("진행 현황", campaign.progressNote));
        if (facts.childNodes.length) append(item, facts);
        if (campaign.receiptNote) {
          append(item, append(node("div", { className: "notice-box receipt-note", attrs: { "data-testid": "receipt-note" } }),
            node("strong", { text: "기부금영수증 안내 " }),
            node("span", { text: campaign.receiptNote })
          ));
        }
        append(item, participateAction(campaign.participateUrl, campaign.participateLabel || "후원·불사 참여 문의", "후원·참여 접수와 금액은 절 종무소 안내를 따릅니다. 마음숲은 결제를 처리하지 않습니다."));
        list.appendChild(item);
      }
      children.push(list);
    }

    const caution = node("article", { className: "info-card" });
    append(caution,
      node("h2", { text: "연결 전 꼭 확인해 주세요" }),
      node("p", { text: "마음숲은 시주금·후원금을 받거나 결제를 처리하지 않습니다. 절 명의와 표시 주소, 취소·영수증 안내가 검증되기 전에는 외부 결제 경로를 열지 않습니다." })
    );
    children.push(append(node("div", { className: "info-stack" }), caution));

    append(page, sectionWrap(...children));
    showScreen(page);
    document.title = `시주·기부 · ${tenant.name} · 마음숲`;
  }

  function factRow(label, value) {
    const row = node("div", { className: "fact-row" });
    append(row, node("span", { className: "fact-label", text: label }), node("span", { className: "fact-value", text: value }));
    return row;
  }

  async function renderTemple() {
    const tenant = await loadTenant();
    setTenantName(tenant.name);
    const page = node("div", { attrs: { "data-screen": "temple" } });
    append(page, pageHero("절 정보", tenant.name, "고요가 머무는 곳의 소개와 오시는 길, 연락처를 안내합니다."));
    const panel = node("article", { className: "temple-panel" });
    append(panel,
      node("div", { className: "temple-seal", text: tenant.name, attrs: { "aria-hidden": "true" } }),
      node("h2", { text: tenant.name }),
      node("p", { text: tenant.intro })
    );

    const children = [panel];
    const profile = tenant.profile;
    if (profile) {
      const rows = [
        ["종파", profile.order],
        ["지역", profile.region],
        ["주소", profile.address],
        ["연락처", profile.phone],
        ["오시는 길", profile.directions],
        ["일과", profile.hours],
        ["연혁", profile.foundedNote]
      ].filter(([, value]) => typeof value === "string" && value.trim().length);
      if (rows.length) {
        const info = node("article", { className: "info-card temple-profile", attrs: { "data-testid": "temple-profile" } });
        append(info, node("p", { className: "card-label", text: "절 안내" }));
        const dl = node("dl", { className: "profile-list" });
        for (const [label, value] of rows) {
          append(dl, node("dt", { text: label }), node("dd", { text: value }));
        }
        append(info, dl);
        children.push(info);
      }
    }

    const pilot = node("article", { className: "info-card" });
    append(pilot,
      node("span", { className: "status-chip", text: "파일럿 안내" }),
      node("h2", { text: "검증을 위한 가상 절입니다" }),
      node("p", { text: "실제 절이 확정되면 감수된 소개와 절 명의 정보로 안전하게 교체됩니다." })
    );
    children.push(append(node("div", { className: "info-stack" }), pilot));

    append(page, sectionWrap(...children));
    showScreen(page);
    document.title = `${tenant.name} 소개 · 마음숲`;
  }

  async function renderDiscover() {
    await loadTemples();
    setHeaderLabel("사찰 찾기");
    document.getElementById("brand-link").setAttribute("href", currentSlug ? `${BASE}/${currentSlug}/today/` : `${BASE}/discover/`);
    const page = node("div", { attrs: { "data-screen": "discover" } });
    append(page, pageHero("사찰 찾기", "다니실 절을 찾아보세요", "여러 절을 담아 두고, 오늘 마음 가는 절로 드나들 수 있습니다."));

    const children = [];
    const mine = getMyTemples().map(templeBySlug).filter(Boolean);
    const mineSection = node("section", { className: "discover-section", attrs: { "data-testid": "my-temples", "aria-label": "내 절" } });
    append(mineSection, node("p", { className: "group-label", text: "내 절" }));
    if (mine.length) {
      const quick = node("div", { className: "temple-quick" });
      for (const temple of mine) {
        const chip = node("a", {
          className: `temple-chip${temple.slug === currentSlug ? " is-current" : ""}`,
          attrs: { href: `${BASE}/${temple.slug}/today/`, "data-testid": "my-temple-chip" }
        });
        append(chip, node("strong", { text: temple.name }), node("span", { text: temple.region || "" }));
        quick.appendChild(chip);
      }
      append(mineSection, quick);
    } else {
      append(mineSection, append(node("div", { className: "empty-state small" }),
        node("span", { text: "아직 담아 둔 절이 없어요. 아래에서 절을 찾아 ‘내 절에 추가’를 눌러 보세요." })
      ));
    }
    children.push(mineSection);

    const allSection = node("section", { className: "discover-section", attrs: { "aria-label": "모든 절" } });
    append(allSection, node("p", { className: "group-label", text: "모든 절" }));
    const list = node("div", { className: "temple-list", attrs: { "data-testid": "discover-list" } });
    for (const temple of temples) {
      const card = node("article", { className: `temple-card${temple.slug === currentSlug ? " is-current" : ""}`, attrs: { "data-testid": "temple-card", "data-slug": temple.slug } });
      const head = node("div", { className: "temple-card-head" });
      append(head, node("h2", { text: temple.name }), temple.pilot ? node("span", { className: "pilot-badge", text: "파일럿" }) : null);
      append(card, head);
      const tags = node("p", { className: "temple-tags" });
      tags.textContent = [temple.order, temple.region].filter(Boolean).join(" · ");
      if (tags.textContent) append(card, tags);
      if (temple.summary) append(card, node("p", { className: "temple-summary", text: temple.summary }));
      const actions = node("div", { className: "temple-actions" });
      const view = node("a", { className: "primary-button compact", text: temple.slug === currentSlug ? "지금 보는 절" : "보기", attrs: { href: `${BASE}/${temple.slug}/today/`, "data-testid": "temple-view" } });
      const follow = node("button", {
        className: `choice-button follow-toggle${isFollowing(temple.slug) ? " is-following" : ""}`,
        text: isFollowing(temple.slug) ? "추가됨 ✓" : "내 절에 추가",
        attrs: { type: "button", "data-testid": "follow-toggle", "aria-pressed": String(isFollowing(temple.slug)) }
      });
      follow.addEventListener("click", () => {
        const nowFollowing = toggleFollow(temple.slug);
        follow.textContent = nowFollowing ? "추가됨 ✓" : "내 절에 추가";
        follow.classList.toggle("is-following", nowFollowing);
        follow.setAttribute("aria-pressed", String(nowFollowing));
        showToast(nowFollowing ? `${temple.name}을(를) 내 절에 담았어요` : `${temple.name}을(를) 내 절에서 뺐어요`);
      });
      append(actions, view, follow);
      append(card, actions);
      list.appendChild(card);
    }
    append(allSection, list);
    children.push(allSection);

    append(page, sectionWrap(...children));
    showScreen(page);
    document.title = `사찰 찾기 · 마음숲`;
  }

  async function renderSettings() {
    const tenant = await loadTenant();
    setTenantName(tenant.name);
    const page = node("div", { attrs: { "data-screen": "settings" } });
    append(page, pageHero("이 기기 설정", "내 마음의 자리는 가볍게", "기도 완료와 화면 글자 설정만 이 브라우저에 남습니다."));
    const card = node("article", { className: "info-card" });
    const textGroup = node("section", { className: "settings-group", attrs: { "aria-labelledby": "text-setting-title" } });
    const choiceRow = node("div", { className: "choice-row" });
    const storedScale = appGet("textScale") === "large" ? "large" : "normal";
    const normalButton = node("button", { className: "choice-button", text: "기본 글자", attrs: { type: "button", "aria-pressed": String(storedScale === "normal") } });
    const largeButton = node("button", { className: "choice-button", text: "큰 글자", attrs: { type: "button", "aria-pressed": String(storedScale === "large") } });
    append(choiceRow, normalButton, largeButton);
    append(textGroup,
      node("h2", { id: "text-setting-title", className: "settings-title", text: "화면 글자 크기" }),
      node("p", { className: "settings-copy", text: "이 설정은 이 기기 화면에만 적용되며 카카오 수신에는 영향을 주지 않습니다." }),
      choiceRow
    );
    const resetGroup = node("section", { className: "settings-group", attrs: { "aria-labelledby": "reset-title" } });
    const resetButton = node("button", { id: "reset-local-data", className: "danger-button", text: "이 기기 데이터 초기화", attrs: { type: "button" } });
    append(resetGroup,
      node("h2", { id: "reset-title", className: "settings-title", text: "로컬 데이터" }),
      node("p", { className: "settings-copy", text: "이 브라우저에 저장된 모든 절의 기도 완료·글자 설정·내 절 목록을 지웁니다. 절이나 다른 기기로 전송된 데이터는 없습니다." }),
      resetButton
    );
    const guideGroup = node("section", { className: "settings-group", attrs: { "aria-labelledby": "guide-title" } });
    const guideButton = node("button", { id: "show-welcome-again", className: "choice-button", text: "앱 사용 안내 다시 보기", attrs: { type: "button" } });
    append(guideGroup,
      node("h2", { id: "guide-title", className: "settings-title", text: "앱 사용 안내" }),
      node("p", { className: "settings-copy", text: "마음숲이 무엇이고 어떻게 쓰는지 처음 안내를 다시 봅니다." }),
      guideButton
    );
    // 배경 음악 저작권 표기(CC BY 4.0 조건 — 발견 가능한 위치에 크레딧).
    const musicGroup = node("section", { className: "settings-group", attrs: { "aria-labelledby": "music-title" } });
    const creditLink = node("a", { className: "settings-copy", text: "Creative Commons BY 4.0", attrs: { href: "https://creativecommons.org/licenses/by/4.0/", target: "_blank", rel: "noopener noreferrer" } });
    const creditWrap = node("p", { className: "settings-copy" });
    creditWrap.textContent = "배경 음악: “Meditation Impromptu 01” — Kevin MacLeod (incompetech.com) · ";
    creditWrap.appendChild(creditLink);
    append(musicGroup,
      node("h2", { id: "music-title", className: "settings-title", text: "배경 음악" }),
      node("p", { className: "settings-copy", text: "헤더의 ‘노래 듣기’로 켜고 끌 수 있어요. 무음 선택은 이 기기에만 저장됩니다." }),
      creditWrap
    );
    append(card, textGroup, guideGroup, musicGroup, resetGroup);
    append(page, sectionWrap(card));
    showScreen(page);
    document.title = `설정 · 마음숲`;
    guideButton.addEventListener("click", () => showWelcome(true));

    function selectScale(value) {
      appSet("textScale", value);
      applyTextScale(value);
      normalButton.setAttribute("aria-pressed", String(value === "normal"));
      largeButton.setAttribute("aria-pressed", String(value === "large"));
      showToast(value === "large" ? "큰 글자로 바꿨어요" : "기본 글자로 바꿨어요");
    }
    normalButton.addEventListener("click", () => selectScale("normal"));
    largeButton.addEventListener("click", () => selectScale("large"));
    resetButton.addEventListener("click", () => {
      const approved = window.confirm("이 기기에 저장된 모든 절의 기도 완료·설정·내 절 목록을 지울까요?");
      if (!approved) return;
      if (clearAllDeviceData()) {
        applyTextScale("normal");
        normalButton.setAttribute("aria-pressed", "true");
        largeButton.setAttribute("aria-pressed", "false");
        showToast("이 기기 데이터를 모두 초기화했어요");
      } else {
        showToast("데이터를 초기화하지 못했어요");
      }
    });
  }

  async function renderArchive() {
    const [tenant, index] = await Promise.all([loadTenant(), loadIndex()]);
    setTenantName(tenant.name);
    const currentDate = getKstDate();
    const dates = [...new Set(index.dates)].filter((date) => date < currentDate).sort().reverse();
    const page = node("div", { attrs: { "data-screen": "archive" } });
    append(page, pageHero("읽기 전용 기록", "지난 말씀", "날짜를 따라 천천히 다시 읽을 수 있습니다. 이곳의 열람은 의례 완료 기록에 포함되지 않습니다."));
    const list = node("div", { className: "archive-list", attrs: { "data-testid": "archive-list" } });
    if (dates.length === 0) {
      append(list, append(node("div", { className: "empty-state" }),
        node("strong", { text: "아직 쌓인 기록이 없습니다" }),
        node("span", { text: "승인된 날짜가 지나면 이곳에 차례로 놓입니다." })
      ));
    } else {
      const settled = await Promise.allSettled(dates.map(async (date) => ({ date, content: await loadContent(date) })));
      const items = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
      const skipped = settled.length - items.length;
      for (const item of items) {
        const card = node("article", { className: "archive-card" });
        const time = node("time", { className: "archive-date", text: formatShortDate(item.date), attrs: { datetime: item.date } });
        const content = node("div", { className: "archive-content" });
        append(content, node("h2", { text: item.content.title }), node("p", { text: item.content.body }));
        append(card, time, content);
        list.appendChild(card);
      }
      if (skipped > 0) {
        list.appendChild(node("p", {
          className: "archive-partial-note",
          text: `불러오지 못한 말씀 ${skipped}건은 제외했습니다.`,
          attrs: { role: "status", "data-testid": "archive-partial-note" }
        }));
      }
    }
    append(page, sectionWrap(list));
    showScreen(page);
    document.title = `지난 말씀 · ${tenant.name} · 마음숲`;
  }

  function setTenantName(name) {
    setHeaderLabel(name);
  }

  function setHeaderLabel(label) {
    const el = document.getElementById("tenant-name-header");
    if (el) el.textContent = label;
  }

  function setNavigation(route) {
    for (const item of document.querySelectorAll("[data-nav], [data-menu]")) {
      item.removeAttribute("aria-current");
      const value = item.dataset.nav || item.dataset.menu;
      if (value === route) item.setAttribute("aria-current", "page");
    }
    const bottomMore = document.getElementById("bottom-more");
    if (bottomMore && !BOTTOM_ROUTES.has(route)) bottomMore.setAttribute("aria-current", "page");
    else if (bottomMore) bottomMore.removeAttribute("aria-current");
  }

  // 네비/브랜드 링크를 currentSlug 기준으로 갱신(런타임 생성이라 BASE 접두 필요).
  function updateNavLinks() {
    const slug = currentSlug;
    for (const el of document.querySelectorAll("[data-nav], [data-menu]")) {
      const route = el.dataset.nav || el.dataset.menu;
      if (!route) continue;
      if (route === "discover") { el.setAttribute("href", `${BASE}/discover/`); continue; }
      el.setAttribute("href", slug ? `${BASE}/${slug}/${route}/` : `${BASE}/discover/`);
    }
    const brand = document.getElementById("brand-link");
    if (brand) brand.setAttribute("href", slug ? `${BASE}/${slug}/today/` : `${BASE}/discover/`);
  }

  // ---- 바텀시트(더보기 메뉴 + 절 전환기) 공용 컨트롤 ----
  function anyOpenPanel() {
    for (const id of ["more-panel", "temple-panel"]) {
      const panel = document.getElementById(id);
      if (panel && !panel.hidden) return panel;
    }
    return null;
  }

  function closeAllSheets() {
    for (const id of ["more-panel", "temple-panel"]) {
      const panel = document.getElementById(id);
      if (panel) panel.hidden = true;
    }
    const backdrop = document.getElementById("sheet-backdrop");
    if (backdrop) backdrop.hidden = true;
    for (const id of ["open-more", "bottom-more", "temple-switch"]) {
      const opener = document.getElementById(id);
      if (opener) opener.setAttribute("aria-expanded", "false");
    }
  }

  function openSheet(panelId, openerIds, onOpen) {
    closeAllSheets();
    const panel = document.getElementById(panelId);
    const backdrop = document.getElementById("sheet-backdrop");
    if (!panel) return;
    if (onOpen) onOpen(panel);
    panel.hidden = false;
    if (backdrop) backdrop.hidden = false;
    for (const id of openerIds) {
      const opener = document.getElementById(id);
      if (opener) opener.setAttribute("aria-expanded", "true");
    }
    const closeButton = panel.querySelector(".close-button");
    if (closeButton) closeButton.focus();
  }

  function populateTempleSwitcher() {
    const listRoot = document.getElementById("switch-temple-list");
    if (!listRoot) return;
    clear(listRoot);
    const mine = getMyTemples().map(templeBySlug).filter(Boolean);
    const entries = mine.length ? mine : temples;
    for (const temple of entries) {
      const link = node("a", {
        className: `switch-temple${temple.slug === currentSlug ? " is-current" : ""}`,
        attrs: { href: `${BASE}/${temple.slug}/today/` }
      });
      append(link,
        node("strong", { text: temple.name }),
        node("span", { text: temple.slug === currentSlug ? "지금 보는 절" : (temple.region || "") })
      );
      listRoot.appendChild(link);
    }
    const heading = document.getElementById("switch-list-label");
    if (heading) heading.textContent = mine.length ? "내 절" : "모든 절";
  }

  function setupSheets() {
    const backdrop = document.getElementById("sheet-backdrop");
    const moreOpeners = [document.getElementById("open-more"), document.getElementById("bottom-more")].filter(Boolean);
    for (const opener of moreOpeners) opener.addEventListener("click", () => openSheet("more-panel", ["open-more", "bottom-more"]));
    const switchButton = document.getElementById("temple-switch");
    if (switchButton) switchButton.addEventListener("click", () => openSheet("temple-panel", ["temple-switch"], populateTempleSwitcher));
    for (const button of document.querySelectorAll(".close-button")) button.addEventListener("click", closeAllSheets);
    if (backdrop) backdrop.addEventListener("click", closeAllSheets);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && anyOpenPanel()) closeAllSheets();
    });
  }

  function updateConnectivity() {
    offlineBanner.hidden = navigator.onLine;
    document.body.classList.toggle("is-offline", !navigator.onLine);
  }

  // 배경 음악(BGM) 컨트롤. 브라우저 자동재생 정책상 소리는 사용자가 '노래 듣기'를 눌러야 시작된다.
  // 무음(정지) 선택과 재생 위치는 이 기기에만 저장(개인정보 무수집 원칙)한다. SPA 라 화면·절 이동에도
  // 오디오 객체가 유지되어 소리가 끊기지 않는다. BGM 상태는 앱 전역(_app) 키로 저장 — 절 전환과 무관.
  const BGM_SRC = `${BASE}/audio/bgm.mp3`;
  function setupBgm() {
    const header = document.querySelector(".site-header");
    const menuButton = document.getElementById("open-more");
    if (!header || !menuButton) return;
    const audio = new Audio(BGM_SRC);
    audio.loop = true;
    audio.preload = "auto";   // 모바일에서 탭 즉시 재생되도록 미리 로드
    audio.setAttribute("playsinline", "");
    const savedTime = parseFloat(appGet("bgmTime") || "0");
    if (savedTime > 0 && isFinite(savedTime)) { try { audio.currentTime = savedTime; } catch (e) { /* metadata 전 */ } }
    const button = node("button", { id: "bgm-toggle", className: "quiet-button bgm-toggle", attrs: { type: "button", "aria-pressed": "false" } });
    function setLabel(playing) {
      button.textContent = playing ? "무음" : "노래 듣기";
      button.setAttribute("aria-label", playing ? "배경 음악 끄기" : "배경 음악 듣기");
      button.setAttribute("aria-pressed", String(playing));
      button.classList.toggle("is-playing", playing);
    }
    setLabel(false);
    header.insertBefore(button, menuButton);
    let lastSaved = 0;
    function play(userInitiated) {
      // iOS Safari는 사용자 제스처 핸들러 내에서 play()가 '먼저' 호출돼야 소리를 허용한다.
      // 따라서 play()를 동기로 먼저 부르고, 저장 위치 복원은 그 뒤 best-effort 로 처리한다.
      const promise = audio.play();
      const t = parseFloat(appGet("bgmTime") || "0");
      if (t > 0 && isFinite(t)) { try { audio.currentTime = t; } catch (e) {} }
      if (promise && typeof promise.then === "function") {
        promise.then(() => {
          appSet("bgmOn", "on");
          setLabel(true);
          if (userInitiated && appGet("bgmHintShown") !== "1") {
            appSet("bgmHintShown", "1");
            showToast("소리가 안 들리면 휴대폰 무음(벨소리) 스위치와 볼륨을 확인해 주세요");
          }
        }).catch(() => {
          appSet("bgmOn", "on");     // 의사는 재생 — 다음 상호작용에서 재시도
          setLabel(false);
          if (userInitiated) showToast("브라우저가 재생을 막았어요. 화면을 한 번 더 눌러 주세요");
        });
      } else {
        appSet("bgmOn", "on");
        setLabel(true);
      }
    }
    function pause() {
      audio.pause();
      appSet("bgmTime", String(audio.currentTime || 0));
      appSet("bgmOn", "off");
      setLabel(false);
    }
    button.addEventListener("click", () => { if (audio.paused) play(true); else pause(); });
    audio.addEventListener("timeupdate", () => {
      const now = audio.currentTime || 0;
      if (Math.abs(now - lastSaved) >= 3) { lastSaved = now; appSet("bgmTime", String(now)); }
    });
    window.addEventListener("pagehide", () => { if (!audio.paused) appSet("bgmTime", String(audio.currentTime || 0)); });
    if (appGet("bgmOn") === "on") play(false);   // 재방문/화면이동 시 이어 재생 시도(제스처 없음 → 조용히)
  }

  // 첫 사용 온보딩. 처음 방문한 신도에게 이 앱이 무엇이고 어떻게 쓰는지, 그리고 개인정보를
  // 모으지 않는다는 점을 조용히 안내한다. 본 적 있으면(localStorage) 뜨지 않는다.
  // force=true(설정의 '다시 보기')면 항상 표시. 개인정보 무수집 원칙에 맞게 로컬 플래그만 사용.
  function showWelcome(force = false) {
    if (!force && appGet("welcomeSeen") === "1") return;
    const prior = document.getElementById("welcome-overlay");
    if (prior) prior.remove();
    const overlay = node("div", { id: "welcome-overlay", className: "welcome-overlay", attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": "welcome-title" } });
    const card = node("div", { className: "welcome-card" });
    append(card,
      node("span", { className: "welcome-mark", text: "숲", attrs: { "aria-hidden": "true" } }),
      node("h2", { id: "welcome-title", className: "welcome-title", text: "마음숲에 오신 것을 환영합니다" }),
      node("p", { className: "welcome-sub", text: "여러 절의 오늘 말씀과 일정·소식을 한곳에서 만나는 조용한 공간입니다." })
    );
    const steps = node("div", { className: "welcome-steps" });
    const points = [
      ["오늘", "오늘의 말씀을 읽고, 목탁 소리로 3분 호흡한 뒤, 짧은 기도로 하루를 엽니다."],
      ["여러 절", "다니시는 절을 담아 두고, 헤더에서 언제든 절을 바꿔 드나들 수 있습니다."],
      ["안심", "이름도 계정도 묻지 않습니다. 기도 기록은 이 휴대폰에만 남고, 어디로도 전송되지 않습니다."]
    ];
    for (const [label, desc] of points) {
      const step = node("div", { className: "welcome-step" });
      append(step,
        node("span", { className: "welcome-step-label", text: label }),
        node("p", { className: "welcome-step-desc", text: desc })
      );
      append(steps, step);
    }
    append(card, steps);
    const startButton = node("button", { className: "welcome-start", text: "시작하기", attrs: { type: "button" } });
    append(card, startButton, node("p", { className: "welcome-foot", text: "이 안내는 언제든 설정에서 다시 볼 수 있어요." }));
    append(overlay, card);
    document.body.appendChild(overlay);
    function close() {
      appSet("welcomeSeen", "1");
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(event) { if (event.key === "Escape") close(); }
    startButton.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    startButton.focus();
  }

  // 화면별 렌더러 (SPA 네비게이션·초기 boot 공용)
  const RENDERERS = {
    today: renderToday,
    lanterns: renderLanterns,
    schedule: renderSchedule,
    news: renderNews,
    temple: renderTemple,
    donation: renderDonation,
    settings: renderSettings,
    archive: renderArchive,
    discover: renderDiscover
  };

  function isRouteHref(href) {
    try {
      const parsed = parseAppPath(new URL(href, location.href).pathname);
      return Boolean(parsed.route || parsed.slug);
    } catch (e) {
      return false;
    }
  }

  function setCurrentSlug(slug) {
    currentSlug = slug;
    if (slug) appSet("lastSlug", slug);
  }

  function effectiveSlug(urlSlug) {
    if (urlSlug && templeBySlug(urlSlug)) return urlSlug;
    if (currentSlug && templeBySlug(currentSlug)) return currentSlug;
    const last = appGet("lastSlug");
    if (last && templeBySlug(last)) return last;
    return null;
  }

  // 진입/전환 공통 처리: 슬러그·라우트를 해석하고 렌더한다. push=true 면 history 갱신.
  async function go(parsed, push, href) {
    const { slug } = parsed;
    let { route } = parsed;

    if (route && APP_ROUTES.has(route)) {
      if (slug && templeBySlug(slug)) setCurrentSlug(slug);
      return finishRender("discover", push, href || `${BASE}/discover/`);
    }

    const eslug = effectiveSlug(slug);
    if (!eslug) {
      return finishRender("discover", push, `${BASE}/discover/`);
    }
    setCurrentSlug(eslug);
    if (!route || !TENANT_ROUTES.has(route)) route = "today";
    // href 가 슬러그를 담지 못한 진입(예: '/today/')이면 정규 href 로 URL 정정.
    const canonical = href && parseAppPath(new URL(href, location.href).pathname).slug ? href : `${BASE}/${eslug}/${route}/`;
    return finishRender(route, push, canonical);
  }

  function finishRender(route, push, href) {
    if (push && href) { try { history.pushState({ route }, "", href); } catch (e) { /* 무시 */ } }
    closeAllSheets();
    updateNavLinks();
    setNavigation(route);
    window.scrollTo(0, 0);
    return RENDERERS[route]().catch(renderDataError);
  }

  async function navigateTo(href) {
    if (!isRouteHref(href)) { window.location.href = href; return; }
    await go(parseAppPath(new URL(href, location.href).pathname), true, href);
  }

  function setupSpaNav() {
    document.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest ? event.target.closest("a[href]") : null;
      if (!link || link.target === "_blank") return;
      const href = link.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("http")) return;
      if (!isRouteHref(href)) return;   // 라우트 링크가 아니면 브라우저 기본 동작
      event.preventDefault();
      navigateTo(href);
    });
    window.addEventListener("popstate", () => { go(parseAppPath(location.pathname), false, null); });
  }

  async function boot() {
    applyTextScale(appGet("textScale"));
    setupSheets();
    setupBgm();
    setupSpaNav();
    updateConnectivity();
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);

    const swActive = "serviceWorker" in navigator && location.protocol !== "file:";
    if (swActive) {
      navigator.serviceWorker.register(`${BASE}/service-worker.js`).catch(() => {});
    }

    // 라우팅 전 사찰 디렉터리를 먼저 확보(슬러그 판별 근거). 실패해도 앱은 안내 화면으로 진행.
    let parsed = { slug: null, route: null };
    try {
      await loadTemples();
      parsed = parseAppPath(location.pathname);
    } catch (error) {
      renderDataError(error);
      return;
    }

    // 진입 슬러그 확정(release reconcile 를 위해 콘텐츠 로드 전에 결정).
    const entrySlug = effectiveSlug(parsed.slug);
    if (entrySlug && !(parsed.route && APP_ROUTES.has(parsed.route))) setCurrentSlug(entrySlug);

    // N-01: 서비스워커가 이미 제어 중(재방문)이면 release marker reconcile 를 콘텐츠 로드보다 먼저
    // 완료시킨다. 승격/철회로 marker 가 바뀌면 SW 가 옛 콘텐츠 캐시를 통째로 무효화하는데, 콘텐츠를
    // 먼저 캐시한 뒤 무효화하면 방금 채운 최신 승인본까지 지워져 즉시 offline 시 유실된다.
    if (swActive && navigator.serviceWorker.controller && currentSlug) {
      try { await fetch(`${BASE}/data/${currentSlug}/release.json`, { cache: "no-store" }); } catch (e) { /* offline: SW 캐시 폴백 */ }
    }

    const routeForWelcome = (parsed.route && APP_ROUTES.has(parsed.route)) ? parsed.route : (currentSlug ? (parsed.route && TENANT_ROUTES.has(parsed.route) ? parsed.route : "today") : "discover");
    await go(parsed, false, null);

    // 첫 방문 온보딩은 메인 진입(오늘)에서만 조용히 띄운다.
    if (routeForWelcome === "today") showWelcome();

    // 첫 방문(비제어): SW 설치 후 다음 방문의 무효화 기준선을 잡도록 marker 를 비차단 프리페치.
    if (swActive && !navigator.serviceWorker.controller && currentSlug) {
      fetch(`${BASE}/data/${currentSlug}/release.json`, { cache: "no-store" }).catch(() => {});
    }

    setInterval(() => {
      const nextDate = getKstDate();
      if (nextDate !== rolloverDate) location.reload();
    }, 30000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && getKstDate() !== rolloverDate) location.reload();
    });
  }

  boot();
})();
