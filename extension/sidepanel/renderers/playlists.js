// Playlists-Tool + Tab-Capture Renderer. ewtos.com
import { el, makeYouTubeThumb } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase, getActiveVault, getActiveVaultId, withVaultId } from '../modules/api.js';
import { renderMarkdown, openInObsidian } from '../markdown.js';
import { openTool } from '../modules/tool-runner.js';

export async function checkPendingPlaylistPick() {
  const { playlistPick } = await chrome.storage.local.get("playlistPick");
  if (!playlistPick || !playlistPick.url) return;
  // ignore stale picks (older than 5 min)
  if (playlistPick.ts && Date.now() - playlistPick.ts > 5 * 60 * 1000) {
    chrome.storage.local.remove("playlistPick");
    return;
  }
  await showPlaylistPicker(playlistPick);
}

async function showPlaylistPicker({ url, title, channel, duration, views, published, likes, description }) {
  const httpBase = await getHttpBase();
  const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
  let vaultId = selectedVaultId;
  if (!vaultId) {
    try {
      const res = await fetch(`${httpBase}/vaults`);
      const data = await res.json();
      vaultId = data.vaults?.[0]?.id;
    } catch {}
  }
  if (!vaultId) return;

  let playlists = [];
  try {
    const res = await fetch(`${httpBase}/tools/playlists/${vaultId}`);
    const data = await res.json();
    playlists = data.items || [];
  } catch (err) {
    if (err?.message?.includes("403") || String(err).includes("403")) {
      alert("Playlists-Permission ist im Vault nicht aktiviert. In den Optionen freischalten.");
    }
    chrome.storage.local.remove("playlistPick");
    return;
  }

  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "playlist-picker" });
  const titleEl = el("h3", { textContent: "Zu Playlist hinzufügen" });
  const meta = el("div", { className: "playlist-picker-meta" });
  const metaParts = [title || url];
  if (channel) metaParts.push(`· ${channel}`);
  if (duration) metaParts.push(`· ${duration}`);
  if (views) metaParts.push(`· ${views}`);
  meta.textContent = metaParts.join(" ");
  meta.title = url;

  // Auto-Pull-Optionen
  const optsRow = el("div", { className: "playlist-picker-opts" });
  const pullLabel = el("label", { className: "checkbox-row" });
  const pullCheckbox = el("input", { type: "checkbox" });
  pullCheckbox.checked = true;  // default on — User wollte das ja explizit
  const pullText = el("span", { textContent: "Transcript ziehen + Summary erstellen" });
  pullLabel.append(pullCheckbox, pullText);
  const tsLabel = el("label", { className: "checkbox-row" });
  const tsCheckbox = el("input", { type: "checkbox" });
  tsCheckbox.checked = false;  // default: Transcript ohne Zeitstempel
  const tsText = el("span", { textContent: "mit Zeitstempeln" });
  tsLabel.append(tsCheckbox, tsText);
  optsRow.append(pullLabel, tsLabel);

  const list = el("div", { className: "playlist-picker-list" });

  if (!playlists.length) {
    const empty = el("div", { className: "playlist-picker-empty" });
    empty.textContent = "Noch keine Playlists. Lege eine an:";
    const newName = el("input", { type: "text", placeholder: "Playlist-Name (z.B. KI Tutorials)" });
    const createBtn = el("button", { textContent: "Anlegen + hinzufügen" });
    createBtn.addEventListener("click", async () => {
      const name = newName.value.trim();
      if (!name) return;
      try {
        await fetch(`${httpBase}/tools/playlists/${vaultId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        }).then((r) => { if (!r.ok) throw new Error("create failed"); });
        const meta = { url, title, channel, duration, views, published, likes, description };
        const opts = { autoPull: pullCheckbox.checked, withTimestamps: tsCheckbox.checked };
        await addAndMaybePull(httpBase, vaultId, name, meta, opts);
        cleanup(true);
      } catch (err) {
        alert("Fehler: " + err.message);
      }
    });
    empty.append(newName, createBtn);
    list.append(empty);
  } else {
    for (const p of playlists) {
      const btn = el("button", { type: "button", className: "playlist-pick-btn" });
      btn.textContent = `${p.name} (${p.item_count})`;
      btn.addEventListener("click", async () => {
        try {
          const meta = { url, title, channel, duration, views, published, likes, description };
          const opts = { autoPull: pullCheckbox.checked, withTimestamps: tsCheckbox.checked };
          await addAndMaybePull(httpBase, vaultId, p.name, meta, opts);
          cleanup(true);
        } catch (err) {
          alert("Fehler: " + err.message);
        }
      });
      list.append(btn);
    }
    // Plus: neue Playlist gleich anlegen
    const sep = el("div", { className: "playlist-picker-sep", textContent: "oder neu:" });
    const newName = el("input", { type: "text", placeholder: "neuer Playlist-Name" });
    const createBtn = el("button", { textContent: "Anlegen + hinzufügen" });
    createBtn.addEventListener("click", async () => {
      const name = newName.value.trim();
      if (!name) return;
      try {
        await fetch(`${httpBase}/tools/playlists/${vaultId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        }).then((r) => { if (!r.ok) throw new Error("create failed"); });
        const meta = { url, title, channel, duration, views, published, likes, description };
        const opts = { autoPull: pullCheckbox.checked, withTimestamps: tsCheckbox.checked };
        await addAndMaybePull(httpBase, vaultId, name, meta, opts);
        cleanup(true);
      } catch (err) {
        alert("Fehler: " + err.message);
      }
    });
    list.append(sep, newName, createBtn);
  }

  const cancelBtn = el("button", { type: "button", className: "secondary", textContent: "Abbrechen" });
  cancelBtn.addEventListener("click", () => cleanup(false));

  dialog.append(titleEl, meta, optsRow, list, cancelBtn);
  overlay.append(dialog);
  document.body.append(overlay);

  function cleanup(success) {
    chrome.storage.local.remove("playlistPick");
    overlay.remove();
  }
}

