// Lightbox-Viewer fuer Image-Gen-Galerie. ewtos.com

const params = new URLSearchParams(window.location.search);
const file = params.get("file") || "";
const server = params.get("server") || "";

const imgEl = document.getElementById("img");
const stage = document.getElementById("stage");
const overlay = document.getElementById("overlay");
const toggle = document.getElementById("toggle");
const promptEl = document.getElementById("prompt");
const metaEl = document.getElementById("meta");
const dlBtn = document.getElementById("dl");
const editBtn = document.getElementById("edit");
const closeBtn = document.getElementById("close");

if (!file || !server) {
  promptEl.textContent = "Fehler: file oder server-Parameter fehlt.";
  promptEl.classList.add("empty");
} else {
  const imgUrl = `${server}/tools/image_generated/${file}`;
  imgEl.src = imgUrl;
  document.title = "EwtosBrain — " + file.split("/").pop();

  // Galerie-Index holen → Prompt + Modell
  (async () => {
    try {
      const res = await fetch(`${server}/tools/image_gallery`);
      const data = await res.json();
      const entry = (data.items || []).find((e) => e.file === file);
      if (entry) {
        const promptText = (entry.prompt || "").trim();
        if (promptText) {
          promptEl.textContent = promptText;
        } else {
          promptEl.textContent = "(Kein Prompt im Index gespeichert)";
          promptEl.classList.add("empty");
        }
        const parts = [];
        if (entry.model) parts.push(entry.model);
        if (entry.created) {
          try {
            const d = new Date(entry.created);
            parts.push(d.toLocaleString("de-DE"));
          } catch { parts.push(entry.created); }
        }
        if (typeof entry.input_count === "number" && entry.input_count > 0) {
          parts.push(`${entry.input_count} Input-Bild(er)`);
        }
        parts.push(file);
        metaEl.innerHTML = parts.map((p, i) => i === 0 ? p : `<span class="sep">·</span>${p}`).join("");
      } else {
        promptEl.textContent = "(Kein Galerie-Eintrag gefunden)";
        promptEl.classList.add("empty");
        metaEl.textContent = file;
      }
    } catch (err) {
      promptEl.textContent = "Galerie laden fehlgeschlagen: " + (err.message || err);
      promptEl.classList.add("empty");
    }
  })();

  dlBtn.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = imgUrl;
    a.download = file.split("/").pop();
    a.click();
  });

  editBtn.addEventListener("click", async () => {
    await chrome.storage.local.set({
      imgGenPick: { file, ts: Date.now() },
    });
    // Tab schliessen — der User wechselt zum Sidepanel, wo der Pick uebernommen wird.
    window.close();
  });
}

toggle.addEventListener("click", () => overlay.classList.toggle("open"));

closeBtn.addEventListener("click", () => window.close());

// ESC schliesst, Leertaste togglet Overlay
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.close();
  else if (e.key === " " || e.key === "Spacebar") {
    e.preventDefault();
    overlay.classList.toggle("open");
  }
});

// Klick aufs Bild togglet Zoom (1:1 vs. fit)
imgEl.addEventListener("click", (e) => {
  e.stopPropagation();
  stage.classList.toggle("zoomed");
});
