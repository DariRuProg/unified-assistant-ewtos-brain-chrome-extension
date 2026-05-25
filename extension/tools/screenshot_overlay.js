// ewtos.com — Region-Selection Overlay (injected content script)
(function () {
  if (document.getElementById("ewtos-region-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "ewtos-region-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    cursor: "crosshair",
    background: "rgba(0,0,0,0.35)",
  });

  const hint = document.createElement("div");
  Object.assign(hint.style, {
    position: "absolute",
    top: "14px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(0,0,0,0.75)",
    color: "#fff",
    padding: "6px 16px",
    borderRadius: "6px",
    fontSize: "13px",
    fontFamily: "system-ui, sans-serif",
    pointerEvents: "none",
    userSelect: "none",
    whiteSpace: "nowrap",
  });
  hint.textContent = "Bereich aufziehen — Esc zum Abbrechen";
  overlay.append(hint);

  const selBox = document.createElement("div");
  Object.assign(selBox.style, {
    position: "absolute",
    border: "2px solid #3b82f6",
    background: "rgba(59,130,246,0.12)",
    display: "none",
    pointerEvents: "none",
    boxSizing: "border-box",
  });
  overlay.append(selBox);

  let start = null;

  function remove() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }

  function onKey(e) {
    if (e.key === "Escape") {
      remove();
      chrome.runtime.sendMessage({ type: "region_cancelled" });
    }
  }
  document.addEventListener("keydown", onKey);

  overlay.addEventListener("mousedown", (e) => {
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY };
    selBox.style.left = e.clientX + "px";
    selBox.style.top = e.clientY + "px";
    selBox.style.width = "0";
    selBox.style.height = "0";
    selBox.style.display = "block";
  });

  overlay.addEventListener("mousemove", (e) => {
    if (!start) return;
    const x = Math.min(start.x, e.clientX);
    const y = Math.min(start.y, e.clientY);
    const w = Math.abs(e.clientX - start.x);
    const h = Math.abs(e.clientY - start.y);
    selBox.style.left = x + "px";
    selBox.style.top = y + "px";
    selBox.style.width = w + "px";
    selBox.style.height = h + "px";
  });

  overlay.addEventListener("mouseup", (e) => {
    if (!start) return;
    const x = Math.min(start.x, e.clientX);
    const y = Math.min(start.y, e.clientY);
    const w = Math.abs(e.clientX - start.x);
    const h = Math.abs(e.clientY - start.y);
    remove();
    if (w < 4 || h < 4) {
      chrome.runtime.sendMessage({ type: "region_cancelled" });
      return;
    }
    chrome.runtime.sendMessage({ type: "region_selected", rect: { x, y, w, h } });
  });

  document.body.append(overlay);
})();