async function addAndMaybePull(httpBase, vaultId, name, meta, opts) {
  const { url, title, channel, duration, views, published, likes, description } = meta;
  const { autoPull, withTimestamps } = opts;

  // 1) Add to playlist (creates video page with all metadata)
  const addRes = await fetch(
    `${httpBase}/tools/playlists/${vaultId}/${encodeURIComponent(name)}/items`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        title,
        youtuber: channel,
        dauer: duration,
        views,
        published,
        likes,
        description,
      }),
    },
  );
  if (!addRes.ok) {
    const text = await addRes.text().catch(() => "");
    throw new Error(`Add failed (${addRes.status}): ${text}`);
  }
  const addData = await addRes.json();
  if (addData.added === false) {
    const reason = addData.reason === "duplicate"
      ? `'${title}' ist bereits in '${name}'.`
      : `Nicht hinzugefügt: ${addData.reason || "unbekannt"}`;
    alert(reason);
    return addData;
  }
  const videoSlug = (addData.video_page || "").split("/").pop();
  if (!autoPull || !videoSlug) return addData;

  // 2) Auto-Pull: Transcript + Summary as background flow.
  // Hand off to background worker via runtime message — keeps the picker
  // closing instantly while the heavy work runs.
  chrome.runtime.sendMessage({
    type: "auto_pull_video",
    payload: { httpBase, vaultId, slug: videoSlug, url, withTimestamps },
  }).catch(() => {});

  return addData;
}

