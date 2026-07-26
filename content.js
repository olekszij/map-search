// Maps Lead Scraper — content script (phases 1–5)
(function () {
  if (window.__mapsLeadScraperLoaded) return;
  window.__mapsLeadScraperLoaded = true;

  const S = typeof MLS_SELECTORS !== "undefined" ? MLS_SELECTORS : {};
  const MAX_CARDS = 60;
  const CARD_TIMEOUT_MS = 10000;
  const PANEL_ID = "mls-panel";

  let running = false;
  let paused = false;
  let stopRequested = false;
  let results = [];
  let seenKeys = new Set();
  let pendingCards = [];
  let queueIndex = 0;
  let loadAllMode = false;
  let searchQuery = "";
  let zoneMode = "zone";
  let timings = [];
  let sortKey = "score";
  let sortDir = -1;
  let filterChip = "all";
  let filterSearch = "";
  let minRating = 0;
  let randomDelayOn = true;
  let baseDelay = 1400;
  let colWidths = {};
  let prevName = "";
  let skipped = 0;

  const COLS = [
    { key: "score", label: "⭐", w: 36 },
    { key: "name", label: "Name", w: 140 },
    { key: "category", label: "Category", w: 90 },
    { key: "address", label: "Address", w: 140 },
    { key: "phoneE164", label: "Phone", w: 100 },
    { key: "website", label: "Website", w: 110 },
    { key: "email", label: "Email", w: 90 },
    { key: "rating", label: "★", w: 36 },
    { key: "reviews", label: "Reviews", w: 44 },
    { key: "openNow", label: "Open Now", w: 70 },
    { key: "hours", label: "Hours", w: 90 },
    { key: "businessStatus", label: "Status", w: 70 },
    { key: "priceLevel", label: "€", w: 36 },
    { key: "placeId", label: "Place ID", w: 90 },
    { key: "postalCode", label: "CP", w: 50 },
    { key: "city", label: "City", w: 70 },
    { key: "lat", label: "Lat", w: 60 },
    { key: "lng", label: "Lng", w: 60 },
    { key: "bookingUrl", label: "Booking", w: 80 },
    { key: "social", label: "Social", w: 80 },
    { key: "websiteCheck", label: "Site✓", w: 70 },
    { key: "leadStatus", label: "Lead", w: 70 },
    { key: "scrapedAt", label: "Date", w: 80 },
    { key: "queryZone", label: "Zone/Query", w: 100 },
    { key: "about", label: "About", w: 120 },
    { key: "whatsapp", label: "WhatsApp", w: 90 },
    { key: "mapsUrl", label: "Maps URL", w: 120 },
  ];

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function withTimeout(promise, ms, fallback) {
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  }

  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (_) {}
  }

  function persist() {
    try {
      chrome.storage.local.set({
        mls_results: results,
        mls_running: running,
        mls_paused: paused,
        mls_pending: pendingCards,
        mls_queueIndex: queueIndex,
        mls_seen: Array.from(seenKeys),
        mls_ui: {
          filterChip,
          filterSearch,
          minRating,
          randomDelayOn,
          baseDelay,
          zoneMode,
          colWidths,
          sortKey,
          sortDir,
        },
      });
    } catch (_) {}
  }

  function setPanelStatus(text) {
    const el = document.getElementById("mls-status");
    if (el) el.textContent = text;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function firstMatch(selectors, root = document) {
    const list = selectors || [];
    for (const sel of list) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function getFeed() {
    return firstMatch(S.feed || ['div[role="feed"]']);
  }

  function detectCaptcha() {
    const href = location.href || "";
    const body = (document.body && document.body.innerText) || "";
    const needles = S.captcha || ["unusual traffic", "/sorry/", "recaptcha"];
    return needles.some(
      (n) => href.toLowerCase().includes(n.toLowerCase()) || body.includes(n)
    );
  }

  function isSponsoredAnchor(a) {
    const blob =
      ((a.getAttribute("aria-label") || "") +
        " " +
        (a.parentElement && a.parentElement.textContent
          ? a.parentElement.textContent.slice(0, 200)
          : "")).toLowerCase();
    const words = (S.sponsored || ["sponsored", "sponsorisé", "annonce", "promoted"]).map(
      (w) => w.toLowerCase()
    );
    return words.some((w) => blob.includes(w));
  }

  function nextDelay() {
    if (!randomDelayOn) return Math.max(baseDelay, 900);
    return 1200 + Math.floor(Math.random() * 1300);
  }

  function cleanLabeledText(raw) {
    if (!raw) return "";
    let t = String(raw).replace(/\s+/g, " ").trim();
    t = t.replace(
      /^(Address|Adresse|Adresa|Phone|Telephone|Téléphone|Tel|Tél|Website|Site web|Category|Catégorie|Plus code|Horaires|Hours)\s*[:：]\s*/i,
      ""
    );
    const m = t.match(/^(.+?)\s+\1$/i);
    if (m) t = m[1];
    return t.trim();
  }

  function placeKey(href) {
    if (!href) return "";
    const id = href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
    if (id) return id[1].toLowerCase();
    const cid = href.match(/[?&]cid=(\d+)/i);
    if (cid) return "cid:" + cid[1];
    try {
      const u = new URL(href, location.origin);
      const parts = u.pathname.split("/").filter(Boolean);
      const i = parts.indexOf("place");
      if (i >= 0 && parts[i + 1]) return decodeURIComponent(parts[i + 1]).toLowerCase();
      return u.pathname;
    } catch (_) {
      return href;
    }
  }

  function fullMapsUrl(href) {
    if (!href) return location.href;
    if (href.startsWith("http")) return href;
    return "https://www.google.com" + (href.startsWith("/") ? href : "/" + href);
  }

  function normalizePhoneE164(phone) {
    if (!phone) return "";
    let d = String(phone).replace(/[^\d+]/g, "");
    if (d.startsWith("00")) d = "+" + d.slice(2);
    if (d.startsWith("0") && !d.startsWith("00")) d = "+33" + d.slice(1);
    if (/^\d{9,10}$/.test(d)) d = "+33" + d.replace(/^0/, "");
    return d;
  }

  function parseAddressParts(address) {
    const out = { street: "", postalCode: "", city: "", country: "" };
    if (!address) return out;
    const cp = address.match(/\b(\d{5})\b/);
    if (cp) out.postalCode = cp[1];
    const parts = address.split(",").map((p) => p.trim());
    if (parts.length) out.street = parts[0];
    if (parts.length >= 2) {
      const mid = parts[parts.length - 2] || parts[1];
      out.city = mid.replace(/\b\d{5}\b/, "").trim() || mid;
    }
    if (parts.length >= 3) out.country = parts[parts.length - 1];
    return out;
  }

  function coordsFromHref(href) {
    const m = (href || location.href).match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) return { lat: m[1], lng: m[2] };
    return { lat: "", lng: "" };
  }

  function computeScore(r) {
    let s = 50;
    if (!r.website) s += 35;
    else s -= 10;
    if (!r.phone && !r.phoneE164) s -= 15;
    else s += 10;
    const rating = parseFloat(String(r.rating || "").replace(",", "."));
    if (!isNaN(rating)) {
      if (rating < 3.5) s -= 10;
      else if (rating >= 4.2) s += 5;
    }
    if (r.businessStatus && /permanently|définitivement/i.test(r.businessStatus)) s -= 40;
    if (r.email) s += 5;
    return Math.max(0, Math.min(100, s));
  }

  function leadStatusOf(r) {
    if (r.businessStatus && /permanently|définitivement/i.test(r.businessStatus)) return "closed";
    if (!r.website) return "no_website";
    return "has_website";
  }

  function enrichRow(data, card) {
    const phoneE164 = normalizePhoneE164(data.phone);
    const parts = parseAddressParts(data.address);
    const coords = coordsFromHref(data.mapsUrl || card.href);
    const row = {
      ...data,
      phoneE164,
      postalCode: parts.postalCode,
      city: parts.city,
      street: parts.street,
      country: parts.country,
      lat: data.lat || coords.lat,
      lng: data.lng || coords.lng,
      placeId: data.placeId || card.key || placeKey(card.href),
      scrapedAt: new Date().toISOString().slice(0, 19),
      queryZone: (zoneMode === "zone" ? "zone: " : "all: ") + (searchQuery || "—"),
      source: "google_maps",
      assignee: "",
      notes: "",
      websiteCheck: data.websiteCheck || "",
      social: data.social || "",
      bookingUrl: data.bookingUrl || "",
      whatsapp: data.whatsapp || "",
      about: data.about || "",
      photoCount: data.photoCount || "",
      attributes: data.attributes || "",
      claimed: data.claimed || "",
      priceLevel: data.priceLevel || "",
      plusCode: data.plusCode || "",
      hours: data.hours || "",
      openNow: data.openNow || "",
      businessStatus: data.businessStatus || "",
      email: data.email || "",
    };
    row.leadStatus = leadStatusOf(row);
    row.score = computeScore(row);
    row.dedupeKey = row.placeId + "|" + (row.phoneE164 || "");
    return row;
  }

  function readSearchQuery() {
    const input =
      document.querySelector("#searchboxinput") ||
      document.querySelector('input[name="q"]') ||
      document.querySelector('form[role="search"] input');
    return input ? String(input.value || "").trim() : "";
  }

  function getFilteredRows() {
    let rows = results.slice();
    if (filterChip === "nosite") rows = rows.filter((r) => !r.website);
    if (filterChip === "phone") rows = rows.filter((r) => r.phone || r.phoneE164);
    if (filterSearch) {
      const q = filterSearch.toLowerCase();
      rows = rows.filter((r) => (r.name || "").toLowerCase().includes(q));
    }
    if (minRating > 0) {
      rows = rows.filter((r) => {
        const v = parseFloat(String(r.rating || "").replace(",", "."));
        return !isNaN(v) && v >= minRating;
      });
    }
    if (sortKey) {
      rows.sort((a, b) => {
        let va = a[sortKey];
        let vb = b[sortKey];
        if (sortKey === "score" || sortKey === "rating" || sortKey === "reviews") {
          va = parseFloat(String(va || "0").replace(",", ".")) || 0;
          vb = parseFloat(String(vb || "0").replace(",", ".")) || 0;
          return (va - vb) * sortDir;
        }
        va = String(va || "").toLowerCase();
        vb = String(vb || "").toLowerCase();
        if (va < vb) return -1 * sortDir;
        if (va > vb) return 1 * sortDir;
        return 0;
      });
    }
    return rows;
  }

  function updateBadges() {
    const all = results.length;
    const nosite = results.filter((r) => !r.website).length;
    const elAll = document.getElementById("mls-count");
    const elLead = document.getElementById("mls-leads");
    if (elAll) elAll.textContent = String(all);
    if (elLead) elLead.textContent = String(nosite);
  }

  function updateProgress(done, total) {
    const bar = document.getElementById("mls-progress-bar");
    const label = document.getElementById("mls-progress-label");
    const pct = total ? Math.round((done / total) * 100) : 0;
    if (bar) bar.style.width = pct + "%";
    let eta = "";
    if (timings.length && done < total) {
      const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
      const left = Math.round(((total - done) * avg) / 1000);
      eta = ` · ETA ~${left}s`;
    }
    if (label) label.textContent = `${done}/${total}${eta}`;
  }

  function renderTable() {
    const wrap = document.getElementById("mls-table-wrap");
    if (!wrap) return;
    updateBadges();
    const rows = getFilteredRows();
    if (!rows.length) {
      wrap.innerHTML =
        '<div class="mls-empty">No rows by filter — remove filter or click Start.</div>';
      return;
    }
    let html = '<table class="mls-table"><thead><tr>';
    COLS.forEach((c) => {
      const w = colWidths[c.key] || c.w;
      const mark = sortKey === c.key ? (sortDir > 0 ? " ▲" : " ▼") : "";
      html += `<th data-key="${c.key}" style="width:${w}px">${esc(c.label)}${mark}<span class="mls-col-resizer" data-key="${c.key}"></span></th>`;
    });
    html += "</tr></thead><tbody>";
    rows.forEach((r) => {
      const lead = !r.website;
      html += `<tr class="${lead ? "mls-lead" : ""}" data-url="${esc(r.mapsUrl || "")}">`;
      COLS.forEach((c) => {
        let val = r[c.key];
        if (c.key === "website") {
          if (!val) {
            html += '<td class="mls-nosite-cell">— none —</td>';
            return;
          }
          html += `<td class="mls-site"><a href="${esc(val)}" target="_blank" rel="noopener">${esc(
            String(val).replace(/^https?:\/\//, "").slice(0, 28)
          )}</a></td>`;
          return;
        }
        if (c.key === "score") {
          html += `<td>${esc(val)}${lead ? " ⭐" : ""}</td>`;
          return;
        }
        if (c.key === "phoneE164") {
          html += `<td>${esc(val || r.phone || "")}</td>`;
          return;
        }
        html += `<td title="${esc(val)}">${esc(val)}</td>`;
      });
      html += "</tr>";
    });
    html += "</tbody></table>";
    wrap.innerHTML = html;

    wrap.querySelectorAll("th[data-key]").forEach((th) => {
      th.addEventListener("click", (e) => {
        if (e.target.classList.contains("mls-col-resizer")) return;
        const key = th.getAttribute("data-key");
        if (sortKey === key) sortDir *= -1;
        else {
          sortKey = key;
          sortDir = key === "score" || key === "rating" ? -1 : 1;
        }
        persist();
        renderTable();
      });
    });
    wrap.querySelectorAll(".mls-col-resizer").forEach((handle) => {
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = handle.getAttribute("data-key");
        const startX = e.clientX;
        const startW = colWidths[key] || COLS.find((c) => c.key === key).w;
        const move = (ev) => {
          colWidths[key] = Math.max(36, startW + (ev.clientX - startX));
          renderTable();
        };
        const up = () => {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          persist();
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });
    });
    wrap.querySelectorAll("tbody tr").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        const url = tr.getAttribute("data-url");
        if (url) location.assign(url);
      });
    });
  }

  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="mls-head" id="mls-drag">
        <div class="mls-title">Maps Lead Scraper
          <span class="mls-badge" id="mls-count">0</span>
          <span class="mls-badge mls-amber" id="mls-leads" title="No website">0⭐</span>
        </div>
        <div class="mls-head-actions">
          <button type="button" id="mls-toggle" title="Collapse">▾</button>
        </div>
      </div>
      <div id="mls-body">
        <div class="mls-toolbar">
          <div class="mls-seg" id="mls-zone-seg">
            <button type="button" data-zone="zone" class="active">Zone</button>
            <button type="button" data-zone="all">Full List</button>
          </div>
          <div class="mls-stepper">
            <button type="button" id="mls-delay-minus">−</button>
            <input id="mls-delay" type="number" value="1400" min="900" step="100" />
            <button type="button" id="mls-delay-plus">+</button>
            <span class="mls-hint">ms</span>
          </div>
          <label class="mls-toggle-row"><input id="mls-random" type="checkbox" checked /> Random 1.2–2.5s</label>
        </div>
        <div class="mls-btns">
          <button id="mls-start" type="button">Start</button>
          <button id="mls-pause" type="button">Pause</button>
          <button id="mls-clear" type="button" class="ghost">Clear</button>
          <button id="mls-csv" type="button" class="outline">CSV</button>
          <button id="mls-copy" type="button" class="outline">Copy</button>
          <button id="mls-xlsx" type="button" class="outline">Excel</button>
        </div>
        <div class="mls-btns mls-btns2">
          <button id="mls-check" type="button" class="ghost">Check Sites</button>
          <button id="mls-sheet" type="button" class="ghost">Sheet</button>
          <button id="mls-save-session" type="button" class="ghost">Save</button>
          <button id="mls-load-session" type="button" class="ghost">Load</button>
        </div>
        <div class="mls-filters">
          <div class="mls-chips" id="mls-chips">
            <button type="button" data-chip="all" class="active">All</button>
            <button type="button" data-chip="nosite">No Website</button>
            <button type="button" data-chip="phone">Has Phone</button>
          </div>
          <input id="mls-search" type="search" placeholder="Search by name…" />
          <label class="mls-rating">Min ★
            <input id="mls-minrating" type="number" min="0" max="5" step="0.1" value="0" />
          </label>
        </div>
        <div class="mls-progress-wrap">
          <div class="mls-progress"><div id="mls-progress-bar"></div></div>
          <span id="mls-progress-label">0/0</span>
        </div>
        <div id="mls-status">Zoom → 'Rechercher dans cette zone' → Start. Data is appended, not overwritten.</div>
        <div id="mls-table-wrap"><div class="mls-empty">Table empty — click Start.</div></div>
        <div id="mls-sessions" class="mls-sessions hidden"></div>
      </div>
      <div id="mls-resize"></div>
    `;
    const style = document.createElement("style");
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&display=swap');
      #${PANEL_ID} {
        position: fixed; top: 64px; right: 12px; z-index: 2147483647;
        width: min(780px, calc(100vw - 20px)); height: min(640px, calc(100vh - 80px));
        display: flex; flex-direction: column;
        padding: 12px 12px 8px; border-radius: 14px;
        background: #F7F8FA; color: #111827;
        font: 13px/1.35 Manrope, system-ui, sans-serif;
        box-shadow: 0 12px 40px rgba(15,23,42,.18); border: 1px solid #E5E7EB;
      }
      #${PANEL_ID}.mls-collapsed { width: 300px; height: auto; }
      #${PANEL_ID}.mls-collapsed #mls-table-wrap,
      #${PANEL_ID}.mls-collapsed .mls-filters,
      #${PANEL_ID}.mls-collapsed .mls-btns2,
      #${PANEL_ID}.mls-collapsed .mls-progress-wrap { display: none; }
      #${PANEL_ID} .mls-head {
        display: flex; align-items: center; justify-content: space-between;
        cursor: move; margin-bottom: 8px; user-select: none;
      }
      #${PANEL_ID} .mls-title { font-weight: 700; color: #0F766E; display: flex; gap: 6px; align-items: center; }
      #${PANEL_ID} .mls-badge {
        background: #CCFBF1; color: #0F766E; font-size: 11px; padding: 2px 8px; border-radius: 8px; font-weight: 700;
      }
      #${PANEL_ID} .mls-badge.mls-amber { background: #FEF3C7; color: #D97706; }
      #${PANEL_ID} #mls-toggle {
        width: 28px; border: 1px solid #E5E7EB; background: #fff; border-radius: 8px; cursor: pointer;
      }
      #${PANEL_ID} .mls-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
      #${PANEL_ID} .mls-seg {
        display: inline-flex; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; overflow: hidden;
      }
      #${PANEL_ID} .mls-seg button {
        border: 0; background: transparent; padding: 6px 10px; cursor: pointer; font: inherit; color: #6B7280;
      }
      #${PANEL_ID} .mls-seg button.active { background: #0F766E; color: #fff; font-weight: 600; }
      #${PANEL_ID} .mls-stepper { display: inline-flex; align-items: center; gap: 4px; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 2px; }
      #${PANEL_ID} .mls-stepper button { width: 28px; border: 0; background: #F3F4F6; border-radius: 8px; cursor: pointer; }
      #${PANEL_ID} .mls-stepper input { width: 64px; border: 0; text-align: center; font: inherit; }
      #${PANEL_ID} .mls-hint { font-size: 11px; color: #9CA3AF; padding-right: 6px; }
      #${PANEL_ID} .mls-toggle-row { font-size: 12px; color: #6B7280; display: flex; gap: 4px; align-items: center; }
      #${PANEL_ID} .mls-btns, #${PANEL_ID} .mls-btns2 { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
      #${PANEL_ID} .mls-btns button, #${PANEL_ID} .mls-btns2 button {
        border: 0; border-radius: 9px; padding: 7px 10px; cursor: pointer; font-weight: 600; font: inherit; font-size: 12px;
        background: #0F766E; color: #fff;
      }
      #${PANEL_ID} #mls-pause { background: #D97706; }
      #${PANEL_ID} button.ghost { background: #fff; color: #374151; border: 1px solid #E5E7EB; }
      #${PANEL_ID} button.outline { background: #fff; color: #0F766E; border: 1px solid #99F6E4; }
      #${PANEL_ID} .mls-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
      #${PANEL_ID} .mls-chips { display: inline-flex; gap: 4px; }
      #${PANEL_ID} .mls-chips button {
        border: 1px solid #E5E7EB; background: #fff; border-radius: 999px; padding: 5px 10px; cursor: pointer;
        font: inherit; font-size: 12px; color: #6B7280;
      }
      #${PANEL_ID} .mls-chips button.active { background: #ECFDF5; border-color: #99F6E4; color: #0F766E; font-weight: 600; }
      #${PANEL_ID} #mls-search {
        flex: 1; min-width: 140px; border: 1px solid #E5E7EB; border-radius: 9px; padding: 6px 10px; font: inherit;
      }
      #${PANEL_ID} .mls-rating { font-size: 12px; color: #6B7280; display: flex; gap: 4px; align-items: center; }
      #${PANEL_ID} .mls-rating input { width: 52px; border: 1px solid #E5E7EB; border-radius: 8px; padding: 4px; }
      #${PANEL_ID} .mls-progress-wrap { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
      #${PANEL_ID} .mls-progress { flex: 1; height: 6px; background: #E5E7EB; border-radius: 99px; overflow: hidden; }
      #${PANEL_ID} #mls-progress-bar { height: 100%; width: 0; background: #0F766E; transition: width .2s; }
      #${PANEL_ID} #mls-progress-label { font-size: 11px; color: #6B7280; min-width: 70px; }
      #${PANEL_ID} #mls-status { font-size: 11px; color: #6B7280; margin-bottom: 6px; white-space: pre-wrap; max-height: 40px; overflow: auto; }
      #${PANEL_ID} #mls-table-wrap {
        flex: 1; min-height: 160px; overflow: auto; border: 1px solid #E5E7EB; border-radius: 10px; background: #fff;
      }
      #${PANEL_ID} .mls-empty { padding: 20px; color: #9CA3AF; }
      #${PANEL_ID} .mls-table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 11px; }
      #${PANEL_ID} .mls-table th {
        position: sticky; top: 0; background: #F3F4F6; color: #0F766E; text-align: left;
        padding: 6px 6px; border-bottom: 1px solid #E5E7EB; white-space: nowrap; z-index: 1; cursor: pointer;
        position: sticky;
      }
      #${PANEL_ID} .mls-col-resizer {
        position: absolute; right: 0; top: 0; width: 5px; height: 100%; cursor: col-resize;
      }
      #${PANEL_ID} .mls-table th { position: sticky; }
      #${PANEL_ID} .mls-table th { position: relative; }
      #${PANEL_ID} .mls-table td {
        padding: 5px 6px; border-bottom: 1px solid #F3F4F6; max-width: 180px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
      }
      #${PANEL_ID} .mls-table tr:nth-child(even) td { background: #FAFAFA; }
      #${PANEL_ID} .mls-table tr:hover td { background: #ECFDF5; }
      #${PANEL_ID} .mls-table tr.mls-lead td { background: #FFFBEB; }
      #${PANEL_ID} .mls-nosite-cell { color: #D97706; font-style: italic; }
      #${PANEL_ID} .mls-site a { color: #0F766E; text-decoration: none; }
      #${PANEL_ID} #mls-resize {
        position: absolute; right: 4px; bottom: 4px; width: 14px; height: 14px; cursor: nwse-resize;
        background: linear-gradient(135deg, transparent 50%, #9CA3AF 50%);
        border-radius: 2px;
      }
      #${PANEL_ID} .mls-sessions { max-height: 120px; overflow: auto; border-top: 1px solid #E5E7EB; margin-top: 6px; padding-top: 6px; }
      #${PANEL_ID} .mls-sessions button { margin: 2px; font-size: 11px; }
      #${PANEL_ID} .hidden { display: none !important; }
      #${PANEL_ID} #mls-body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    `;
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(panel);
    panel.addEventListener("mousedown", (e) => e.stopPropagation());
    panel.addEventListener("click", (e) => e.stopPropagation());

    // drag
    (function enableDrag() {
      const head = document.getElementById("mls-drag");
      let ox = 0,
        oy = 0,
        dragging = false;
      head.addEventListener("mousedown", (e) => {
        if (e.target.closest("button")) return;
        dragging = true;
        const rect = panel.getBoundingClientRect();
        ox = e.clientX - rect.left;
        oy = e.clientY - rect.top;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
      });
      document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        panel.style.left = Math.max(0, e.clientX - ox) + "px";
        panel.style.top = Math.max(0, e.clientY - oy) + "px";
      });
      document.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        chrome.storage.local.set({
          mls_panel_pos: { left: panel.style.left, top: panel.style.top, width: panel.style.width, height: panel.style.height },
        });
      });
    })();

    // resize
    (function enableResize() {
      const handle = document.getElementById("mls-resize");
      let resizing = false,
        sx,
        sy,
        sw,
        sh;
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        resizing = true;
        sx = e.clientX;
        sy = e.clientY;
        sw = panel.offsetWidth;
        sh = panel.offsetHeight;
      });
      document.addEventListener("mousemove", (e) => {
        if (!resizing) return;
        panel.style.width = Math.max(360, sw + (e.clientX - sx)) + "px";
        panel.style.height = Math.max(320, sh + (e.clientY - sy)) + "px";
      });
      document.addEventListener("mouseup", () => {
        if (!resizing) return;
        resizing = false;
        chrome.storage.local.set({
          mls_panel_pos: {
            left: panel.style.left,
            top: panel.style.top,
            width: panel.style.width,
            height: panel.style.height,
          },
        });
      });
    })();

    chrome.storage.local.get(["mls_panel_pos"], (data) => {
      const p = data.mls_panel_pos;
      if (!p) return;
      if (p.left) {
        panel.style.right = "auto";
        panel.style.left = p.left;
      }
      if (p.top) panel.style.top = p.top;
      if (p.width) panel.style.width = p.width;
      if (p.height) panel.style.height = p.height;
    });

    document.getElementById("mls-toggle").addEventListener("click", () => {
      panel.classList.toggle("mls-collapsed");
      document.getElementById("mls-toggle").textContent = panel.classList.contains("mls-collapsed")
        ? "▸"
        : "▾";
    });

    document.querySelectorAll("#mls-zone-seg button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#mls-zone-seg button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        zoneMode = btn.getAttribute("data-zone");
        loadAllMode = zoneMode === "all";
        persist();
      });
    });

    const delayInput = document.getElementById("mls-delay");
    document.getElementById("mls-delay-minus").addEventListener("click", () => {
      delayInput.value = Math.max(900, (parseInt(delayInput.value, 10) || 1400) - 100);
      baseDelay = parseInt(delayInput.value, 10);
      persist();
    });
    document.getElementById("mls-delay-plus").addEventListener("click", () => {
      delayInput.value = (parseInt(delayInput.value, 10) || 1400) + 100;
      baseDelay = parseInt(delayInput.value, 10);
      persist();
    });
    delayInput.addEventListener("change", () => {
      baseDelay = parseInt(delayInput.value, 10) || 1400;
      persist();
    });
    document.getElementById("mls-random").addEventListener("change", (e) => {
      randomDelayOn = e.target.checked;
      persist();
    });

    document.querySelectorAll("#mls-chips button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#mls-chips button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        filterChip = btn.getAttribute("data-chip");
        persist();
        renderTable();
      });
    });
    document.getElementById("mls-search").addEventListener("input", (e) => {
      filterSearch = e.target.value.trim();
      persist();
      renderTable();
    });
    document.getElementById("mls-minrating").addEventListener("change", (e) => {
      minRating = parseFloat(e.target.value) || 0;
      persist();
      renderTable();
    });

    document.getElementById("mls-start").addEventListener("click", () => {
      baseDelay = parseInt(document.getElementById("mls-delay").value, 10) || 1400;
      loadAllMode = zoneMode === "all";
      if (!running) startRun({ loadAll: loadAllMode, resume: false });
    });
    document.getElementById("mls-pause").addEventListener("click", () => {
      if (!running) {
        if (pendingCards.length && queueIndex < pendingCards.length) {
          startRun({ loadAll: loadAllMode, resume: true });
        }
        return;
      }
      if (paused) {
        paused = false;
        document.getElementById("mls-pause").textContent = "Pause";
        setPanelStatus("Continuing…");
        persist();
      } else {
        paused = true;
        document.getElementById("mls-pause").textContent = "Resume";
        setPanelStatus("Paused. Click Resume.");
        persist();
      }
    });
    document.getElementById("mls-clear").addEventListener("click", () => {
      if (running) {
        setPanelStatus("First Pause/Stop.");
        return;
      }
      results = [];
      seenKeys = new Set();
      pendingCards = [];
      queueIndex = 0;
      persist();
      renderTable();
      updateProgress(0, 0);
      setPanelStatus("Table cleared.");
    });
    document.getElementById("mls-csv").addEventListener("click", () => exportCsv(getFilteredRows()));
    document.getElementById("mls-copy").addEventListener("click", () => copyTsv(getFilteredRows()));
    document.getElementById("mls-xlsx").addEventListener("click", () => exportExcel(getFilteredRows()));
    document.getElementById("mls-check").addEventListener("click", () => checkSites());
    document.getElementById("mls-sheet").addEventListener("click", () => pushProvider("sheet"));
    document.getElementById("mls-save-session").addEventListener("click", () => saveSession());
    document.getElementById("mls-load-session").addEventListener("click", () => toggleSessions());

    renderTable();
  }

  function exportHeaders() {
    return COLS.map((c) => c.label).concat(["Phone raw", "Assignee", "Notes", "Source"]);
  }
  function exportValues(r) {
    return COLS.map((c) => r[c.key] ?? "")
      .concat([r.phone || "", r.assignee || "", r.notes || "", r.source || "google_maps"]);
  }

  function exportCsv(rows) {
    if (!rows.length) {
      setPanelStatus("Nothing to export.");
      return;
    }
    const lines = [exportHeaders().join(";")];
    rows.forEach((r) => {
      lines.push(
        exportValues(r)
          .map((v) => '"' + String(v ?? "").replace(/"/g, '""') + '"')
          .join(";")
      );
    });
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "maps_leads_" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
    setPanelStatus(`CSV: ${rows.length} rows.`);
  }

  async function copyTsv(rows) {
    if (!rows.length) {
      setPanelStatus("Nothing to copy.");
      return;
    }
    const lines = [exportHeaders().join("\t")];
    rows.forEach((r) => lines.push(exportValues(r).join("\t")));
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setPanelStatus(`Copied ${rows.length} rows (TSV).`);
    } catch (_) {
      setPanelStatus("Failed to copy to clipboard.");
    }
  }

  function exportExcel(rows) {
    if (!rows.length) {
      setPanelStatus("Nothing to export.");
      return;
    }
    let html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8" /></head><body><table>';
    html += "<tr>" + exportHeaders().map((h) => `<th>${esc(h)}</th>`).join("") + "</tr>";
    rows.forEach((r) => {
      html +=
        "<tr>" +
        exportValues(r)
          .map((v) => `<td>${esc(v)}</td>`)
          .join("") +
        "</tr>";
    });
    html += "</table></body></html>";
    const blob = new Blob(["\uFEFF" + html], { type: "application/vnd.ms-excel;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "maps_leads_" + new Date().toISOString().slice(0, 10) + ".xls";
    a.click();
    URL.revokeObjectURL(a.href);
    setPanelStatus(`Excel: ${rows.length} rows.`);
  }

  function checkSites() {
    const urls = results.map((r) => r.website).filter(Boolean);
    if (!urls.length) {
      setPanelStatus("No websites to check.");
      return;
    }
    setPanelStatus(`Checking ${urls.length} websites…`);
    chrome.runtime.sendMessage({ type: "checkWebsites", urls }, (resp) => {
      if (!resp || !resp.ok) {
        setPanelStatus("Check error: " + ((resp && resp.error) || "bg"));
        return;
      }
      const map = {};
      (resp.results || []).forEach((x) => {
        map[x.url] = x.status;
      });
      results = results.map((r) =>
        r.website ? { ...r, websiteCheck: map[r.website] || r.websiteCheck } : r
      );
      persist();
      renderTable();
      setPanelStatus("Website check done.");
    });
  }

  function pushProvider(provider) {
    const rows = getFilteredRows();
    setPanelStatus(`Exporting to ${provider}…`);
    chrome.runtime.sendMessage({ type: "pushIntegration", provider, rows }, (resp) => {
      if (!resp || !resp.ok) {
        setPanelStatus((resp && resp.error) || "Export error. Configure Options.");
        return;
      }
      setPanelStatus(`Exported to ${provider}: ${resp.count}`);
    });
  }

  function saveSession() {
    const name =
      prompt(
        "Session name",
        `${readSearchQuery() || "maps"} ${new Date().toISOString().slice(0, 10)}`
      ) || "";
    if (!name.trim()) return;
    chrome.storage.local.get(["mls_sessions"], (data) => {
      const sessions = data.mls_sessions || [];
      sessions.unshift({
        id: Date.now().toString(36),
        name: name.trim(),
        results,
        createdAt: new Date().toISOString(),
      });
      chrome.storage.local.set({ mls_sessions: sessions.slice(0, 30) }, () => {
        setPanelStatus("Session saved: " + name.trim());
      });
    });
  }

  function toggleSessions() {
    const box = document.getElementById("mls-sessions");
    if (!box.classList.contains("hidden") && box.innerHTML) {
      box.classList.add("hidden");
      return;
    }
    chrome.storage.local.get(["mls_sessions"], (data) => {
      const sessions = data.mls_sessions || [];
      if (!sessions.length) {
        setPanelStatus("No saved sessions.");
        return;
      }
      box.classList.remove("hidden");
      box.innerHTML = sessions
        .map(
          (s) =>
            `<div><button type="button" data-load="${s.id}">Load: ${esc(s.name)} (${(s.results || []).length})</button> <button type="button" data-del="${s.id}" class="ghost">×</button></div>`
        )
        .join("");
      box.querySelectorAll("[data-load]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const s = sessions.find((x) => x.id === btn.getAttribute("data-load"));
          if (!s) return;
          results = s.results || [];
          seenKeys = new Set(results.map((r) => r.placeId).filter(Boolean));
          persist();
          renderTable();
          setPanelStatus("Loaded: " + s.name);
          box.classList.add("hidden");
        });
      });
      box.querySelectorAll("[data-del]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const next = sessions.filter((x) => x.id !== btn.getAttribute("data-del"));
          chrome.storage.local.set({ mls_sessions: next }, () => toggleSessions());
        });
      });
    });
  }

  function listCardAnchors(feed) {
    if (!feed) return [];
    let nodes = [];
    (S.cardLink || ["a.hfpxzc"]).forEach((sel) => {
      nodes = nodes.concat(Array.from(feed.querySelectorAll(sel)));
    });
    const seen = new Set();
    return nodes.filter((a) => {
      const href = a.getAttribute("href");
      if (!href || seen.has(href)) return false;
      seen.add(href);
      return true;
    });
  }

  function scrollFeedTo(feed, el) {
    if (!feed || !el) return;
    try {
      const f = feed.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      feed.scrollTop += e.top - f.top - feed.clientHeight * 0.25;
    } catch (_) {}
  }

  function snapshotZoneCards() {
    const feed = getFeed();
    if (!feed) return [];
    const out = [];
    const seen = new Set();
    listCardAnchors(feed).forEach((a) => {
      if (isSponsoredAnchor(a)) return;
      const href = a.getAttribute("href");
      const key = placeKey(href);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({
        href,
        key,
        label: ((a.getAttribute("aria-label") || "").split(/[·•|]/)[0] || "").trim(),
      });
    });
    return out;
  }

  async function collectCards(loadAll) {
    const feed = getFeed();
    if (!feed) return [];
    if (!loadAll) return snapshotZoneCards().slice(0, MAX_CARDS);
    const map = new Map();
    const absorb = () => snapshotZoneCards().forEach((c) => map.set(c.key, c));
    absorb();
    let last = map.size,
      idle = 0,
      rounds = 0;
    while (idle < 4 && !stopRequested && rounds < 30 && map.size < MAX_CARDS) {
      rounds++;
      feed.scrollBy(0, Math.max(feed.clientHeight * 0.75, 320));
      await sleep(nextDelay());
      absorb();
      if (map.size === last) {
        idle++;
        feed.scrollTop = feed.scrollHeight;
        await sleep(nextDelay());
        absorb();
      } else {
        idle = 0;
        last = map.size;
      }
      setPanelStatus(`Loading… ${map.size}`);
    }
    feed.scrollTop = 0;
    await sleep(300);
    return Array.from(map.values()).slice(0, MAX_CARDS);
  }

  function findCardInFeed(card) {
    const feed = getFeed();
    if (!feed) return null;
    for (const a of listCardAnchors(feed)) {
      if (placeKey(a.getAttribute("href")) === card.key) return a;
    }
    return null;
  }

  async function locateInFeed(card) {
    let link = findCardInFeed(card);
    if (link) return link;
    const feed = getFeed();
    if (!feed) return null;
    feed.scrollTop = 0;
    await sleep(200);
    for (let i = 0; i < 20 && !stopRequested && !paused; i++) {
      link = findCardInFeed(card);
      if (link) return link;
      const prev = feed.scrollTop;
      feed.scrollBy(0, Math.max(Math.floor(feed.clientHeight * 0.6), 240));
      await sleep(200);
      if (feed.scrollTop === prev) break;
    }
    return findCardInFeed(card);
  }

  function clickBackToList() {
    const btn = firstMatch(S.back);
    if (btn) {
      try {
        btn.click();
        return true;
      } catch (_) {}
    }
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })
      );
    } catch (_) {}
    return false;
  }

  function looksLikePhone(s) {
    if (!s) return false;
    const digits = String(s).replace(/\D/g, "");
    return digits.length >= 8;
  }

  function extractPhoneFromEl(el) {
    if (!el) return "";
    const id = el.getAttribute("data-item-id") || "";
    const idMatch = id.match(/phone:tel:(.+)$/i);
    if (idMatch) {
      try {
        const decoded = decodeURIComponent(idMatch[1]).trim();
        if (looksLikePhone(decoded)) return decoded;
      } catch (_) {
        if (looksLikePhone(idMatch[1])) return idMatch[1].trim();
      }
    }
    const href = el.getAttribute("href") || "";
    if (/^tel:/i.test(href)) {
      const n = decodeURIComponent(href.replace(/^tel:/i, "")).trim();
      if (looksLikePhone(n)) return n;
    }
    const aria = el.getAttribute("aria-label") || "";
    const ariaPhone = aria.match(
      /(?:phone|t[eé]l[eé]?phone|appeler|call)[^0-9+]*([+\d][\d\s.()\-]{7,})/i
    );
    if (ariaPhone && looksLikePhone(ariaPhone[1])) {
      return cleanLabeledText(ariaPhone[1]);
    }
    if (looksLikePhone(aria)) return cleanLabeledText(aria);
    const text = (el.textContent || "").trim();
    if (looksLikePhone(text)) return cleanLabeledText(text);
    // sometimes number in child span
    const spans = el.querySelectorAll("div, span");
    for (const sp of spans) {
      const t = (sp.textContent || "").trim();
      if (looksLikePhone(t) && t.length < 30) return cleanLabeledText(t);
    }
    return "";
  }

  function findPhoneAnywhere() {
    // 1) explicit tel: links
    const telA = document.querySelector('a[href^="tel:"]');
    if (telA) {
      const p = extractPhoneFromEl(telA);
      if (p) return p;
    }
    // 2) data-item-id phone:tel
    const byId = document.querySelector(
      '[data-item-id^="phone:tel:"], [data-item-id*="phone:tel"]'
    );
    if (byId) {
      const p = extractPhoneFromEl(byId);
      if (p) return p;
    }
    // 3) selectors from hub
    const phoneBtn = firstMatch(S.phone);
    if (phoneBtn) {
      const p = extractPhoneFromEl(phoneBtn);
      if (p) return p;
    }
    // 4) any element with aria-label containing FR/EN phone
    const labeled = document.querySelectorAll("[aria-label]");
    for (const el of labeled) {
      const aria = el.getAttribute("aria-label") || "";
      if (!/phone|t[eé]l|appeler|call/i.test(aria)) continue;
      const p = extractPhoneFromEl(el);
      if (p) return p;
    }
    return "";
  }

  function extractDetail() {
    const nameEl = firstMatch(S.name);
    const name = nameEl ? nameEl.textContent.trim() : "";
    const categoryEl = firstMatch(S.category);
    const category = categoryEl ? categoryEl.textContent.trim() : "";
    const addressBtn = firstMatch(S.address);
    const address = addressBtn
      ? cleanLabeledText(addressBtn.getAttribute("aria-label") || addressBtn.textContent)
      : "";
    const phone = findPhoneAnywhere();
    const siteEl = firstMatch(S.website);
    let website = siteEl ? siteEl.href || "" : "";
    if (website && (website.includes("google.com/maps") || website.includes("googleusercontent"))) {
      website = "";
    }
    let rating = "";
    let reviews = "";
    const ratingEl = firstMatch(S.rating);
    if (ratingEl) rating = ratingEl.textContent.trim();
    const reviewsEl = firstMatch(S.reviews);
    if (reviewsEl) {
      const label = reviewsEl.getAttribute("aria-label") || reviewsEl.textContent;
      const num = label.match(/([\d\s\u00a0]+)/);
      reviews = num
        ? num[1].replace(/[\s\u00a0]/g, "").trim()
        : label.replace(/[()]/g, "").trim();
    }

    const hoursEl = firstMatch(S.hours);
    const hours = hoursEl
      ? cleanLabeledText(hoursEl.getAttribute("aria-label") || hoursEl.textContent).slice(0, 120)
      : "";
    const openEl = firstMatch(S.openNow);
    let openNow = "";
    if (openEl) {
      const t = openEl.getAttribute("aria-label") || openEl.textContent || "";
      if (/ouvert|open/i.test(t) && !/ferm|closed/i.test(t)) openNow = "Open";
      else if (/ferm|closed/i.test(t)) openNow = "Closed";
      else openNow = t.slice(0, 40);
    }
    const emailEl = firstMatch(S.email);
    const email = emailEl ? (emailEl.getAttribute("href") || "").replace(/^mailto:/i, "") : "";
    const plusEl = firstMatch(S.plusCode);
    const plusCode = plusEl
      ? cleanLabeledText(plusEl.getAttribute("aria-label") || plusEl.textContent)
      : "";
    const priceEl = firstMatch(S.price);
    const priceLevel = priceEl
      ? (priceEl.getAttribute("aria-label") || priceEl.textContent || "").replace(/[^€$£]/g, "")
      : "";

    let businessStatus = "";
    const bodyText = (document.querySelector("h1") && document.body
      ? document.body.innerText.slice(0, 1500)
      : "") || "";
    if (/permanently closed|fermeture définitive/i.test(bodyText)) {
      businessStatus = "Permanently closed";
    } else if (/temporarily closed|fermeture temporaire/i.test(bodyText)) {
      businessStatus = "Temporarily closed";
    }

    const socials = [];
    let bookingUrl = "";
    let whatsapp = "";
    document.querySelectorAll('a[href^="http"]').forEach((a) => {
      const href = a.href || "";
      if (/instagram\.com|facebook\.com|linkedin\.com/i.test(href)) socials.push(href);
      if (/thefork|doctolib|treatwell|resy|opentable|planity/i.test(href)) bookingUrl = href;
      if (/wa\.me|whatsapp/i.test(href)) whatsapp = href;
    });

    let about = "";
    const aboutEl =
      document.querySelector('button[jsaction*="about"]') ||
      document.querySelector('[data-attrid*="description"]') ||
      document.querySelector(".PYvSYb");
    if (aboutEl) about = aboutEl.textContent.trim().slice(0, 240);

    const photoCount =
      (document.querySelector('button[aria-label*="photo"]') ||
        document.querySelector('button[aria-label*="Photo"]') ||
        document.querySelector('button[aria-label*="photos"]') ||
        {})
        .textContent || "";

    const claimed = /claim|propriétaire|owner/i.test(bodyText.slice(0, 800)) ? "maybe" : "";

    return {
      name,
      category,
      address,
      phone,
      website,
      rating,
      reviews,
      hours,
      openNow,
      email,
      plusCode,
      priceLevel,
      businessStatus,
      social: socials.slice(0, 3).join(" | "),
      bookingUrl,
      whatsapp,
      about,
      photoCount: String(photoCount).replace(/[^\d]/g, "").slice(0, 6),
      claimed,
      attributes: "",
    };
  }

  async function waitDetail(expectedLabel, prev, delay) {
    await sleep(Math.min(Math.max(delay, 900), 2200));
    for (let i = 0; i < 12; i++) {
      if (stopRequested) break;
      while (paused && !stopRequested) await sleep(200);
      const data = extractDetail();
      if (!data.name) {
        await sleep(250);
        continue;
      }
      if (data.name !== prev) return data;
      if (expectedLabel && data.name && expectedLabel.includes(data.name.slice(0, 12))) return data;
      if (data.address || data.phone || data.website) return data;
      await sleep(300);
    }
    return extractDetail();
  }

  async function processOneCard(card, delay) {
    if (detectCaptcha()) return { ok: false, reason: "captcha" };
    if (!getFeed()) {
      clickBackToList();
      await sleep(500);
    }
    const link = await locateInFeed(card);
    if (!link) return { ok: false, reason: "not_in_list" };
    if (isSponsoredAnchor(link)) return { ok: false, reason: "sponsored" };
    scrollFeedTo(getFeed(), link);
    await sleep(120);
    try {
      link.click();
    } catch (_) {
      try {
        link.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
        );
      } catch (__) {
        return { ok: false, reason: "click_fail" };
      }
    }
    const data = await waitDetail(card.label, prevName, delay);
    if (!data.name && card.label) data.name = card.label;
    data.mapsUrl = fullMapsUrl(card.href);
    data.placeId = card.key;
    clickBackToList();
    await sleep(400);
    if (!getFeed()) {
      clickBackToList();
      await sleep(400);
    }
    if (!data.name && !data.address && !data.phone) return { ok: false, reason: "empty", data };
    return { ok: true, data };
  }

  async function waitWhilePaused() {
    while (paused && !stopRequested) await sleep(250);
  }

  async function startRun(opts = {}) {
    const resume = !!opts.resume;
    running = true;
    stopRequested = false;
    paused = false;
    const pauseBtn = document.getElementById("mls-pause");
    if (pauseBtn) pauseBtn.textContent = "Pause";
    searchQuery = readSearchQuery();
    timings = [];
    skipped = 0;

    if (!resume) {
      // append: do NOT clear results / seenKeys
      setPanelStatus(
        loadAllMode ? "Loading full list…" : "Zone snapshot (append + dedupe)…"
      );
      try {
        const cards = await collectCards(loadAllMode);
        pendingCards = cards.filter((c) => c.key && !seenKeys.has(c.key));
        queueIndex = 0;
      } catch (e) {
        setPanelStatus("List error: " + (e && e.message));
        running = false;
        persist();
        return;
      }
    } else {
      setPanelStatus("Resuming queue…");
    }

    const total = pendingCards.length;
    if (!total || queueIndex >= total) {
      setPanelStatus(
        total ? "Queue empty (all already in table)." : "0 cards. Do 'Rechercher dans cette zone'."
      );
      running = false;
      persist();
      return;
    }

    updateProgress(queueIndex, total);
    persist();

    for (; queueIndex < pendingCards.length; queueIndex++) {
      if (stopRequested) break;
      await waitWhilePaused();
      if (stopRequested) break;
      if (detectCaptcha()) {
        paused = true;
        if (pauseBtn) pauseBtn.textContent = "Resume";
        setPanelStatus("Captcha / unusual traffic — solve and click Resume.");
        persist();
        await waitWhilePaused();
        if (stopRequested) break;
      }

      const card = pendingCards[queueIndex];
      if (!card.key || seenKeys.has(card.key)) continue;
      seenKeys.add(card.key);
      setPanelStatus(`Card ${queueIndex + 1}/${total}…\n${card.label || card.key}`);
      const t0 = Date.now();
      const delay = nextDelay();

      try {
        const outcome = await withTimeout(
          processOneCard(card, delay),
          CARD_TIMEOUT_MS,
          { ok: false, reason: "timeout" }
        );
        timings.push(Date.now() - t0);
        if (timings.length > 20) timings.shift();

        if (!outcome || !outcome.ok) {
          skipped++;
          if (outcome && outcome.reason === "captcha") {
            paused = true;
            if (pauseBtn) pauseBtn.textContent = "Resume";
            setPanelStatus("Captcha — solve and click Resume.");
            queueIndex = Math.max(0, queueIndex - 1);
            seenKeys.delete(card.key);
            persist();
            await waitWhilePaused();
            continue;
          }
          clickBackToList();
          updateProgress(queueIndex + 1, total);
          persist();
          continue;
        }

        const row = enrichRow(outcome.data, card);
        if (!row.name) row.name = "(no name)";
        const existIdx = results.findIndex(
          (r) => r.placeId && row.placeId && r.placeId === row.placeId
        );
        if (existIdx >= 0) results[existIdx] = { ...results[existIdx], ...row };
        else results.push(row);
        prevName = row.name;
        persist();
        renderTable();
        updateProgress(queueIndex + 1, total);
        setPanelStatus(
          `In table: ${results.length} · queue ${queueIndex + 1}/${total} (skipped ${skipped})\n${row.name}`
        );
        safeSend({ type: "progress", count: results.length, total, last: row.name });
      } catch (e) {
        skipped++;
        clickBackToList();
        setPanelStatus(`Error: ${(e && e.message) || e}`);
        await sleep(400);
      }
      persist();
    }

    running = false;
    paused = false;
    if (pauseBtn) pauseBtn.textContent = "Pause";
    persist();
    clickBackToList();
    const nosite = results.filter((r) => !r.website).length;
    setPanelStatus(
      `Done. ${results.length} rows (⭐ no website: ${nosite}, skipped ${skipped}).`
    );
    safeSend({ type: "done", results });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "start") {
      ensurePanel();
      zoneMode = msg.loadAll ? "all" : "zone";
      loadAllMode = !!msg.loadAll;
      if (msg.delay) baseDelay = msg.delay;
      if (!running) startRun({ loadAll: loadAllMode, resume: false });
      sendResponse({ ok: true });
    } else if (msg.type === "stop") {
      stopRequested = true;
      paused = false;
      sendResponse({ ok: true });
    } else if (msg.type === "pause") {
      paused = true;
      sendResponse({ ok: true });
    } else if (msg.type === "resume") {
      if (!running && pendingCards.length) startRun({ resume: true });
      else paused = false;
      sendResponse({ ok: true });
    } else if (msg.type === "getResults") {
      sendResponse({ results, running, paused });
    } else if (msg.type === "showPanel") {
      ensurePanel();
      sendResponse({ ok: true });
    } else if (msg.type === "ping") {
      ensurePanel();
      sendResponse({ ok: true, running, paused, count: results.length });
    }
    return true;
  });

  function boot() {
    ensurePanel();
    chrome.storage.local.get(
      ["mls_results", "mls_pending", "mls_queueIndex", "mls_seen", "mls_ui"],
      (data) => {
        if (Array.isArray(data.mls_results)) results = data.mls_results;
        if (Array.isArray(data.mls_pending)) pendingCards = data.mls_pending;
        if (typeof data.mls_queueIndex === "number") queueIndex = data.mls_queueIndex;
        if (Array.isArray(data.mls_seen)) seenKeys = new Set(data.mls_seen);
        else seenKeys = new Set(results.map((r) => r.placeId).filter(Boolean));
        const ui = data.mls_ui || {};
        if (ui.filterChip) filterChip = ui.filterChip;
        if (ui.filterSearch) filterSearch = ui.filterSearch;
        if (typeof ui.minRating === "number") minRating = ui.minRating;
        if (typeof ui.randomDelayOn === "boolean") randomDelayOn = ui.randomDelayOn;
        if (ui.baseDelay) baseDelay = ui.baseDelay;
        if (ui.zoneMode) zoneMode = ui.zoneMode;
        if (ui.colWidths) colWidths = ui.colWidths;
        if (ui.sortKey) sortKey = ui.sortKey;
        if (ui.sortDir) sortDir = ui.sortDir;
        const delayEl = document.getElementById("mls-delay");
        if (delayEl) delayEl.value = String(baseDelay);
        const rnd = document.getElementById("mls-random");
        if (rnd) rnd.checked = randomDelayOn;
        const search = document.getElementById("mls-search");
        if (search) search.value = filterSearch;
        const mr = document.getElementById("mls-minrating");
        if (mr) mr.value = String(minRating);
        document.querySelectorAll("#mls-chips button").forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-chip") === filterChip);
        });
        document.querySelectorAll("#mls-zone-seg button").forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-zone") === zoneMode);
        });
        loadAllMode = zoneMode === "all";
        renderTable();
        if (results.length) {
          setPanelStatus(
            `Restored ${results.length}. Can Start (will append) or Resume queue.`
          );
        }
      }
    );
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
