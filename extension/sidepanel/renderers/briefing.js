// Briefing-Panel + Brain-Modal + Document-Ingest Renderer. ewtos.com
import { el, makeYouTubeThumb } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase, getActiveVaultId } from '../modules/api.js';
import { renderMarkdown } from '../markdown.js';
import { t } from '../../i18n/i18n.js';

const BRIEFING_SOURCE_TOOLTIPS = {
  youtube_trending: "briefing.tooltip_youtube_trending",
  competitor_videos: "briefing.tooltip_competitor_videos",
  playlist_trending: "briefing.tooltip_playlist_trending",
  recommendations: "briefing.tooltip_recommendations",
  vertrags_fristen: "briefing.tooltip_vertrags_fristen",
  kampagnen_kickoffs: "briefing.tooltip_kampagnen_kickoffs",
};

const BRIEFING_SOURCE_TITLES = {
  youtube_trending: "options.briefing_source_youtube_trending",
  competitor_videos: "options.briefing_source_competitor_videos",
  playlist_trending: "options.briefing_source_playlist_trending",
  recommendations: "options.briefing_source_recommendations",
  vertrags_fristen: "options.briefing_source_vertrags_fristen",
  kampagnen_kickoffs: "options.briefing_source_kampagnen_kickoffs",
  recent_videos: "options.briefing_source_recent_videos",
  recent_pages: "options.briefing_source_recent_pages",
  active_projects: "options.briefing_source_active_projects",
  scratchpad: "options.briefing_source_scratchpad",
  last_journal: "options.briefing_source_last_journal",
  workshops: "options.briefing_source_workshops",
  anniversaries: "options.briefing_source_anniversaries",
};

const BRIEFING_SOURCE_ICONS = {
  wetter: "🌤",
  todos: "✅",
  fristen: "⏰",
  lernstreak: "📚",
  vertrags_fristen: "📄",
  kampagnen_kickoffs: "🚀",
  youtube_trending: "🔥",
  competitor_videos: "👥",
  playlist_trending: "🎬",
  recommendations: "💡",
  recent_videos: "🎬",
  recent_pages: "📄",
  active_projects: "📁",
  scratchpad: "📝",
  last_journal: "📓",
  workshops: "📅",
  anniversaries: "🎉",
};

function briefingFormatNumber(n) {
  if (typeof n !== "number" || !isFinite(n)) return String(n ?? "");
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function briefingRelativeTime(isoDate) {
  if (!isoDate) return "";
  const then = new Date(isoDate);
  if (isNaN(then.getTime())) return "";
  const diffMs = Date.now() - then.getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days < 0) return t("briefing.future");
  if (days === 0) {
    const hours = Math.floor(diffMs / 3600000);
    if (hours <= 0) return t("briefing.just_now");
    return t("briefing.hours_ago", { hours });
  }
  if (days === 1) return t("briefing.days_ago", { days: 1 });
  if (days < 30) return t("briefing.days_ago", { days });
  const months = Math.floor(days / 30);
  return t("briefing.months_ago", { months });
}