export async function renderPlaylistsTool() {
  state.panelTitle.textContent = "Playlists";
  state.panelBody.replaceChildren();

  const status = el("div", { className: "tool-status" });
  const toolbar = el("div", { className: "playlist-toolbar" });
  const newBtn = el("button", { textContent: "+ Neue Playlist", type: "button" });
  const captureYtBtn = el("button", {
    textContent: "📑 Markierte YT-Tabs",
    type: "button",
    title: "Alle markierten YouTube-Tabs zu einer Playlist hinzufügen",
  });
  captureYtBtn.addEventListener("click", () => captureHighlightedYoutubeTabs());
  toolbar.append(newBtn, captureYtBtn);
  const listWrap = el("div", { className: "playlist-list" });
  state.panelBody.append(toolbar, status, listWrap);

  const httpBase = await getHttpBase();
  const vaultId = await getActiveVaultId(httpBase);
  if (!vaultId) {
    status.textContent = "Kein Vault konfiguriert. In den Einstellungen anlegen.";
    status.className = "tool-status error";
    return;
  }

  newBtn.addEventListener("click", () => showCreatePlaylistDialog(httpBase, vaultId, () => renderPlaylistsTool()));

  status.textContent = "lade...";
  try {
    const res = await fetch(`${httpBase}/tools/playlists/${vaultId}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      status.textContent = `Fehler ${res.status}: ${err.detail || ""}`;
      status.className = "tool-status error";
      return;
    }
    const data = await res.json();
    const items = data.items || [];
    status.textContent = "";
    if (!items.length) {
      listWrap.append(el("div", { className: "empty", textContent: "Noch keine Playlists. Mit '+ Neue Playlist' anlegen." }));
      return;
    }
    // Group by saeule
    const groups = {};
    for (const p of items) {
      const k = p.saeule || "knowledge-library/ai";
      if (!groups[k]) groups[k] = [];
      groups[k].push(p);
    }
    for (const saeule of Object.keys(groups).sort()) {
      const section = el("div", { className: "playlist-group" });
      section.append(el("h4", { className: "playlist-group-header", textContent: saeule }));
      const ul = el("ul", { className: "playlist-items" });
      for (const p of groups[saeule]) {
        const li = el("li", { className: "playlist-item" });
        const main = el("div", { className: "playlist-item-main" });
        main.append(el("span", { className: "playlist-name", textContent: p.name }));
        main.append(el("span", { className: "playlist-count", textContent: `${p.item_count} Items` }));
        li.append(main);
        li.addEventListener("click", () => renderPlaylistDetail(p.name, p.saeule));
        ul.append(li);
      }
      section.append(ul);
      listWrap.append(section);
    }
  } catch (err) {
    status.textContent = `Fehler: ${err.message || err}`;
    status.className = "tool-status error";
  }
}

function showCreatePlaylistDialog(httpBase, vaultId, onCreated) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "playlist-picker" });
  dialog.append(el("h3", { textContent: "Neue Playlist anlegen" }));

  const nameInput = el("input", { type: "text", placeholder: "Playlist-Name (z.B. KI Tutorials)" });
  const themaInput = el("input", { type: "text", placeholder: "Thema (frei, optional)" });
  const saeuleInput = el("input", { type: "text", placeholder: "Säule (z.B. knowledge-library/ai, work/crafts/web-development/skills/wordpress)", value: "knowledge-library/ai" });
  const status = el("div", { className: "tool-status" });
  const actions = el("div", { className: "playlist-picker-actions" });
  const cancel = el("button", { type: "button", textContent: "Abbrechen" });
  const ok = el("button", { type: "button", textContent: "Anlegen", className: "primary" });
  actions.append(cancel, ok);

  dialog.append(nameInput, themaInput, saeuleInput, status, actions);
  overlay.append(dialog);
  document.body.append(overlay);

  cancel.addEventListener("click", () => overlay.remove());
  ok.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { status.textContent = "Name ist Pflicht"; status.className = "tool-status error"; return; }
    const saeule = saeuleInput.value.trim() || "knowledge-library/ai";
    const body = { name, thema: themaInput.value.trim() || null };
    ok.disabled = true; status.textContent = "lege an...";
    try {
      const url = `${httpBase}/tools/playlists/${vaultId}?saeule=${encodeURIComponent(saeule)}`;
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        status.textContent = `Fehler ${res.status}: ${err.detail || ""}`;
        status.className = "tool-status error";
        ok.disabled = false;
        return;
      }
      overlay.remove();
      onCreated && onCreated();
    } catch (err) {
      status.textContent = `Fehler: ${err.message || err}`;
      status.className = "tool-status error";
      ok.disabled = false;
    }
  });
  nameInput.focus();
}

async function renderPlaylistDetail(name, saeule) {
  state.panelTitle.textContent = `${name} (${saeule})`;
  state.panelBody.replaceChildren();

  const toolbar = el("div", { className: "playlist-toolbar" });
  const backBtn = el("button", { type: "button", textContent: "← zurück" });
  backBtn.addEventListener("click", () => renderPlaylistsTool());
  const pullBtn = el("button", { type: "button", textContent: "⏬ Alle Pending ziehen", title: "Alle Videos ohne Transcript automatisch abrufen" });
  const infoBtn = el("button", {
    type: "button",
    textContent: "ⓘ",
    className: "info-btn",
    title: "Summary-Workflow erklären",
  });
  infoBtn.addEventListener("click", () => showSummaryWorkflowInfo(name));
  toolbar.append(backBtn, pullBtn, infoBtn);
  const status = el("div", { className: "tool-status" });
  const orchestrationStatus = el("div", { className: "orchestration-status hidden" });
  const itemsWrap = el("div", { className: "playlist-items-detail" });
  state.panelBody.append(toolbar, status, orchestrationStatus, itemsWrap);

  const httpBase = await getHttpBase();
  const vault = await getActiveVault(httpBase);
  if (!vault) { status.textContent = "Kein Vault."; return; }
  const vaultId = vault.id;
  // Obsidian-Vault-Name = Ordnername (letztes Pfad-Segment), nicht der frei
  // vergebene Anzeige-Name aus EwtosBrain — sonst greift obsidian://open nicht.
  const vaultName = vault.path.split(/[\\/]/).filter(Boolean).pop() || vault.name;

  pullBtn.addEventListener("click", () => runPullPending({
    httpBase, vaultId, playlistName: name, saeule,
    statusEl: orchestrationStatus, button: pullBtn,
    onDone: () => renderPlaylistDetail(name, saeule),
  }));

  status.textContent = "lade...";
  try {
    const url = `${httpBase}/tools/playlists/${vaultId}/${encodeURIComponent(name)}?saeule=${encodeURIComponent(saeule)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      status.textContent = `Fehler ${res.status}: ${err.detail || ""}`;
      status.className = "tool-status error";
      return;
    }
    const data = await res.json();
    const items = data.items || [];
    status.textContent = "";
    if (!items.length) {
      itemsWrap.append(el("div", { className: "empty", textContent: "Noch keine Videos. Auf YouTube Rechtsklick → 'In Playlist speichern' oder per YouTube-Transcript-Tool aus dem aktiven Tab pullen." }));
      return;
    }
    for (const it of items) {
      itemsWrap.append(renderVideoCard(httpBase, vaultId, vaultName, name, saeule, it));
    }
  } catch (err) {
    status.textContent = `Fehler: ${err.message || err}`;
    status.className = "tool-status error";
  }
}

function renderVideoCard(httpBase, vaultId, vaultName, playlistName, saeule, it) {
  const card = el("div", { className: "playlist-item-card" });
  const head = el("div", { className: "playlist-item-head" });
  const thumb = makeYouTubeThumb(it.url);
  if (thumb) head.append(thumb);
  const headText = el("div", { className: "playlist-item-headtext" });
  headText.append(el("div", { className: "playlist-item-title", textContent: it.title }));
  const meta = el("div", { className: "playlist-item-meta" });
  if (it.channel) meta.append(el("span", { textContent: it.channel }));
  if (it.added) meta.append(el("span", { textContent: it.added }));
  headText.append(meta);
  head.append(headText);
  card.append(head);

  const links = el("div", { className: "playlist-item-links" });
  if (it.url) {
    const a = el("a", { textContent: "YouTube", href: it.url, target: "_blank" });
    a.rel = "noopener noreferrer";
    links.append(a);
  }

  const detailsBtn = el("button", { type: "button", textContent: "▼ Details", className: "small details-toggle" });
  links.append(detailsBtn);

  if (it.page) {
    const slug = it.page.split("/").pop();
    const chatBtn = el("button", { type: "button", textContent: "💬 Chat", className: "small" });
    chatBtn.addEventListener("click", () => openTool("chat", {
      sourceType: "video",
      sourceRef: { vault_id: vaultId, slug, saeule },
      sourceTitle: it.title,
    }));
    links.append(chatBtn);

    const obsidianBtn = el("button", { type: "button", textContent: "✎ Obsidian", className: "small obsidian-button" });
    obsidianBtn.addEventListener("click", () => openInObsidian(vaultName, it.page + ".md"));
    links.append(obsidianBtn);
  }

  const removeBtn = el("button", { type: "button", textContent: "Entfernen", className: "small" });
  removeBtn.addEventListener("click", () => showRemoveDialog({
    httpBase, vaultId, playlistName, saeule, item: it,
    onDone: () => renderPlaylistDetail(playlistName, saeule),
  }));
  links.append(removeBtn);
  card.append(links);

  // Details-Akkordeon (lazy load)
  const details = el("div", { className: "playlist-item-details hidden" });
  card.append(details);
  let loaded = false;
  detailsBtn.addEventListener("click", async () => {
    const isHidden = details.classList.contains("hidden");
    if (isHidden) {
      details.classList.remove("hidden");
      detailsBtn.textContent = "▲ Details";
      if (!loaded && it.page) {
        details.textContent = "lade...";
        try {
          const fileUrl = `${httpBase}/tools/vault_file/${vaultId}?rel_path=${encodeURIComponent(it.page + ".md")}`;
          const res = await fetch(fileUrl);
          if (!res.ok) {
            const e = await res.json().catch(() => ({}));
            details.textContent = `Fehler beim Laden: ${e.detail || res.status}`;
            return;
          }
          const data = await res.json();
          details.replaceChildren();
          renderMasterPagePreview(details, data.content || "", httpBase, vaultId, vaultName);
          loaded = true;
        } catch (err) {
          details.textContent = `Fehler: ${err.message || err}`;
        }
      }
    } else {
      details.classList.add("hidden");
      detailsBtn.textContent = "▼ Details";
    }
  });
  return card;
}

function renderMasterPagePreview(target, mdContent, httpBase, vaultId, vaultName) {
  // Strip frontmatter
  let body = mdContent;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) body = body.slice(end + 4).replace(/^\n+/, "");
  }
  // Find sections: ## Kern-Insights, ## Zusammenfassung, ## Transcript
  const sections = {};
  const headerRe = /^##\s+(.+?)\s*$/gm;
  const positions = [];
  let m;
  while ((m = headerRe.exec(body)) !== null) {
    positions.push({ name: m[1].trim(), start: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const next = positions[i + 1];
    sections[p.name] = body.slice(p.contentStart, next ? next.start : body.length).trim();
  }

  const insights = sections["Kern-Insights"];
  const summary = sections["Zusammenfassung"];
  const transcript = sections["Transcript"];

  if (insights) {
    target.append(el("h5", { className: "preview-h", textContent: "Kern-Insights" }));
    const div = el("div", { className: "preview-md" });
    div.innerHTML = renderMarkdown(insights);
    target.append(div);
  }
  if (summary) {
    target.append(el("h5", { className: "preview-h", textContent: "Zusammenfassung" }));
    const div = el("div", { className: "preview-md" });
    div.innerHTML = renderMarkdown(summary);
    target.append(div);
  }
  if (transcript) {
    target.append(el("h5", { className: "preview-h", textContent: "Transcript" }));
    // Transcript-Sektion ist meist nur ein Wikilink — extract und mache Vault-File-Read-Link
    const wl = transcript.match(/\[\[([^\]]+)\]\]/);
    if (wl) {
      const transcriptPath = wl[1] + ".md";
      const a = el("a", {
        textContent: "Transcript anzeigen",
        href: "#",
        className: "obsidian-link",
      });
      a.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const existing = target.querySelector(".transcript-content");
        if (existing) { existing.remove(); return; }
        const wrap = el("div", { className: "transcript-content" });
        wrap.textContent = "lade...";
        target.append(wrap);
        try {
          const url = `${httpBase}/tools/vault_file/${vaultId}?rel_path=${encodeURIComponent(transcriptPath)}`;
          const r = await fetch(url);
          const d = await r.json();
          let txt = d.content || "";
          if (txt.startsWith("---")) {
            const end = txt.indexOf("\n---", 3);
            if (end !== -1) txt = txt.slice(end + 4).replace(/^\n+/, "");
          }
          wrap.textContent = "";
          const pre = el("pre", { className: "transcript-text", textContent: txt });
          wrap.append(pre);
        } catch (err) {
          wrap.textContent = `Fehler: ${err.message || err}`;
        }
      });
      target.append(a);
      const obsidianA = el("button", {
        type: "button",
        textContent: "  •  in Obsidian öffnen",
        className: "obsidian-link-btn",
      });
      obsidianA.addEventListener("click", () => openInObsidian(vaultName, transcriptPath));
      target.append(obsidianA);
    } else {
      const div = el("div", { className: "preview-md" });
      div.innerHTML = renderMarkdown(transcript);
      target.append(div);
    }
  }
  if (!insights && !summary && !transcript) {
    target.append(el("div", { className: "empty", textContent: "Noch keine Insights, Summary oder Transcript. Werden automatisch ergänzt sobald du das Video pullst oder im Wiki-Workflow ergänzt." }));
  }
}

