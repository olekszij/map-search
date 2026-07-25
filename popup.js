let loadAll = false;

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp || null);
    });
  });
}

document.querySelectorAll("#zoneSeg button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#zoneSeg button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    loadAll = btn.getAttribute("data-zone") === "all";
  });
});

document.getElementById("show").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.includes("google.com/maps")) {
    setStatus("Открой вкладку google.com/maps.");
    return;
  }
  const resp = await sendToTab(tab.id, { type: "showPanel" });
  setStatus(resp ? "Панель на карте." : "F5 на Maps и снова.");
});

document.getElementById("start").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.includes("google.com/maps")) {
    setStatus("Открой google.com/maps.");
    return;
  }
  const resp = await sendToTab(tab.id, { type: "start", delay: 1400, loadAll });
  setStatus(
    resp
      ? loadAll
        ? "Старт: весь список. Смотри панель на Maps."
        : "Старт: зона. Смотри панель на Maps."
      : "F5 на Maps, потом снова Старт."
  );
});

document.getElementById("stop").addEventListener("click", async () => {
  const tab = await getActiveTab();
  await sendToTab(tab.id, { type: "stop" });
  setStatus("Стоп отправлен.");
});

(async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  const resp = await sendToTab(tab.id, { type: "ping" });
  if (resp && resp.count) {
    setStatus(
      `${resp.running ? (resp.paused ? "Пауза" : "Идёт сбор") : "Готово"} · ${resp.count} строк`
    );
  }
})();
