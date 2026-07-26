const keys = [
  "spreadsheetId",
  "sheetWebhook",
];

chrome.storage.local.get(["mls_integrations"], (data) => {
  const c = data.mls_integrations || {};
  keys.forEach((k) => {
    const el = document.getElementById(k);
    if (el && c[k]) el.value = c[k];
  });
});

document.getElementById("save").addEventListener("click", () => {
  const cfg = {};
  keys.forEach((k) => {
    cfg[k] = document.getElementById(k).value.trim();
  });
  chrome.storage.local.set({ mls_integrations: cfg }, () => {
    document.getElementById("ok").textContent = "Saved.";
  });
});
