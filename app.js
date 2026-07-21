(() => {
  "use strict";

  const EXPECTED_SCHEMA = "1";
  const TENANT = "oosa";
  const STORAGE_PREFIX = `maumsup:v1:${TENANT}:`;
  const ROUTES = new Set(["today", "lanterns", "donation", "temple", "settings", "archive"]);
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

  function getRoute() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts[0] === "maeumsup") parts.shift(); // base-strip (deploy: /maeumsup/)
    const candidate = parts[1] || "today";
    return ROUTES.has(candidate) ? candidate : "today";
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

  function safeGet(key) {
    try { return localStorage.getItem(STORAGE_PREFIX + key); }
    catch { return null; }
  }

  function safeSet(key, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, value);
      return true;
    } catch {
      showToast("이 브라우저에서는 기기 저장을 사용할 수 없어요");
      return false;
    }
  }

  function safeRemoveAll() {
    try {
      const keys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && key.startsWith(STORAGE_PREFIX)) keys.push(key);
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

  function assertSchemaVersion(value, label) {
    if (!Object.prototype.hasOwnProperty.call(value, "schemaVersion")) {
      throw new ContractError("schema-missing", `${label} schemaVersion 누락`);
    }
    if (value.schemaVersion !== EXPECTED_SCHEMA) {
      throw new ContractError("schema-mismatch", `${label} schemaVersion 불일치`);
    }
  }

  function validateContent(value, expectedDate) {
    if (!isPlainObject(value)) throw new ContractError("invalid-content", "콘텐츠가 객체가 아닙니다");
    assertSchemaVersion(value, "content");
    const allowed = ["schemaVersion", "tenantSlug", "date", "title", "body", "mediaUrl", "revision", "publishedAt"];
    const required = ["tenantSlug", "date", "title", "body", "revision", "publishedAt", "schemaVersion"];
    if (!exactKeys(value, allowed) || !required.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
      throw new ContractError("invalid-content", "콘텐츠 공개 필드 계약 위반");
    }
    if (value.tenantSlug !== TENANT || value.tenantSlug.length < 2 || value.tenantSlug.length > 32 || !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value.tenantSlug)) {
      throw new ContractError("invalid-content", "절 식별자 계약 위반");
    }
    if (!validDate(value.date) || (expectedDate && value.date !== expectedDate)) throw new ContractError("invalid-content", "콘텐츠 날짜 계약 위반");
    if (typeof value.title !== "string" || value.title.length < 1 || value.title.length > 120) throw new ContractError("invalid-content", "콘텐츠 제목 계약 위반");
    if (typeof value.body !== "string" || value.body.length < 1 || value.body.length > 5000) throw new ContractError("invalid-content", "콘텐츠 본문 계약 위반");
    if (!Number.isInteger(value.revision) || value.revision < 1) throw new ContractError("invalid-content", "개정 번호 계약 위반");
    if (typeof value.publishedAt !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-([12]\d|3[01]|0[1-9])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value.publishedAt)) {
      throw new ContractError("invalid-content", "공개 시각 계약 위반");
    }
    if (value.mediaUrl !== undefined && !validHttps(value.mediaUrl)) throw new ContractError("invalid-content", "미디어 주소 계약 위반");
    return value;
  }

  function validateTenant(value) {
    if (!isPlainObject(value)) throw new ContractError("invalid-tenant", "절 정보가 객체가 아닙니다");
    assertSchemaVersion(value, "tenant");
    const allowed = ["schemaVersion", "tenantSlug", "name", "intro", "donationInfo", "settings"];
    if (!exactKeys(value, allowed) || !["tenantSlug", "name", "intro", "schemaVersion"].every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
      throw new ContractError("invalid-tenant", "절 정보 공개 필드 계약 위반");
    }
    if (value.tenantSlug !== TENANT) throw new ContractError("invalid-tenant", "절 식별자 불일치");
    if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 60) throw new ContractError("invalid-tenant", "절 이름 계약 위반");
    if (typeof value.intro !== "string" || value.intro.length < 1 || value.intro.length > 2000) throw new ContractError("invalid-tenant", "절 소개 계약 위반");
    if (value.donationInfo !== undefined) {
      const info = value.donationInfo;
      if (!isPlainObject(info) || !exactKeys(info, ["payeeName", "notice", "paymentUrl"])) throw new ContractError("invalid-tenant", "시주 안내 필드 계약 위반");
      if (info.payeeName !== undefined && (typeof info.payeeName !== "string" || info.payeeName.length < 1 || info.payeeName.length > 60)) throw new ContractError("invalid-tenant", "시주 명의 계약 위반");
      if (info.notice !== undefined && (typeof info.notice !== "string" || info.notice.length > 2000)) throw new ContractError("invalid-tenant", "시주 유의사항 계약 위반");
      if (info.paymentUrl !== undefined && !validHttps(info.paymentUrl)) throw new ContractError("invalid-tenant", "결제 주소 계약 위반");
    }
    if (value.settings !== undefined) {
      const settings = value.settings;
      if (!isPlainObject(settings) || !exactKeys(settings, ["timezone", "lanternEnabled", "donationEnabled"])) throw new ContractError("invalid-tenant", "공개 설정 필드 계약 위반");
      if (settings.timezone !== undefined && settings.timezone !== "Asia/Seoul") throw new ContractError("invalid-tenant", "시간대 계약 위반");
      for (const key of ["lanternEnabled", "donationEnabled"]) if (settings[key] !== undefined && typeof settings[key] !== "boolean") throw new ContractError("invalid-tenant", "공개 설정 타입 계약 위반");
    }
    return value;
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

  async function loadTenant() {
    return validateTenant(await fetchJson(`/maeumsup/data/${TENANT}/tenant_meta.json`));
  }

  async function loadContent(date) {
    return validateContent(await fetchJson(`/maeumsup/data/${TENANT}/${date}.json`), date);
  }

  async function loadIndex() {
    const value = await fetchJson(`/maeumsup/data/${TENANT}/index.json`);
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
      || !required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
      || value.schemaVersion !== EXPECTED_SCHEMA
      || value.tenantSlug !== TENANT
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
    append(card,
      node("div", { className: "error-icon", text: "!", attrs: { "aria-hidden": "true" } }),
      node("h1", { text: title }),
      node("p", { text: message }),
      node("a", { className: "secondary-link", text: "최근 승인된 지난 말씀 보기", attrs: { href: `/maeumsup/${TENANT}/archive/`, "data-testid": "archive-fallback" } })
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
      prayerWrap.appendChild(node("a", { id: "lantern-link", className: "secondary-link", text: "함께 밝힌 연등 보기", attrs: { href: `/maeumsup/${TENANT}/lanterns/` } }));
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
          elements.prayerWrap.appendChild(node("a", { id: "lantern-link", className: "secondary-link", text: "함께 밝힌 연등 보기", attrs: { href: `/maeumsup/${TENANT}/lanterns/` } }));
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
    append(page, pageHero("익명 집계", "함께 밝힌 마음", "누가 기도했는지는 남기지 않고, 함께한 마음의 수만 보여드립니다."));
    const field = node("section", { className: "lantern-field", attrs: { "aria-labelledby": "lantern-count-label" } });
    const lights = node("div", { className: "lantern-lights", attrs: { "aria-hidden": "true" } });
    for (let indexValue = 0; indexValue < 6; indexValue += 1) lights.appendChild(node("span", { className: "lantern-light" }));
    const count = Number.isInteger(index.anonymousLanternCount) ? index.anonymousLanternCount : 0;
    append(field, lights,
      node("p", { id: "lantern-count-label", className: "card-label", text: `${tenant.name} · 최근 승인 집계` }),
      node("strong", { className: "aggregate-number", text: count.toLocaleString("ko-KR"), attrs: { "data-testid": "lantern-count" } }),
      node("p", { className: "aggregate-unit", text: "개의 마음이 함께 밝혀졌습니다" })
    );
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
    append(page, sectionWrap(field, infoStack));
    showScreen(page);
    document.title = `연등 현황 · 마음숲`;
  }

  async function renderDonation() {
    const tenant = await loadTenant();
    setTenantName(tenant.name);
    const info = tenant.donationInfo || {};
    const page = node("div", { attrs: { "data-screen": "donation" } });
    append(page, pageHero("시주 안내", `${tenant.name} 명의로만`, "시주는 마음을 보태는 일입니다. 서두르지 않고 명의와 안내를 먼저 확인해 주세요."));
    const card = node("article", { className: "info-card" });
    append(card,
      node("p", { className: "card-label", text: "표시 명의" }),
      node("p", { className: "strong-copy", text: info.payeeName || tenant.name, attrs: { "data-testid": "payee-name" } }),
      node("div", { className: "disabled-payment", text: "절 명의 연결 준비 중", attrs: { "aria-disabled": "true" } }),
      node("div", { className: "notice-box", text: info.notice || "시주 연결은 절 정책 확인 뒤 제공됩니다." })
    );
    const caution = node("article", { className: "info-card" });
    append(caution,
      node("h2", { text: "연결 전 꼭 확인해 주세요" }),
      node("p", { text: "마음숲은 시주금을 받거나 결제를 처리하지 않습니다. 절 명의와 표시 주소, 취소·영수증 안내가 검증되기 전에는 외부 결제 경로를 열지 않습니다." })
    );
    append(page, sectionWrap(card, append(node("div", { className: "info-stack" }), caution)));
    showScreen(page);
    document.title = `시주 안내 · 마음숲`;
  }

  async function renderTemple() {
    const tenant = await loadTenant();
    setTenantName(tenant.name);
    const page = node("div", { attrs: { "data-screen": "temple" } });
    append(page, pageHero("절 소개", "고요가 머무는 곳", "매일 한 편의 말씀으로 마음 가까이에 산사의 쉼을 전합니다."));
    const panel = node("article", { className: "temple-panel" });
    append(panel,
      node("div", { className: "temple-seal", text: tenant.name, attrs: { "aria-hidden": "true" } }),
      node("h2", { text: tenant.name }),
      node("p", { text: tenant.intro })
    );
    const pilot = node("article", { className: "info-card" });
    append(pilot,
      node("span", { className: "status-chip", text: "파일럿 안내" }),
      node("h2", { text: "검증을 위한 가상 절입니다" }),
      node("p", { text: "실제 절이 확정되면 감수된 소개와 절 명의 정보로 안전하게 교체됩니다." })
    );
    append(page, sectionWrap(panel, append(node("div", { className: "info-stack" }), pilot)));
    showScreen(page);
    document.title = `${tenant.name} 소개 · 마음숲`;
  }

  async function renderSettings() {
    const tenant = await loadTenant();
    setTenantName(tenant.name);
    const page = node("div", { attrs: { "data-screen": "settings" } });
    append(page, pageHero("이 기기 설정", "내 마음의 자리는 가볍게", "기도 완료와 화면 글자 설정만 이 브라우저에 남습니다."));
    const card = node("article", { className: "info-card" });
    const textGroup = node("section", { className: "settings-group", attrs: { "aria-labelledby": "text-setting-title" } });
    const choiceRow = node("div", { className: "choice-row" });
    const storedScale = safeGet("textScale") === "large" ? "large" : "normal";
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
      node("p", { className: "settings-copy", text: "이 브라우저에 저장된 기도 완료와 글자 설정을 모두 지웁니다. 절이나 다른 기기로 전송된 데이터는 없습니다." }),
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
      safeSet("textScale", value);
      applyTextScale(value);
      normalButton.setAttribute("aria-pressed", String(value === "normal"));
      largeButton.setAttribute("aria-pressed", String(value === "large"));
      showToast(value === "large" ? "큰 글자로 바꿨어요" : "기본 글자로 바꿨어요");
    }
    normalButton.addEventListener("click", () => selectScale("normal"));
    largeButton.addEventListener("click", () => selectScale("large"));
    resetButton.addEventListener("click", () => {
      const approved = window.confirm("이 기기에 저장된 기도 완료와 화면 설정을 모두 지울까요?");
      if (!approved) return;
      if (safeRemoveAll()) {
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
    document.title = `지난 말씀 · 마음숲`;
  }

  function setTenantName(name) {
    document.getElementById("tenant-name-header").textContent = name;
  }

  function setNavigation(route) {
    for (const item of document.querySelectorAll("[data-nav], [data-menu]")) {
      item.removeAttribute("aria-current");
      const value = item.dataset.nav || item.dataset.menu;
      if (value === route) item.setAttribute("aria-current", "page");
    }
    if (["donation", "temple", "settings"].includes(route)) document.getElementById("bottom-more").setAttribute("aria-current", "page");
  }

  function setupMenu() {
    const panel = document.getElementById("more-panel");
    const backdrop = document.getElementById("sheet-backdrop");
    const openers = [document.getElementById("open-more"), document.getElementById("bottom-more")];
    const closeButton = document.getElementById("close-more");
    let returnFocus = null;

    function openMenu(event) {
      returnFocus = event.currentTarget;
      panel.hidden = false;
      backdrop.hidden = false;
      for (const opener of openers) opener.setAttribute("aria-expanded", "true");
      closeButton.focus();
    }

    function closeMenu() {
      panel.hidden = true;
      backdrop.hidden = true;
      for (const opener of openers) opener.setAttribute("aria-expanded", "false");
      if (returnFocus) returnFocus.focus();
    }

    for (const opener of openers) opener.addEventListener("click", openMenu);
    closeButton.addEventListener("click", closeMenu);
    backdrop.addEventListener("click", closeMenu);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) closeMenu();
    });
  }

  function updateConnectivity() {
    offlineBanner.hidden = navigator.onLine;
    document.body.classList.toggle("is-offline", !navigator.onLine);
  }

  // 배경 음악(BGM) 컨트롤. 브라우저 자동재생 정책상 소리는 사용자가 '노래 듣기'를 눌러야 시작된다.
  // 무음(정지) 선택과 재생 위치는 이 기기에만 저장(개인정보 무수집 원칙)한다. 다중 페이지 앱이라
  // 화면 이동 시 저장한 위치에서 이어 재생을 시도한다(자동재생이 막히면 다시 '노래 듣기'로 표시).
  const BGM_SRC = "/maeumsup/audio/bgm.mp3";
  function setupBgm() {
    const header = document.querySelector(".site-header");
    const menuButton = document.getElementById("open-more");
    if (!header || !menuButton) return;
    const audio = new Audio(BGM_SRC);
    audio.loop = true;
    audio.preload = "auto";   // 모바일에서 탭 즉시 재생되도록 미리 로드
    audio.setAttribute("playsinline", "");
    const savedTime = parseFloat(safeGet("bgmTime") || "0");
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
      const t = parseFloat(safeGet("bgmTime") || "0");
      if (t > 0 && isFinite(t)) { try { audio.currentTime = t; } catch (e) {} }
      if (promise && typeof promise.then === "function") {
        promise.then(() => {
          safeSet("bgmOn", "on");
          setLabel(true);
          if (userInitiated && safeGet("bgmHintShown") !== "1") {
            safeSet("bgmHintShown", "1");
            showToast("소리가 안 들리면 휴대폰 무음(벨소리) 스위치와 볼륨을 확인해 주세요");
          }
        }).catch(() => {
          safeSet("bgmOn", "on");     // 의사는 재생 — 다음 상호작용에서 재시도
          setLabel(false);
          if (userInitiated) showToast("브라우저가 재생을 막았어요. 화면을 한 번 더 눌러 주세요");
        });
      } else {
        safeSet("bgmOn", "on");
        setLabel(true);
      }
    }
    function pause() {
      audio.pause();
      safeSet("bgmTime", String(audio.currentTime || 0));
      safeSet("bgmOn", "off");
      setLabel(false);
    }
    button.addEventListener("click", () => { if (audio.paused) play(true); else pause(); });
    audio.addEventListener("timeupdate", () => {
      const now = audio.currentTime || 0;
      if (Math.abs(now - lastSaved) >= 3) { lastSaved = now; safeSet("bgmTime", String(now)); }
    });
    window.addEventListener("pagehide", () => { if (!audio.paused) safeSet("bgmTime", String(audio.currentTime || 0)); });
    if (safeGet("bgmOn") === "on") play(false);   // 재방문/화면이동 시 이어 재생 시도(제스처 없음 → 조용히)
  }

  // 첫 사용 온보딩. 처음 방문한 신도에게 이 앱이 무엇이고 어떻게 쓰는지, 그리고 개인정보를
  // 모으지 않는다는 점을 조용히 안내한다. 본 적 있으면(localStorage) 뜨지 않는다.
  // force=true(설정의 '다시 보기')면 항상 표시. 개인정보 무수집 원칙에 맞게 로컬 플래그만 사용.
  function showWelcome(force = false) {
    if (!force && safeGet("welcomeSeen") === "1") return;
    const prior = document.getElementById("welcome-overlay");
    if (prior) prior.remove();
    const overlay = node("div", { id: "welcome-overlay", className: "welcome-overlay", attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": "welcome-title" } });
    const card = node("div", { className: "welcome-card" });
    append(card,
      node("span", { className: "welcome-mark", text: "숲", attrs: { "aria-hidden": "true" } }),
      node("h2", { id: "welcome-title", className: "welcome-title", text: "마음숲에 오신 것을 환영합니다" }),
      node("p", { className: "welcome-sub", text: "매일 한 편의 말씀으로 마음을 챙기는 조용한 공간입니다." })
    );
    const steps = node("div", { className: "welcome-steps" });
    const points = [
      ["오늘", "오늘의 말씀을 읽고, 목탁 소리로 3분 호흡한 뒤, 짧은 기도로 하루를 엽니다."],
      ["연등", "함께 밝힌 마음을 이름 없이 ‘몇 분이 함께했는지’ 수로만 보여드립니다."],
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
      safeSet("welcomeSeen", "1");
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
    donation: renderDonation,
    temple: renderTemple,
    settings: renderSettings,
    archive: renderArchive
  };

  function routeFromHref(href) {
    try {
      const parts = new URL(href, location.href).pathname.split("/").filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i -= 1) if (ROUTES.has(parts[i])) return parts[i];
    } catch (e) { /* 무시 */ }
    return null;
  }

  function closeMorePanel() {
    const panel = document.getElementById("more-panel");
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    const backdrop = document.getElementById("sheet-backdrop");
    if (backdrop) backdrop.hidden = true;
    for (const opener of [document.getElementById("open-more"), document.getElementById("bottom-more")]) {
      if (opener) opener.setAttribute("aria-expanded", "false");
    }
  }

  // 화면 이동을 페이지 새로고침이 아니라 앱 내부 전환(render)으로 처리한다.
  // 페이지가 유지되므로 배경 음악(BGM) 오디오·재생 위치가 끊기지 않는다.
  async function navigateTo(href, push) {
    const route = routeFromHref(href);
    if (!route) { window.location.href = href; return; }   // 라우트 아님 → 일반 이동
    if (push !== false) { try { history.pushState({ route: route }, "", href); } catch (e) {} }
    closeMorePanel();
    setNavigation(route);
    window.scrollTo(0, 0);
    try { await RENDERERS[route](); } catch (error) { renderDataError(error); }
  }

  function setupSpaNav() {
    document.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest ? event.target.closest("a[href]") : null;
      if (!link || link.target === "_blank") return;
      const href = link.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("http")) return;
      if (!routeFromHref(href)) return;   // 라우트 링크가 아니면 브라우저 기본 동작
      event.preventDefault();
      navigateTo(href, true);
    });
    window.addEventListener("popstate", () => { navigateTo(location.href, false); });
  }

  async function boot() {
    applyTextScale(safeGet("textScale"));
    setupMenu();
    setupBgm();
    setupSpaNav();
    updateConnectivity();
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);
    const route = getRoute();
    setNavigation(route);
    const renderers = RENDERERS;

    const swActive = "serviceWorker" in navigator && location.protocol !== "file:";
    if (swActive) {
      navigator.serviceWorker.register("/maeumsup/service-worker.js").catch(() => {});
    }
    // N-01: 서비스워커가 이미 제어 중(재방문)이면 release marker reconcile 를 **콘텐츠 로드보다 먼저**
    // 완료시킨다. 승격/철회로 marker 가 바뀌면 SW 가 옛 콘텐츠 캐시를 통째로 무효화하는데, 콘텐츠를
    // 먼저 캐시한 뒤 무효화하면 방금 채운 최신 승인본까지 지워져 즉시 offline 시 유실된다.
    // reconcile 선행 → 무효화가 끝난 뒤 콘텐츠가 캐시되므로 online 최신·즉시 offline 최신본이 보장된다.
    if (swActive && navigator.serviceWorker.controller) {
      try { await fetch(`/maeumsup/data/${TENANT}/release.json`, { cache: "no-store" }); } catch (e) { /* offline: SW 캐시 폴백 */ }
    }

    try {
      await renderers[route]();
    } catch (error) {
      renderDataError(error);
    }

    // 첫 방문 온보딩은 메인 진입(오늘)에서만 조용히 띄운다.
    if (route === "today") showWelcome();

    // 첫 방문(비제어): SW 설치 후 다음 방문의 무효화 기준선을 잡도록 marker 를 비차단 프리페치.
    if (swActive && !navigator.serviceWorker.controller) {
      fetch(`/maeumsup/data/${TENANT}/release.json`, { cache: "no-store" }).catch(() => {});
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