async function runPullPending({ httpBase, vaultId, playlistName, saeule, statusEl, button, onDone }) {
  // Custom-Dialog statt nativem confirm — wegen Summary-Checkbox
  const summarize = await showPullPendingDialog(playlistName);
  if (summarize === null) return; // Abbrechen

  button.disabled = true;
  statusEl.classList.remove("hidden");
  statusEl.classList.remove("error");
  const summarizeNote = summarize ? " + Auto-Summary (API-Token!)" : "";
  statusEl.textContent = `Starte Orchestrierung${summarizeNote} — bitte Extension geöffnet halten und Browser nicht schließen…`;

  try {
    const url = `${httpBase}/tools/playlists/${vaultId}/${encodeURIComponent(playlistName)}/pull_pending?saeule=${encodeURIComponent(saeule)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ with_timestamps: false, summarize }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      statusEl.textContent = `Fehler ${r.status}: ${e.detail || ""}`;
      statusEl.classList.add("error");
      button.disabled = false;
      return;
    }
    const result = await r.json();
    statusEl.textContent = formatOrchestrationResult(result);
    button.disabled = false;
    onDone && onDone();
  } catch (err) {
    statusEl.textContent = `Fehler: ${err.message || err}`;
    statusEl.classList.add("error");
    button.disabled = false;
  }
}

function showSummaryWorkflowInfo(playlistName) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "playlist-picker" });
  dialog.append(el("h3", { textContent: "Summary-Workflow" }));
  const body = el("div", { className: "summary-hint" });
  body.innerHTML = `
    <p style="margin:0 0 6px;">Zwei Pfade, beide schreiben Insights + Zusammenfassung in die Master-Pages.</p>
    <ul>
      <li><strong>Subscription</strong> (kein API-Token): in Claude Code tippen<br><code>/wiki-summaries ${playlistName}</code><br>oder ohne Argument für alle pending im Vault.</li>
      <li><strong>API-Key</strong> (EwtosBrain-Anthropic-Key): unten <strong>⏬ Alle Pending ziehen</strong> → Häkchen <em>"+ Summary"</em>. Kostet Anthropic-Tokens.</li>
    </ul>
  `;
  dialog.append(body);
  const actions = el("div", { className: "playlist-picker-actions" });
  const ok = el("button", { type: "button", textContent: "Verstanden", className: "primary" });
  ok.addEventListener("click", () => overlay.remove());
  actions.append(ok);
  dialog.append(actions);
  overlay.append(dialog);
  document.body.append(overlay);
}

function showPullPendingDialog(playlistName) {
  return new Promise((resolve) => {
    const overlay = el("div", { className: "playlist-picker-overlay" });
    const dialog = el("div", { className: "playlist-picker" });
    dialog.append(el("h3", { textContent: `Pending Transcripts ziehen` }));
    dialog.append(el("div", {
      className: "remove-dialog-info",
      textContent: `'${playlistName}' — pro Video ~10-15s, öffnet jeweils ein Hidden-Window in Chrome.`,
    }));

    const summaryRow = el("label", { className: "summary-checkbox-row" });
    const summaryCb = el("input", { type: "checkbox" });
    summaryRow.append(summaryCb, document.createTextNode(" + Summary über EwtosBrain-API-Key (kostet Anthropic-Tokens)"));
    dialog.append(summaryRow);

    const hint = el("div", { className: "summary-hint-inline" });
    hint.innerHTML = `Tipp: für Summary auf <strong>Subscription</strong> stattdessen <code>/wiki-summaries ${playlistName}</code> in Claude Code.`;
    dialog.append(hint);

    const actions = el("div", { className: "playlist-picker-actions" });
    const cancel = el("button", { type: "button", textContent: "Abbrechen" });
    const ok = el("button", { type: "button", textContent: "Ziehen", className: "primary" });
    actions.append(cancel, ok);
    dialog.append(actions);
    overlay.append(dialog);
    document.body.append(overlay);

    cancel.addEventListener("click", () => { overlay.remove(); resolve(null); });
    ok.addEventListener("click", () => { const v = summaryCb.checked; overlay.remove(); resolve(v); });
  });
}

function formatOrchestrationResult(r) {
  const lines = [];
  if (r.aborted) {
    lines.push(`⚠ Abgebrochen: ${r.abort_reason || "unbekannt"}`);
  }
  lines.push(`✓ Fertig: ${r.transcribed}/${r.total} transkribiert`);
  if (r.skipped_already_done) lines.push(`  (${r.skipped_already_done} hatten schon Transcript)`);
  if (r.failed && r.failed.length) {
    lines.push(`✗ ${r.failed.length} fehlgeschlagen:`);
    for (const f of r.failed.slice(0, 5)) {
      lines.push(`   • ${f.title}: ${f.error}`);
    }
    if (r.failed.length > 5) lines.push(`   …+${r.failed.length - 5} weitere`);
  }
  return lines.join("\n");
}

function showRemoveDialog({ httpBase, vaultId, playlistName, saeule, item, onDone }) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "playlist-picker remove-dialog" });
  dialog.append(el("h3", { textContent: `'${item.title}' entfernen?` }));
  dialog.append(el("div", {
    className: "remove-dialog-info",
    textContent: "Wähle, was passieren soll:",
  }));

  const status = el("div", { className: "tool-status" });
  const actions = el("div", { className: "remove-dialog-actions" });
  const cancelBtn = el("button", { type: "button", textContent: "Abbrechen" });
  const justPlaylistBtn = el("button", { type: "button", textContent: "Nur aus Playlist", className: "primary" });
  const fullDeleteBtn = el("button", { type: "button", textContent: "Auch Master-Page + Transcript löschen", className: "danger" });
  actions.append(cancelBtn, justPlaylistBtn, fullDeleteBtn);
  dialog.append(status, actions);
  overlay.append(dialog);
  document.body.append(overlay);

  const close = () => overlay.remove();
  cancelBtn.addEventListener("click", close);

  async function doRemove(alsoDeleteMaster) {
    justPlaylistBtn.disabled = true;
    fullDeleteBtn.disabled = true;
    status.textContent = "läuft...";
    try {
      const matchValue = item.url || item.title;
      const url = `${httpBase}/tools/playlists/${vaultId}/${encodeURIComponent(playlistName)}/items/delete?saeule=${encodeURIComponent(saeule)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ match: matchValue, also_delete_master: alsoDeleteMaster }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        status.textContent = `Fehler ${r.status}: ${e.detail || ""}`;
        status.className = "tool-status error";
        justPlaylistBtn.disabled = false;
        fullDeleteBtn.disabled = false;
        return;
      }
      const result = await r.json();
      close();
      if (alsoDeleteMaster) {
        if (result.master_deleted) {
          alert(`Komplett gelöscht. Transcript: ${result.transcript_deleted ? "auch gelöscht" : "kein Transcript vorhanden"}.`);
        } else if (!result.became_orphan) {
          alert("Aus Playlist entfernt — Master-Page bleibt, weil das Video noch in einer anderen Playlist ist.");
        }
      }
      onDone && onDone();
    } catch (err) {
      status.textContent = `Fehler: ${err.message || err}`;
      status.className = "tool-status error";
      justPlaylistBtn.disabled = false;
      fullDeleteBtn.disabled = false;
    }
  }
  justPlaylistBtn.addEventListener("click", () => doRemove(false));
  fullDeleteBtn.addEventListener("click", () => doRemove(true));
}

async function scrapeYoutubeMetaForTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const titleEl = document.querySelector("h1.ytd-watch-metadata yt-formatted-string")
        || document.querySelector("ytd-video-primary-info-renderer h1");
      const docTitle = (document.title || "").replace(/\s*-\s*YouTube\s*$/, "").trim();
      const title = (titleEl?.textContent || docTitle).trim();
      const channelEl = document.querySelector("ytd-channel-name #text-container yt-formatted-string a")
        || document.querySelector("ytd-channel-name a");
      const channel = (channelEl?.textContent || "").trim();
      let duration = document.querySelector(".ytp-time-duration")?.textContent?.trim() || "";
      if (!duration) {
        const m = document.querySelector("meta[itemprop='duration']")?.content?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (m) {
          const h = +m[1] || 0, mi = +m[2] || 0, s = +m[3] || 0;
          const pad = (n) => String(n).padStart(2, "0");
          duration = h > 0 ? `${h}:${pad(mi)}:${pad(s)}` : `${mi}:${pad(s)}`;
        }
      }
      return { title, channel, duration };
    },
  });
  return result?.result || { title: "", channel: "", duration: "" };
}

async function captureHighlightedYoutubeTabs() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
  } catch (err) {
    alert("Konnte Tabs nicht lesen: " + (err.message || err));
    return;
  }
  const ytTabs = tabs.filter((t) => t.url && /^https?:\/\/(www\.)?youtube\.com\/watch/.test(t.url));
  if (!ytTabs.length) {
    alert("Keine markierten YouTube-Tabs. Tipp: Strg+Klick im Tab-Strip auf YouTube-Watch-Tabs, dann hier klicken.");
    return;
  }
  const httpBase = await getHttpBase();
  const vault = await getActiveVault(httpBase);
  if (!vault) { alert("Kein Vault konfiguriert."); return; }
  // Meta parallel scrapen (Channel/Title/Duration), POSTs danach seriell.
  const items = await Promise.all(ytTabs.map(async (t) => {
    let meta = { title: t.title || t.url, channel: "", duration: "" };
    try {
      const scraped = await scrapeYoutubeMetaForTab(t.id);
      meta = { title: scraped.title || meta.title, channel: scraped.channel, duration: scraped.duration };
    } catch (err) {
      console.warn("scrape failed for tab", t.id, err);
    }
    return { url: t.url, title: meta.title, channel: meta.channel, duration: meta.duration };
  }));
  showMultiYoutubePicker(httpBase, vault, items);
}

