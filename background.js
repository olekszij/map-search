// background.js — website check + CRM integrations
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "checkWebsites") {
    checkWebsites(msg.urls || [])
      .then((results) => sendResponse({ ok: true, results }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "pushIntegration") {
    pushIntegration(msg.provider, msg.rows || [])
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "getIntegrations") {
    chrome.storage.local.get(["mls_integrations"], (data) => {
      sendResponse({ ok: true, config: data.mls_integrations || {} });
    });
    return true;
  }
});

async function checkOne(url) {
  const u = String(url || "").trim();
  if (!u) return { url: u, status: "empty" };
  const low = u.toLowerCase();
  if (/facebook\.com|fb\.com/.test(low)) return { url: u, status: "facebook-only" };
  if (/instagram\.com/.test(low)) return { url: u, status: "instagram-only" };
  if (/linkedin\.com/.test(low)) return { url: u, status: "linkedin-only" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(u, {
      method: "HEAD",
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.ok || (res.status >= 300 && res.status < 400)) {
      return { url: u, status: "alive", http: res.status };
    }
    // some sites block HEAD
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), 8000);
    const res2 = await fetch(u, {
      method: "GET",
      redirect: "follow",
      signal: ctrl2.signal,
    });
    clearTimeout(t2);
    return {
      url: u,
      status: res2.ok ? "alive" : "dead",
      http: res2.status,
    };
  } catch (_) {
    return { url: u, status: "dead" };
  }
}

async function checkWebsites(urls) {
  const out = [];
  for (const url of urls) {
    out.push(await checkOne(url));
  }
  return out;
}

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["mls_integrations"], (data) => {
      resolve(data.mls_integrations || {});
    });
  });
}

async function pushIntegration(provider, rows) {
  const cfg = await getConfig();
  if (!rows.length) return { ok: false, error: "No rows to export" };

  if (provider === "sheet") {
    const webhook = (cfg.sheetWebhook || "").trim();
    if (!webhook) {
      return {
        ok: false,
        error: "Specify Google Apps Script webhook in Options",
      };
    }
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, spreadsheetId: cfg.spreadsheetId || "" }),
    });
    if (!res.ok) return { ok: false, error: "Sheet HTTP " + res.status };
    return { ok: true, count: rows.length };
  }

  return { ok: false, error: "Unknown provider" };
}