export async function showBriefingPanel() {
  const existing = document.querySelector(".briefing-panel");
  if (existing) { existing.remove(); return; }

  const panel = el("div", { className: "briefing-panel" });
  const header = el("div", { className: "briefing-header" });
  header.append(el("strong", { textContent: t("briefing.morning") }));
  const now = new Date();
  const dateStr = now.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const timeStr = now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  header.append(el("div", { className: "briefing-datetime", textContent: `${dateStr} · ${timeStr}` }));

  const profileSelect = el("select", { className: "briefing-profile-select", title: t("briefing.profile_title") });
  header.append(profileSelect);

  const lookbackBtn = el("button", {
    type: "button",
    className: "briefing-lookback-btn",
    id: "btn-briefing-lookback",
    textContent: t("briefing.lookback_btn"),
  });
  header.append(lookbackBtn);

  const saveBtn = el("button", {
    type: "button",
    className: "briefing-save-btn",
    id: "btn-briefing-save",
    textContent: t("briefing.save_journal"),
    title: t("briefing.save_journal_hint"),
  });
  header.append(saveBtn);

  const closeBtn = el("button", { type: "button", textContent: "×", className: "briefing-close" });
  closeBtn.addEventListener("click", () => panel.remove());
  header.append(closeBtn);
  panel.append(header);

  // In-App-Hilfe: einklappbar, erklärt was das Briefing tut + dass nur "Speichern" schreibt.
  const helpToggle = el("button", {
    type: "button",
    className: "briefing-help-toggle",
    textContent: t("briefing.help_toggle"),
  });
  const helpBody = el("div", { className: "briefing-help-body", style: "display:none" });
  helpBody.innerHTML = renderMarkdown(t("briefing.help_body"));
  helpToggle.addEventListener("click", () => {
    helpBody.style.display = helpBody.style.display === "none" ? "" : "none";
  });
  panel.append(helpToggle, helpBody);

  const body = el("div", { className: "briefing-body" });
  body.textContent = t("briefing.loading");
  panel.append(body);
  document.body.append(panel);

  let currentProfile = null;
  let currentVaultId = null;
  let allProfiles = [];
  const { briefingLastProfile } = await chrome.storage.local.get("briefingLastProfile");
  let selectedProfileId = briefingLastProfile || "default";

  async function loadProfiles() {
    try {
      const httpBase = await getHttpBase();
      const pres = await fetch(`${httpBase}/tools/briefing/profiles`);
      const pjson = await pres.json().catch(() => ({}));
      allProfiles = Array.isArray(pjson.data) ? pjson.data : (pjson.data?.profiles || []);
    } catch { allProfiles = []; }
    if (!allProfiles.some(p => p.id === selectedProfileId)) {
      selectedProfileId = allProfiles[0]?.id || "default";
    }
    profileSelect.replaceChildren();
    for (const p of allProfiles) {
      profileSelect.append(el("option", { value: p.id, textContent: p.name || p.id }));
    }
    profileSelect.value = selectedProfileId;
    profileSelect.style.display = allProfiles.length > 1 ? "" : "none";
  }

  async function loadCurrentBriefing() {
    body.replaceChildren();
    body.textContent = t("briefing.loading");
    body.className = "briefing-body";
    try {
      const httpBase = await getHttpBase();
      currentVaultId = await getActiveVaultId(httpBase).catch(() => null);
      const vaultParam = currentVaultId ? `&vault_id=${encodeURIComponent(currentVaultId)}` : "";
      const res = await fetch(`${httpBase}/tools/briefing?profile=${encodeURIComponent(selectedProfileId)}${vaultParam}`);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      const briefingData = data.data || data;
      currentProfile = allProfiles.find(p => p.id === selectedProfileId) || null;
      body.replaceChildren();
      renderBriefingSections(body, briefingData, currentProfile);
    } catch (err) {
      body.textContent = t("common.error_msg", { message: err.message || err });
      body.className = "briefing-body error";
    }
  }

  profileSelect.addEventListener("change", () => {
    selectedProfileId = profileSelect.value;
    chrome.storage.local.set({ briefingLastProfile: selectedProfileId });
    loadCurrentBriefing();
  });

  lookbackBtn.addEventListener("click", () => openBriefingLookback(body, loadCurrentBriefing, currentVaultId));

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    const orig = saveBtn.textContent;
    saveBtn.textContent = t("briefing.saving");
    try {
      const httpBase = await getHttpBase();
      const vaultParam = currentVaultId ? `&vault_id=${encodeURIComponent(currentVaultId)}` : "";
      const res = await fetch(`${httpBase}/tools/briefing?profile=${encodeURIComponent(selectedProfileId)}${vaultParam}&archive=true`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
      saveBtn.textContent = t("briefing.saved");
    } catch (err) {
      saveBtn.textContent = t("common.error_msg", { message: err.message || err });
    } finally {
      setTimeout(() => { saveBtn.textContent = orig; saveBtn.disabled = false; }, 2000);
    }
  });

  await loadProfiles();
  await loadCurrentBriefing();
}