function showMultiYoutubePicker(httpBase, vault, items) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "playlist-picker multi-yt-picker" });
  dialog.append(el("h3", { textContent: `${items.length} markierte YouTube-Tabs` }));

  const itemList = el("ul", { className: "multi-yt-items" });
  for (const it of items) {
    const li = el("li");
    const titleSpan = el("span", { className: "multi-yt-title", textContent: it.title });
    li.append(titleSpan);
    if (it.channel) li.append(el("span", { className: "multi-yt-channel", textContent: ` · ${it.channel}` }));
    itemList.append(li);
  }
  dialog.append(itemList);

  // Smart-Vorschlag: alle vom selben Kanal? Dann Auto-Playlist-Name vorschlagen
  const channels = [...new Set(items.map((i) => i.channel).filter(Boolean))];
  let autoPlaylistName = "";
  if (channels.length === 1 && channels[0]) {
    autoPlaylistName = channels[0];
    const hint = el("div", { className: "multi-yt-hint" });
    hint.textContent = `Alle vom Kanal: ${channels[0]} — Playlist mit diesem Namen anlegen?`;
    dialog.append(hint);
  }

  const status = el("div", { className: "tool-status" });
  const playlistList = el("div", { className: "playlist-picker-list" });
  dialog.append(el("div", { className: "playlist-picker-sep", textContent: "Bestehende Playlist:" }));
  dialog.append(playlistList, status);

  // Neue Playlist Section
  const sep = el("div", { className: "playlist-picker-sep", textContent: "oder neue Playlist anlegen:" });
  const newName = el("input", { type: "text", placeholder: "Name (z.B. Karpathy-Videos)", value: autoPlaylistName });
  const newSaeule = el("input", { type: "text", placeholder: "Säule (default: knowledge-library/ai)", value: "knowledge-library/ai" });
  const createBtn = el("button", { type: "button", textContent: "Anlegen + alle hinzufügen", className: "primary" });
  dialog.append(sep, newName, newSaeule, createBtn);

  const cancelBtn = el("button", { type: "button", className: "secondary", textContent: "Abbrechen" });
  dialog.append(cancelBtn);
  cancelBtn.addEventListener("click", () => overlay.remove());

  overlay.append(dialog);
  document.body.append(overlay);

  // Bestehende Playlists laden
  (async () => {
    try {
      const r = await fetch(`${httpBase}/tools/playlists/${vault.id}`);
      const data = await r.json();
      const playlists = data.items || [];
      if (!playlists.length) {
        playlistList.append(el("div", { className: "empty", textContent: "(keine bestehenden Playlists)" }));
        return;
      }
      for (const p of playlists) {
        const btn = el("button", { type: "button", className: "playlist-pick-btn" });
        btn.textContent = `[${p.saeule}] ${p.name} (${p.item_count})`;
        btn.addEventListener("click", () => bulkAddToPlaylist(httpBase, vault.id, p.name, p.saeule, items, status, () => overlay.remove()));
        playlistList.append(btn);
      }
    } catch (err) {
      playlistList.append(el("div", { className: "empty", textContent: `Fehler: ${err.message || err}` }));
    }
  })();

  createBtn.addEventListener("click", async () => {
    const name = newName.value.trim();
    const saeule = newSaeule.value.trim() || "knowledge-library/ai";
    if (!name) { status.textContent = "Name fehlt"; status.className = "tool-status error"; return; }
    createBtn.disabled = true;
    status.textContent = "lege Playlist an…";
    try {
      const r = await fetch(`${httpBase}/tools/playlists/${vault.id}?saeule=${encodeURIComponent(saeule)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        status.textContent = `Fehler ${r.status}: ${e.detail || ""}`;
        status.className = "tool-status error";
        createBtn.disabled = false;
        return;
      }
    } catch (err) {
      status.textContent = `Fehler: ${err.message || err}`;
      status.className = "tool-status error";
      createBtn.disabled = false;
      return;
    }
    await bulkAddToPlaylist(httpBase, vault.id, name, saeule, items, status, () => overlay.remove());
  });
}

async function bulkAddToPlaylist(httpBase, vaultId, playlistName, saeule, items, statusEl, onDone) {
  statusEl.textContent = `füge 0/${items.length} hinzu…`;
  statusEl.className = "tool-status";
  let added = 0, duplicate = 0;
  const failed = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      const url = `${httpBase}/tools/playlists/${vaultId}/${encodeURIComponent(playlistName)}/items?saeule=${encodeURIComponent(saeule)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: it.url, title: it.title, youtuber: it.channel, dauer: it.duration,
        }),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.added) added++;
        else duplicate++;
      } else {
        failed.push(it.title);
      }
    } catch (err) {
      failed.push(it.title);
    }
    statusEl.textContent = `füge ${i + 1}/${items.length} hinzu…`;
  }
  let msg = `✓ ${added} hinzugefügt`;
  if (duplicate) msg += ` · ${duplicate} schon drin`;
  if (failed.length) msg += ` · ${failed.length} fehlgeschlagen`;
  alert(msg);
  onDone && onDone();
  // Liste refreshen falls in der Detail-View
  if (typeof renderPlaylistsTool === "function") renderPlaylistsTool();
}

