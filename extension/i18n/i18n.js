// Runtime i18n — JSON-catalog based, switchable at runtime. ewtos.com
// Uses chrome.storage.local for language persistence (NOT chrome.i18n).

let _catalog = {};
let _lang = "en";

export async function initI18n() {
  const { uiLanguage } = await chrome.storage.local.get("uiLanguage");
  _lang = uiLanguage || "en";

  if (_lang !== "en") {
    try {
      const enUrl = chrome.runtime.getURL("i18n/en.json");
      const enRes = await fetch(enUrl);
      _catalog = await enRes.json();
    } catch {
      _catalog = {};
    }
  }

  try {
    const url = chrome.runtime.getURL(`i18n/${_lang}.json`);
    const res = await fetch(url);
    const active = await res.json();
    _catalog = Object.assign({}, _catalog, active);
  } catch {
    // active lang failed — catalog stays as EN (or empty if EN also failed)
  }
}

export function getLang() {
  return _lang;
}

export async function setLang(lang) {
  await chrome.storage.local.set({ uiLanguage: lang });
  try {
    const { serverUrl } = await chrome.storage.local.get("serverUrl");
    const httpBase = (serverUrl || "ws://localhost:9988/ws")
      .replace(/^ws:/, "http:")
      .replace(/^wss:/, "https:")
      .replace(/\/ws$/, "");
    await fetch(`${httpBase}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ui_language: lang }),
    });
  } catch {
    // server not reachable — language saved locally anyway
  }
  location.reload();
}

export function t(key, vars = {}) {
  let str = _catalog[key];
  if (str === undefined) return key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replaceAll(`{${k}}`, String(v));
  }
  return str;
}

export function localizeDom(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-html]")) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  }
}
