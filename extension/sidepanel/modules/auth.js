// Auth-Gate für das Sidepanel: zentraler fetch-Wrapper (injiziert das Login-Token
// für alle Server-Requests) + Login-Overlay. Open-Mode (Server ohne User) läuft
// ohne Login wie bisher. ewtos.com
import { getHttpBase } from "./api.js";

const AUTH_KEY = "authToken";
const INSTANCE_KEY = "instanceToken";

export async function getAuthToken() {
  return (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY] || "";
}

export async function setAuthToken(token) {
  if (token) await chrome.storage.local.set({ [AUTH_KEY]: token });
  else await chrome.storage.local.remove(AUTH_KEY);
}

export async function getInstanceToken() {
  let v = (await chrome.storage.local.get(INSTANCE_KEY))[INSTANCE_KEY];
  if (!v) {
    v = crypto.randomUUID();
    await chrome.storage.local.set({ [INSTANCE_KEY]: v });
  }
  return v;
}

let _onUnauth = null;
let _installed = false;

// Wrappt window.fetch EINMAL: hängt an alle Requests auf den Server-Base den
// Authorization-Header (wenn ein Token da ist) und behandelt 401 zentral.
export function installFetchAuth() {
  if (_installed) return;
  _installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    let base = "";
    try { base = await getHttpBase(); } catch {}
    const targetsServer = !!base && !!url && url.startsWith(base);
    if (targetsServer) {
      const token = await getAuthToken();
      if (token) {
        init = init ? { ...init } : {};
        const h = new Headers(init.headers || (typeof input !== "string" && input.headers) || {});
        if (!h.has("Authorization")) h.set("Authorization", `Bearer ${token}`);
        init.headers = h;
      }
    }
    const res = await orig(input, init);
    if (targetsServer && res.status === 401) {
      await setAuthToken("");
      if (_onUnauth) _onUnauth();
    }
    return res;
  };
}

// Prüft beim Start, ob Login nötig ist. Zeigt ggf. das Login-Overlay.
export async function ensureAuth() {
  installFetchAuth();
  const base = await getHttpBase();
  let status;
  try {
    status = await (await window.fetch(`${base}/auth/status`)).json();
  } catch {
    return; // Server offline → normales Offline-Handling übernimmt
  }
  if (!status.auth_required) return; // Open-Mode
  const token = await getAuthToken();
  if (token) {
    try {
      const me = await window.fetch(`${base}/auth/me`);
      if (me.ok) return; // Token gültig
    } catch {}
  }
  _onUnauth = () => showLogin(base);
  await showLogin(base);
}

function showLogin(base) {
  return new Promise(() => {
    if (document.getElementById("ewtos-login-overlay")) return;
    const ov = document.createElement("div");
    ov.id = "ewtos-login-overlay";
    ov.innerHTML = `
      <div class="ewtos-login-card">
        <h2>EwtosBrain — Anmeldung</h2>
        <p class="ewtos-login-sub">Dieser Server erfordert ein Login.</p>
        <input id="ewtos-login-user" type="text" placeholder="Benutzername" autocomplete="username" />
        <input id="ewtos-login-pw" type="password" placeholder="Passwort" autocomplete="current-password" />
        <button id="ewtos-login-btn">Anmelden</button>
        <div id="ewtos-login-err" class="ewtos-login-err"></div>
      </div>`;
    document.body.appendChild(ov);
    const userEl = ov.querySelector("#ewtos-login-user");
    const pwEl = ov.querySelector("#ewtos-login-pw");
    const btn = ov.querySelector("#ewtos-login-btn");
    const err = ov.querySelector("#ewtos-login-err");
    userEl.focus();

    async function submit() {
      err.textContent = "";
      btn.disabled = true;
      try {
        const instance_token = await getInstanceToken();
        const res = await window.fetch(`${base}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: userEl.value.trim(),
            password: pwEl.value,
            instance_token,
            device_name: (navigator.userAgent || "").slice(0, 80),
          }),
        });
        if (res.status === 402) { err.textContent = "Seat-Limit erreicht — Lizenz erforderlich."; btn.disabled = false; return; }
        if (!res.ok) { err.textContent = "Anmeldung fehlgeschlagen."; btn.disabled = false; return; }
        const data = await res.json();
        await setAuthToken(data.token);
        location.reload(); // Token gesetzt → Sidepanel neu initialisieren
      } catch {
        err.textContent = "Server nicht erreichbar.";
        btn.disabled = false;
      }
    }
    btn.addEventListener("click", submit);
    pwEl.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  });
}