export async function captureHighlightedTabs(httpBase, vaultId, button, onDone) {
  // Sidepanel-Klick triggert keinen Body-Click → Multi-Tab-Markierung bleibt
  // erhalten (im Gegensatz zum Page-Body-Rechtsklick, wo Chrome oft alle
  // außer dem aktiven Tab deselektiert).
  let tabs;
  try {
    tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
  } catch (err) {
    alert("Konnte Tabs nicht lesen: " + (err.message || err));
    return;
  }
  const httpTabs = tabs.filter((t) => t.url && /^https?:/.test(t.url));
  if (!httpTabs.length) {
    alert("Keine markierten Tabs mit http(s)-URL. Tipp: Strg+Klick im Tab-Strip mehrere Tabs markieren, dann hier klicken.");
    return;
  }
  if (httpTabs.length === 1) {
    if (!confirm(
      "Nur 1 Tab markiert. Trotzdem als Bookmark speichern?\n\n" +
      "Tipp: Strg+Klick im Tab-Strip auf weitere Tabs markieren, dann hier klicken."
    )) return;
  }
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "läuft…";
  let saved = 0;
  const failed = [];
  for (const t of httpTabs) {
    try {
      const r = await fetch(withVaultId(`${httpBase}/tools/bookmarks`, vaultId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: t.url,
          title: t.title || t.url,
          source: "sidepanel-multi-tab",
        }),
      });
      if (r.ok) saved++;
      else failed.push(t.title || t.url);
    } catch (err) {
      failed.push(t.title || t.url);
    }
  }
  button.disabled = false;
  button.textContent = original;
  let msg = `${saved} Tab${saved === 1 ? "" : "s"} als Bookmark gespeichert.`;
  if (failed.length) msg += `\n${failed.length} fehlgeschlagen:\n  ${failed.slice(0, 5).join("\n  ")}`;
  alert(msg);
  onDone && onDone();
}

export async function copyHighlightedTabUrls(button) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
  } catch (err) {
    alert("Konnte Tabs nicht lesen: " + (err.message || err));
    return;
  }
  const httpTabs = tabs.filter((t) => t.url && /^https?:/.test(t.url));
  if (!httpTabs.length) {
    alert("Keine markierten Tabs mit http(s)-URL. Tipp: Strg+Klick im Tab-Strip mehrere Tabs markieren, dann hier klicken.");
    return;
  }
  const text = httpTabs.map((t) => t.url).join("\n");
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    alert("Clipboard-Fehler: " + (err.message || err));
    return;
  }
  const original = button.textContent;
  button.textContent = `✓ ${httpTabs.length} URL${httpTabs.length === 1 ? "" : "s"} kopiert`;
  button.disabled = true;
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1800);
}