export async function showQuickSavePage() {
  const panel = el("div", { className: "tool-panel" });
  const header = el("div", { className: "tool-header" });
  const title = el("h2", { textContent: t("briefing.quicksave_title") });
  const closeBtn = el("button", { type: "button", className: "close-btn", textContent: "✕" });
  closeBtn.addEventListener("click", () => panel.remove());
  header.append(title, closeBtn);

  const body = el("div", { className: "tool-body" });
  const status = el("div", { className: "tool-status", textContent: t("briefing.scraping_page") });

  const titleInput = el("input", { type: "text", placeholder: t("briefing.title_placeholder") });
  titleInput.style.cssText = "width:100%;margin-bottom:8px;";
  titleInput.style.display = "none";

  const subfolderSelect = el("select");
  subfolderSelect.style.cssText = "width:100%;margin-bottom:12px;";
  subfolderSelect.style.display = "none";
  ["artikel", "eigene-notizen", "chat-archive"].forEach(s => subfolderSelect.append(new Option(s, s)));

  const saveBtn = el("button", { textContent: t("common.save"), disabled: true });
  saveBtn.style.width = "100%";

  body.append(status, titleInput, subfolderSelect, saveBtn);
  panel.append(header, body);
  document.body.append(panel);

  let markdown = "";
  let pageUrl = "";

  try {
    const httpBase = await getHttpBase();
    const res = await fetch(`${httpBase}/tools/page_scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "content" }),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
    markdown = data.markdown || "";
    pageUrl = data.url || "";
    titleInput.value = data.title || "";
    titleInput.style.display = "";
    subfolderSelect.style.display = "";
    status.textContent = t("briefing.words_captured", { count: data.wordCount || 0 });
    status.className = "tool-status success";
    saveBtn.disabled = false;
  } catch (err) {
    status.textContent = err.message || String(err);
    status.className = "tool-status error";
    return;
  }

  saveBtn.addEventListener("click", async () => {
    const titleVal = titleInput.value.trim();
    if (!titleVal) { status.textContent = t("notes.title_required"); status.className = "tool-status error"; return; }
    saveBtn.disabled = true;
    status.textContent = t("common.saving");
    status.className = "tool-status";
    try {
      const httpBase = await getHttpBase();
      const vaultId = await getActiveVaultId(httpBase);
      if (!vaultId) throw new Error(t("briefing.no_vault_configured"));
      const res = await fetch(`${httpBase}/tools/raw/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vault_id: vaultId,
          title: titleVal,
          content: markdown,
          target_subfolder: subfolderSelect.value,
          url: pageUrl || null,
        }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) {
        if (res.status === 403) throw new Error(t("briefing.no_write_raw_perm"));
        throw new Error(data?.detail || text || `HTTP ${res.status}`);
      }
      status.textContent = t("briefing.saved_to", { path: data.data?.raw_path || "OK" });
      status.className = "tool-status success";
      setTimeout(() => panel.remove(), 1500);
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
      saveBtn.disabled = false;
    }
  });
}

function openBriefingLookback(body, restoreFn, vaultId) {
  const existing = body.querySelector(".briefing-lookback-modal");
  if (existing) { existing.remove(); return; }

  const modal = el("div", {
    className: "briefing-lookback-modal",
    style: "display:flex; gap:6px; align-items:center; padding:8px; background:var(--bg-subtle); border-radius:4px; margin-bottom:8px;",
  });
  modal.append(el("label", { textContent: t("briefing.lookback_days_label"), style: "font-size:11px;" }));
  const input = el("input", { type: "number", value: "14", min: "1", max: "9999" });
  input.style.cssText = "width:60px; font-size:12px; padding:2px 4px;";
  const goBtn = el("button", { type: "button", textContent: t("briefing.show"), className: "briefing-lookback-btn" });
  const cancelBtn = el("button", { type: "button", textContent: t("common.cancel"), className: "briefing-lookback-btn" });
  modal.append(input, goBtn, cancelBtn);

  body.prepend(modal);

  cancelBtn.addEventListener("click", () => modal.remove());
  goBtn.addEventListener("click", async () => {
    const days = parseInt(input.value, 10);
    if (!days || days < 1) return;
    goBtn.disabled = true;
    goBtn.textContent = t("briefing.loading");
    try {
      const httpBase = await getHttpBase();
      const vaultParam = vaultId ? `&vault_id=${encodeURIComponent(vaultId)}` : "";
      const res = await fetch(`${httpBase}/tools/briefing/lookback?days=${days}${vaultParam}`);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      const payload = data.data || data;
      if (payload.ok === false) {
        modal.remove();
        const notice = el("div", { className: "briefing-empty", textContent: payload.error || t("briefing.no_journal_found") });
        notice.style.cssText = "padding:12px; text-align:center;";
        body.replaceChildren(notice);
        const backBtn = el("button", { type: "button", className: "briefing-lookback-btn", textContent: t("briefing.back_to_current") });
        backBtn.addEventListener("click", () => restoreFn());
        body.append(backBtn);
        return;
      }
      // Render lookback
      body.replaceChildren();
      const header = el("div", { className: "briefing-section-title", textContent: t("briefing.briefing_from", { date: payload.date }) });
      header.style.cssText = "margin-bottom:8px;";
      body.append(header);
      const md = el("div", { className: "briefing-lookback-md" });
      md.innerHTML = renderMarkdown(payload.markdown || "");
      body.append(md);
      const backBtn = el("button", { type: "button", className: "briefing-lookback-btn", textContent: t("briefing.back_to_current") });
      backBtn.style.marginTop = "12px";
      backBtn.addEventListener("click", () => restoreFn());
      body.append(backBtn);
    } catch (err) {
      goBtn.disabled = false;
      goBtn.textContent = t("briefing.show");
      const err2 = el("div", { className: "briefing-error", textContent: t("common.error_msg", { message: err.message || err }) });
      modal.append(err2);
    }
  });
}

