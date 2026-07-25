// background.js — проверка сайтов + интеграции CRM
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
    // некоторые сайты режут HEAD
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
  if (!rows.length) return { ok: false, error: "Нет строк для выгрузки" };

  if (provider === "sheet") {
    const webhook = (cfg.sheetWebhook || "").trim();
    if (!webhook) {
      return {
        ok: false,
        error: "Укажи Google Apps Script webhook в Options",
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

  if (provider === "notion") {
    const token = (cfg.notionToken || "").trim();
    const db = (cfg.notionDatabaseId || "").trim();
    if (!token || !db) {
      return { ok: false, error: "Notion token + database id в Options" };
    }
    let n = 0;
    for (const r of rows.slice(0, 50)) {
      const props = {
        Name: { title: [{ text: { content: String(r.name || "").slice(0, 200) } }] },
      };
      if (r.phone) props.Phone = { phone_number: String(r.phone).slice(0, 60) };
      if (r.website) props.Website = { url: String(r.website).slice(0, 500) };
      if (r.address) {
        props.Address = {
          rich_text: [{ text: { content: String(r.address).slice(0, 300) } }],
        };
      }
      const res = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ parent: { database_id: db }, properties: props }),
      });
      if (res.ok) n++;
    }
    return { ok: true, count: n };
  }

  if (provider === "airtable") {
    const token = (cfg.airtableToken || "").trim();
    const base = (cfg.airtableBase || "").trim();
    const table = (cfg.airtableTable || "").trim();
    if (!token || !base || !table) {
      return { ok: false, error: "Airtable token + base + table в Options" };
    }
    const records = rows.slice(0, 10).map((r) => ({
      fields: {
        Name: r.name || "",
        Phone: r.phone || "",
        Website: r.website || "",
        Address: r.address || "",
        Category: r.category || "",
        Rating: r.rating || "",
        "Maps URL": r.mapsUrl || "",
        Score: r.score || "",
      },
    }));
    const res = await fetch(
      `https://api.airtable.com/v0/${encodeURIComponent(base)}/${encodeURIComponent(table)}`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records }),
      }
    );
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, error: "Airtable " + res.status + ": " + t.slice(0, 120) };
    }
    return { ok: true, count: records.length };
  }

  return { ok: false, error: "Неизвестный provider" };
}