function renderBriefingSections(target, briefingData, profile) {
  let sections = briefingData.sections || [];

  // Re-order nach Profil-Reihenfolge wenn vorhanden
  if (profile && Array.isArray(profile.sources) && profile.sources.length) {
    const order = profile.sources;
    sections = [...sections].sort((a, b) => {
      const ia = order.indexOf(a.type);
      const ib = order.indexOf(b.type);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }

  let quotaProblem = false;

  for (const sec of sections) {
    const card = el("div", { className: `briefing-section briefing-section--${sec.type}` });
    const items = sec.items || [];

    // Section-Header: Icon + Titel + Count
    const titleEl = el("h4", { className: "briefing-section-title" });
    const icon = BRIEFING_SOURCE_ICONS[sec.type];
    const titleKey = BRIEFING_SOURCE_TITLES[sec.type];
    const titleText = sec.title || (titleKey ? t(titleKey) : sec.type);
    titleEl.textContent = (icon ? icon + " " : "") + titleText + (items.length ? ` (${items.length})` : "");
    const tooltipKey = BRIEFING_SOURCE_TOOLTIPS[sec.type];
    if (tooltipKey) titleEl.title = t(tooltipKey);
    card.append(titleEl);

    // Per-Section-Error: Hinweis statt Items
    if (sec.error) {
      card.append(el("div", { className: "briefing-error", textContent: `⚠ ${sec.error}` }));
      const errStr = String(sec.error);
      if (/Quota|YOUTUBE_API_KEY|API[_-]?KEY/i.test(errStr) && (sec.type === "youtube_trending" || sec.type === "competitor_videos")) {
        quotaProblem = true;
      }
      target.append(card);
      continue;
    }

    if (sec.type === "wetter") {
      for (const w of items) {
        const row = el("div", { className: "briefing-wetter-row" });
        const city = el("span", { className: "briefing-wetter-city", textContent: w.stadt });
        const temp = el("span", { className: "briefing-wetter-temp", textContent: `${w.temp_c}°` });
        const desc = el("span", { className: "briefing-wetter-desc", textContent: w.beschreibung });
        const extra = el("span", { className: "briefing-wetter-extra", textContent: `${w.luftfeuchtigkeit}% · ${w.windgeschwindigkeit} km/h` });
        row.append(city, temp, desc, extra);
        card.append(row);
      }
    } else if (sec.type === "todos") {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      for (const todo of items) {
        if (todo.done) continue;
        const row = el("div", { className: "briefing-todo-row" });
        const text = el("span", { textContent: todo.text });
        row.append(text);
        if (todo.due && (todo.due === today || todo.due === tomorrow)) {
          row.append(el("span", { className: "briefing-due-badge", textContent: todo.due === today ? t("briefing.today") : t("briefing.tomorrow") }));
        }
        card.append(row);
      }
      if (!card.querySelector(".briefing-todo-row")) {
        card.append(el("div", { className: "briefing-empty", textContent: t("briefing.no_todos") }));
      }
    } else if (sec.type === "fristen" || sec.type === "vertrags_fristen" || sec.type === "kampagnen_kickoffs" || sec.type === "workshops" || sec.type === "anniversaries") {
      renderBriefingFristenLike(card, items, sec.type);
    } else if (sec.type === "lernstreak") {
      const msg = sec.days_ago === 0
        ? t("briefing.watched")
        : sec.last_video_title
          ? t("briefing.last_video", { title: sec.last_video_title, days: sec.days_ago, plural: sec.days_ago === 1 ? "" : "s" })
          : t("briefing.today_no_video");
      card.append(el("div", { textContent: msg }));
    } else if (sec.type === "youtube_trending" || sec.type === "competitor_videos" || sec.type === "playlist_trending") {
      renderBriefingVideoCards(card, items, sec.type);
    } else if (sec.type === "recent_videos") {
      renderBriefingPageList(card, items, { emptyText: t("briefing.no_videos"), asLink: true });
    } else if (sec.type === "recent_pages" || sec.type === "active_projects") {
      renderBriefingPageList(card, items, { emptyText: sec.type === "active_projects" ? t("briefing.no_active_projects") : t("briefing.no_changes") });
    } else if (sec.type === "scratchpad") {
      if (!sec.markdown || !sec.markdown.trim()) {
        card.append(el("div", { className: "briefing-empty", textContent: t("briefing.scratchpad_empty") }));
      } else {
        const md = el("div", { className: "briefing-lookback-md" });
        md.innerHTML = renderMarkdown(sec.markdown);
        card.append(md);
      }
    } else if (sec.type === "last_journal") {
      if (!items.length) {
        card.append(el("div", { className: "briefing-empty", textContent: t("briefing.no_journal_entry") }));
      } else {
        const it = items[0];
        card.append(el("div", { className: "briefing-journal-date", textContent: it.date }));
        const md = el("div", { className: "briefing-lookback-md" });
        md.innerHTML = renderMarkdown(it.preview || "");
        card.append(md);
      }
    } else if (sec.type === "recommendations") {
      renderBriefingRecommendations(card, items);
    } else {
      // Unbekannter Section-Typ: roher Fallback
      if (items.length) {
        for (const item of items) {
          card.append(el("div", { textContent: typeof item === "string" ? item : (item.text || item.title || JSON.stringify(item)) }));
        }
      } else {
        card.append(el("div", { className: "briefing-empty", textContent: t("briefing.no_data") }));
      }
    }

    target.append(card);
  }

  if (quotaProblem) {
    const notice = el("div", { className: "briefing-quota-notice" });
    const link = el("a", { textContent: t("briefing.set_youtube_key"), href: "#" });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    notice.append(link);
    target.append(notice);
  }

  if (!sections.length) {
    target.append(el("div", { className: "briefing-empty", textContent: t("briefing.no_data") }));
  }
}

function renderBriefingFristenLike(card, items, type) {
  // type: fristen | vertrags_fristen | kampagnen_kickoffs
  const emptyText = {
    fristen: t("briefing.no_deadlines"),
    vertrags_fristen: t("briefing.no_expiring_contracts"),
    kampagnen_kickoffs: t("briefing.no_upcoming_kickoffs"),
    workshops: t("briefing.no_upcoming_workshops"),
    anniversaries: t("briefing.no_anniversaries"),
  }[type] || t("briefing.no_entries");

  for (const f of items) {
    // Shape-Toleranz: title/titel, days_left/tage_offen, date/datum
    const title = f.title || f.titel || f.name || "?";
    const daysLeft = f.days_left !== undefined ? f.days_left : (f.tage_offen !== undefined ? f.tage_offen : null);
    const cls = daysLeft !== null && daysLeft <= 7 ? "urgent" : daysLeft !== null && daysLeft <= 30 ? "warning" : "";
    const row = el("div", { className: "frist-item" + (cls ? " " + cls : "") });
    row.append(el("span", { textContent: title }));
    if (daysLeft !== null) {
      row.append(el("span", { className: "frist-days", textContent: `${daysLeft}d` }));
    } else if (f.date || f.datum) {
      row.append(el("span", { className: "frist-days", textContent: f.date || f.datum }));
    }
    card.append(row);
  }
  if (!card.querySelector(".frist-item")) {
    card.append(el("div", { className: "briefing-empty", textContent: emptyText }));
  }
}

function renderBriefingPageList(card, items, opts) {
  const { emptyText = t("briefing.no_entries"), asLink = false } = opts || {};
  if (!items.length) {
    card.append(el("div", { className: "briefing-empty", textContent: emptyText }));
    return;
  }
  for (const it of items) {
    const row = el("div", { className: "frist-item" });
    const label = it.title || it.file || "?";
    if (asLink && it.url) {
      const a = el("a", { textContent: label, href: it.url });
      a.target = "_blank"; a.rel = "noopener";
      a.addEventListener("click", (e) => { e.preventDefault(); window.open(it.url, "_blank", "noopener"); });
      row.append(a);
    } else {
      const extra = it.status && it.status !== "—" ? ` · ${it.status}` : "";
      row.append(el("span", { textContent: label + extra }));
    }
    if (it.days_ago !== null && it.days_ago !== undefined) {
      row.append(el("span", { className: "frist-days", textContent: `${it.days_ago}d` }));
    }
    card.append(row);
  }
}

function renderBriefingVideoCards(card, items, type) {
  if (!items.length) {
    card.append(el("div", { className: "briefing-empty", textContent: t("briefing.no_videos") }));
    return;
  }

  const MAX_VISIBLE = 5;
  const visible = items.slice(0, MAX_VISIBLE);
  const hidden = items.slice(MAX_VISIBLE);

  const appendVideoCard = (parent, v) => {
    const cardEl = el("a", { className: "briefing-video-card", href: v.url || "#" });
    cardEl.target = "_blank";
    cardEl.rel = "noopener";
    cardEl.addEventListener("click", (e) => {
      e.preventDefault();
      if (v.url) window.open(v.url, "_blank", "noopener");
    });

    // Thumbnail (optional)
    if (v.thumbnail) {
      const img = el("img", { className: "briefing-video-thumb", src: v.thumbnail, alt: "" });
      img.loading = "lazy";
      img.addEventListener("error", () => img.remove());
      cardEl.append(img);
    } else if (type !== "playlist_trending") {
      // Platzhalter nur bei video-typischen Sections, nicht bei playlist
      const ph = el("div", { className: "briefing-video-thumb" });
      cardEl.append(ph);
    }

    const meta = el("div", { className: "briefing-video-meta" });
    meta.append(el("div", { className: "briefing-video-title", textContent: v.title || t("briefing.untitled") }));
    if (v.channel_title) {
      meta.append(el("div", { className: "briefing-video-channel", textContent: v.channel_title }));
    }
    const statsParts = [];
    if (typeof v.views === "number") statsParts.push(t("youtube.views", { count: briefingFormatNumber(v.views) }));
    if (typeof v.likes === "number") statsParts.push(t("youtube.likes", { count: briefingFormatNumber(v.likes) }));
    if (v.published_at) statsParts.push(briefingRelativeTime(v.published_at));
    if (statsParts.length) {
      meta.append(el("div", { className: "briefing-video-stats", textContent: statsParts.join(" • ") }));
    }
    cardEl.append(meta);
    parent.append(cardEl);
  };

  for (const v of visible) appendVideoCard(card, v);

  if (hidden.length) {
    const details = el("details", { className: "briefing-show-more" });
    const summary = el("summary", { textContent: t("briefing.show_more", { count: hidden.length }) });
    details.append(summary);
    for (const v of hidden) appendVideoCard(details, v);
    card.append(details);
  }
}

function renderBriefingRecommendations(card, items) {
  if (!items.length) {
    card.append(el("div", { className: "briefing-empty", textContent: t("briefing.no_recommendations") }));
    return;
  }
  const kindIcons = { artikel: "📝", video: "🎬", tipp: "💡" };
  for (const r of items) {
    const row = el("div", { className: "briefing-reco-card" });
    const icon = kindIcons[r.kind] || "💡";
    row.append(el("span", { className: "briefing-reco-icon", textContent: icon }));
    row.append(el("p", { className: "briefing-reco-text", textContent: r.text || "" }));
    card.append(row);
  }
}

export async function checkPendingBrainPick() {
  const { brainPick } = await chrome.storage.local.get("brainPick");
  if (!brainPick || !brainPick.url) return;
  if (brainPick.ts && Date.now() - brainPick.ts > 5 * 60 * 1000) {
    chrome.storage.local.remove("brainPick");
    return;
  }
  chrome.storage.local.remove("brainPick");
  await showBrainModal(brainPick);
}

async function showBrainModal({ url, tabId, prefetched }) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "brain-modal" });
  dialog.append(el("h3", { textContent: t("briefing.save_video_to_brain") }));
  const thumb = makeYouTubeThumb(url);
  if (thumb) {
    thumb.classList.add("yt-thumb-large");
    dialog.append(thumb);
  }
  dialog.append(el("div", { className: "brain-modal-meta", textContent: url }));

  const status = el("div", {
    className: "tool-status",
    textContent: prefetched ? t("briefing.suggesting_tags") : t("briefing.extracting_transcript"),
  });
  dialog.append(status);

  const cancelBtn = el("button", { type: "button", textContent: t("common.cancel"), className: "secondary" });
  cancelBtn.addEventListener("click", () => overlay.remove());

  overlay.append(dialog);
  document.body.append(overlay);

  const httpBase = await getHttpBase();
  const vaultId = await getActiveVaultId(httpBase);
  if (!vaultId) {
    status.textContent = t("briefing.no_vault_configured");
    status.className = "tool-status error";
    dialog.append(cancelBtn);
    return;
  }

  // auto_brain ODER nur auto_tag (bei prefetched)
  let brainData = null;
  try {
    let dataPromise;
    if (prefetched) {
      // Transcript+Title schon da → nur Tag-Suggestion holen
      dataPromise = fetch(`${httpBase}/tools/auto_tag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: prefetched.transcript,
          title: prefetched.title || url,
          vault_id: vaultId,
        }),
      }).then(async (r) => {
        const t = await r.text();
        let j = null;
        try { j = JSON.parse(t); } catch {}
        if (!r.ok) throw new Error(j?.detail || t || `HTTP ${r.status}`);
        return {
          transcript: prefetched.transcript,
          title: prefetched.title || url,
          url,
          suggestion: j.data || j,
        };
      });
    } else {
      // Klassischer Pfad: auto_brain holt Transcript + Tags
      dataPromise = fetch(`${httpBase}/tools/auto_brain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, vault_id: vaultId, tab_id: tabId }),
      }).then(async (r) => {
        const t = await r.text();
        let j = null;
        try { j = JSON.parse(t); } catch {}
        if (!r.ok) throw new Error(j?.detail || t || `HTTP ${r.status}`);
        return j.data || j;
      });
    }
    brainData = await dataPromise;
  } catch (err) {
    status.textContent = t("common.error_msg", { message: err.message || err });
    status.className = "tool-status error";
    dialog.append(cancelBtn);
    return;
  }

  status.textContent = "";
  status.className = "tool-status";

  dialog.append(el("div", { className: "brain-modal-title", textContent: brainData.title || url }));

  const suggestion = brainData.suggestion || {};
  const confidenceCls = { high: "high", medium: "medium", low: "low" }[suggestion.confidence] || "low";
  dialog.append(el("span", { className: `confidence-badge ${confidenceCls}`, textContent: suggestion.confidence || "?" }));

  // Thema (freies Frontmatter-Feld, kein Ordner/Whitelist)
  const themaLabel = el("label", { textContent: t("briefing.thema_label") });
  const themaInput = el("input", { type: "text", placeholder: t("briefing.thema_placeholder"), value: suggestion.thema || "" });

  // Playlist-Dropdown mit Lazy-Load
  const playlistLabel = el("label", { textContent: t("briefing.playlist_label") });
  const playlistSelect = el("select");
  const playlistNewInput = el("input", { type: "text", placeholder: t("briefing.new_playlist_placeholder") });
  playlistNewInput.style.display = "none";

  async function loadPlaylists() {
    try {
      const res = await fetch(`${httpBase}/tools/playlists/${vaultId}`);
      const data = await res.json().catch(() => ({}));
      const items = data.items || [];
      playlistSelect.replaceChildren();
      items.forEach(p => {
        const opt = new Option(p.name, p.name);
        if (p.name === suggestion.playlist_name) opt.selected = true;
        playlistSelect.append(opt);
      });
      playlistSelect.append(new Option(t("briefing.new_playlist_option"), "__new__"));
    } catch {}
  }

  playlistSelect.addEventListener("change", () => {
    playlistNewInput.style.display = playlistSelect.value === "__new__" ? "block" : "none";
  });

  await loadPlaylists();

  dialog.append(themaLabel, themaInput, playlistLabel, playlistSelect, playlistNewInput);

  if (suggestion.tags && suggestion.tags.length) {
    dialog.append(el("div", { className: "brain-modal-tags", textContent: suggestion.tags.map(t => `#${t}`).join(" ") }));
  }

  // Ingest-Checkbox
  const ingestRow = el("label", { className: "checkbox-row" });
  const ingestCb = el("input", { type: "checkbox" });
  ingestCb.checked = true;
  ingestRow.append(ingestCb, el("span", { textContent: t("briefing.ingest_now") }));
  ingestRow.style.cssText = "margin-top:8px;font-size:12px;";
  dialog.append(ingestRow);

  const saveStatus = el("div", { className: "tool-status" });
  dialog.append(saveStatus);

  const actions = el("div", { className: "playlist-picker-actions" });
  const saveBtn = el("button", { type: "button", textContent: t("common.save"), className: "primary" });

  saveBtn.addEventListener("click", async () => {
    const thema = themaInput.value.trim() || null;
    const playlistName = playlistSelect.value === "__new__"
      ? playlistNewInput.value.trim()
      : playlistSelect.value;
    if (!playlistName || playlistName === "__new__") {
      saveStatus.textContent = t("briefing.playlist_required");
      saveStatus.className = "tool-status error";
      return;
    }
    saveBtn.disabled = true;
    saveStatus.textContent = t("common.saving");
    saveStatus.className = "tool-status";
    try {
      const res = await fetch(`${httpBase}/tools/brain/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vault_id: vaultId,
          url,
          title: brainData.title || url,
          transcript: brainData.transcript || "",
          thema,
          playlist_name: playlistName,
          tags: suggestion.tags || [],
          ingest_now: ingestCb.checked,
        }),
      });
      const resText = await res.text();
      let resData = null;
      try { resData = JSON.parse(resText); } catch {}
      if (!res.ok) throw new Error(resData?.detail || resText || `HTTP ${res.status}`);
      if (resData?.data?.ingest_warning) {
        saveStatus.textContent = t("briefing.saved_ingest_warning", { warning: resData.data.ingest_warning });
        saveStatus.className = "tool-status";
        setTimeout(() => overlay.remove(), 2500);
      } else {
        overlay.remove();
      }
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes("Schreibrecht") || msg.includes("write_raw") || msg.includes("write_playlists")) {
        saveStatus.innerHTML = `${t("briefing.missing_perm")} <a href="#" id="perm-link">${t("briefing.enable_in_options")}</a>`;
        saveStatus.querySelector("#perm-link").addEventListener("click", e => {
          e.preventDefault();
          chrome.runtime.openOptionsPage();
        });
      } else {
        saveStatus.textContent = t("common.error_msg", { message: msg });
      }
      saveStatus.className = "tool-status error";
      saveBtn.disabled = false;
    }
  });

  actions.append(cancelBtn, saveBtn);
  dialog.append(actions);
}

export async function checkActiveTabForYoutube() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && /^https?:\/\/(www\.)?youtube\.com\/watch/.test(tab.url)) {
      showBrainHint(tab.url, tab.id);
    } else {
      hideBrainHint();
    }
  } catch {
    hideBrainHint();
  }
}

function showBrainHint(url, tabId) {
  if (document.getElementById("brain-hint-btn")) return;
  const btn = el("button", {
    type: "button",
    id: "brain-hint-btn",
    className: "quick-btn quick-btn--brain",
  });
  btn.append(el("span", { className: "quick-icon", textContent: "⬇" }));
  btn.append(el("span", { textContent: "Brain" }));
  btn.addEventListener("click", () => showBrainModal({ url, tabId }));
  document.getElementById("quick-actions")?.append(btn);
}

function hideBrainHint() {
  document.getElementById("brain-hint-btn")?.remove();
}

export async function renderDocumentIngest() {
  state.panelTitle.textContent = t("briefing.document_ingest_title");

  const SUBFOLDERS = ["artikel", "eigene-notizen", "kunden-input", "chat-archive"];

  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = ".pdf,.txt,.md";
  fileInput.style.cssText = "width:100%;margin-bottom:8px;";

  const titleInput = el("input");
  titleInput.type = "text";
  titleInput.placeholder = t("briefing.ingest_title_placeholder");
  titleInput.style.cssText = "width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#444);background:var(--bg-card,#2a2a2a);color:var(--text,inherit);box-sizing:border-box;margin-bottom:8px;font-size:13px;";

  const subfolderSelect = el("select");
  subfolderSelect.style.cssText = "width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#444);background:var(--bg-card,#2a2a2a);color:var(--text,inherit);margin-bottom:12px;font-size:13px;";
  SUBFOLDERS.forEach(sf => subfolderSelect.append(el("option", { value: sf, textContent: sf })));

  const sensitiveRow = el("label");
  sensitiveRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:12px;font-size:12px;cursor:pointer;";
  const sensitiveCb = el("input");
  sensitiveCb.type = "checkbox";
  sensitiveRow.append(sensitiveCb, el("span", { textContent: t("briefing.mark_sensitive") }));

  const uploadBtn = el("button", { textContent: t("briefing.save_to_vault_raw") });
  uploadBtn.style.cssText = "width:100%;";
  uploadBtn.disabled = true;

  const status = el("div", { className: "tool-status" });
  const resultBox = el("div");
  resultBox.style.cssText = "margin-top:10px;font-size:12px;color:var(--muted,#888);word-break:break-all;";

  fileInput.addEventListener("change", () => {
    uploadBtn.disabled = !fileInput.files?.length;
    status.textContent = "";
    resultBox.textContent = "";
  });

  uploadBtn.addEventListener("click", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    uploadBtn.disabled = true;
    status.textContent = t("briefing.uploading");
    status.className = "tool-status";
    resultBox.textContent = "";
    try {
      const httpBase = await getHttpBase();
      const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
      if (!selectedVaultId) throw new Error(t("briefing.no_vault_selected"));
      const fd = new FormData();
      fd.append("file", file);
      fd.append("vault_id", selectedVaultId);
      fd.append("subfolder", subfolderSelect.value);
      fd.append("title", titleInput.value.trim());
      fd.append("sensitive", sensitiveCb.checked ? "true" : "false");
      const res = await fetch(`${httpBase}/tools/ingest/document`, { method: "POST", body: fd });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      const rawPath = data?.data?.relative_path || data?.data?.raw_path || "";
      status.textContent = t("briefing.saved");
      status.className = "tool-status success";
      if (rawPath) resultBox.textContent = rawPath;
      fileInput.value = "";
      titleInput.value = "";
      uploadBtn.disabled = true;
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
      uploadBtn.disabled = false;
    }
  });

  state.panelBody.replaceChildren(fileInput, titleInput, subfolderSelect, sensitiveRow, uploadBtn, status, resultBox);
}
