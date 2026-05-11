// YouTube transcript scraper — opens video in a hidden minimized window,
// clicks the "Show transcript" button, scrapes segments with timestamps.
//
// Ported from OfficeBrain-Extension-Youtube-Transcript-Getter.

const TAB_LOAD_DELAY_MS = 6000;
const TRANSCRIPT_RENDER_DELAY_MS = 2000;

export async function runYoutubeTranscript(params) {
  const url = params?.url;
  const withTimestamps = !!params?.with_timestamps;
  if (!url) throw new Error("url required");

  const win = await createHiddenWindow();
  try {
    const result = await fetchTranscript(url, win.id);
    if (!withTimestamps && result?.transcript) {
      result.transcript = stripTimestamps(result.transcript);
    }
    return result;
  } finally {
    chrome.windows.remove(win.id).catch(() => {});
  }
}

function stripTimestamps(text) {
  // Lines look like "[HH:MM:SS] content" — drop the bracket-prefix
  return text
    .split("\n")
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, ""))
    .join("\n");
}

function createHiddenWindow() {
  // Hinweis: state:"minimized" funktioniert für die meisten Videos, schlägt
  // aber bei manchen fehl, wenn YouTube auf Panel-Sichtbarkeit wartet (Lazy-
  // Loading via IntersectionObserver). Off-Screen-Positionierung wurde
  // versucht, scheiterte an Chrome-Window-Create-Restriktionen. Robusterer
  // Fallback langfristig: yt-dlp/youtube-transcript-api als Backend-Pfad
  // ohne Browser (siehe backlog_yt_transcript_fallback.md).
  return new Promise((resolve) => {
    chrome.windows.create({ type: "normal", focused: false, width: 400, height: 400 }, (win) => {
      chrome.windows.update(win.id, { state: "minimized" }, () => resolve(win));
    });
  });
}

function fetchTranscript(url, windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ windowId, url, active: true }, (tab) => {
      const tabId = tab.id;
      chrome.tabs.update(tabId, { muted: true }).catch(() => {});

      setTimeout(() => {
        chrome.scripting.executeScript(
          { target: { tabId }, func: scrapeYouTubeTranscript },
          (results) => {
            chrome.tabs.remove(tabId).catch(() => {});
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            const result = results?.[0]?.result;
            if (!result) {
              reject(new Error("No result from injected script"));
              return;
            }
            if (result.error) {
              reject(new Error(result.error));
              return;
            }
            resolve({ url, transcript: result.text });
          },
        );
      }, TAB_LOAD_DELAY_MS);
    });
  });
}

// Injected into the YouTube tab. Self-contained — no closures from outer scope.
function scrapeYouTubeTranscript() {
  try {
    const expandButton = document.querySelector("#expand");
    if (expandButton) expandButton.click();

    const transcriptButton = document.querySelector(
      "ytd-video-description-transcript-section-renderer button",
    );
    if (transcriptButton) {
      transcriptButton.click();
    } else {
      const moreActions = document.querySelector("ytd-menu-renderer yt-icon-button#button");
      if (moreActions) {
        moreActions.click();
        setTimeout(() => {
          const item = Array.from(
            document.querySelectorAll("ytd-menu-service-item-renderer"),
          ).find(
            (el) =>
              el.textContent.includes("Transkript anzeigen") ||
              el.textContent.includes("Show transcript"),
          );
          if (item) item.click();
        }, 500);
      }
    }

    // Polling statt fixem Delay: längere Videos und langsame Verbindungen
    // brauchen länger, bis YouTube die Segments lazy-loaded ins Panel hängt.
    // Wir checken alle 400ms, ob Segments da sind — max 12s warten.
    return new Promise((resolve) => {
      const POLL_MS = 400;
      const MAX_WAIT_MS = 12000;
      const start = Date.now();

      function findPanel() {
        // Engagement-Panel-Wrapper hat verschiedene target-id-Werte je YouTube-Version.
        // Reihenfolge: neue modern_transcript-Variante zuerst (enthält tatsächlich
        // gerenderte Segments), das alte searchable_transcript-Panel als Fallback
        // (kann leer/Spinner sein, wenn YouTube parallel die neue Variante ausspielt).
        const panels = document.querySelectorAll(
          "ytd-engagement-panel-section-list-renderer",
        );
        for (const p of panels) {
          const id = (p.getAttribute("target-id") || "").toLowerCase();
          if (id.includes("modern_transcript") || id.includes("modern-transcript")) return p;
        }
        return (
          document.querySelector(
            'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
          ) ||
          document.querySelector(
            'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]',
          ) ||
          // Neue Lit-Components (yt-prefix statt ytd-prefix)
          document.querySelector('yt-section-list-renderer') ||
          document.querySelector("ytd-transcript-renderer") ||
          document.querySelector("ytd-transcript-segment-list-renderer") ||
          document.querySelector("ytd-transcript-search-panel-renderer")
        );
      }

      function collectSegments(panel) {
        let text = "";
        // Alte Polymer-Renderer
        const oldEls = panel.querySelectorAll("ytd-transcript-segment-renderer");
        if (oldEls.length > 0) {
          oldEls.forEach((el) => {
            const time = el.querySelector(".segment-timestamp")?.textContent?.trim() || "";
            const tx = el.querySelector(".segment-text")?.textContent?.trim() || "";
            if (tx) text += `[${time}] ${tx}\n`;
          });
          return { count: oldEls.length, text };
        }
        // View-Model-Renderer (Übergangsphase)
        const newEls = panel.querySelectorAll("transcript-segment-view-model");
        if (newEls.length > 0) {
          newEls.forEach((el) => {
            const timeEl = el.querySelector('[class*="Timestamp"]');
            const textEl = el.querySelector('span[role="text"]');
            const time = timeEl ? timeEl.textContent.trim() : "";
            const tx = textEl ? textEl.textContent.trim() : "";
            if (tx) text += `[${time}] ${tx}\n`;
          });
          return { count: newEls.length, text };
        }
        // Neue Lit-Components: yt-item-section-renderer / yt-section-list-renderer
        const litEls = panel.querySelectorAll("yt-item-section-renderer, yt-section-renderer");
        if (litEls.length > 0) {
          litEls.forEach((el) => {
            // Innerhalb der Lit-Components stecken die Segments — extrahiere generisch
            const time = el.querySelector('[class*="timestamp" i], [class*="Timestamp"], yt-formatted-string[id*="time" i]')?.textContent?.trim() || "";
            const tx = el.querySelector('[class*="snippet-text" i], yt-formatted-string[role="text"], span[role="text"], yt-formatted-string')?.textContent?.trim() || "";
            if (tx) text += `[${time}] ${tx}\n`;
          });
          return { count: litEls.length, text };
        }
        // Macro-Markers-Panel (neue Variante mit Kapiteln) — DOM-weit suchen,
        // weil die Komponenten u.U. außerhalb des erkannten Panel-Wrappers liegen
        // (eigene Web-Component-Hierarchie, parallel zu engagement-panel-*).
        const macroEls = document.querySelectorAll("macro-markers-panel-item-view-model");
        if (macroEls.length > 0) {
          let macroCount = 0;
          macroEls.forEach((el) => {
            const chapter = el.querySelector("h3.ytwTimelineChapterViewModelTitle");
            if (chapter) {
              const title = chapter.textContent.trim();
              if (title) text += `\n## ${title}\n`;
              return;
            }
            const ts = el.querySelector("div.ytwTranscriptSegmentViewModelTimestamp");
            const tx = el.querySelector("span.ytAttributedStringHost");
            if (ts && tx) {
              text += `[${ts.textContent.trim()}] ${tx.textContent.trim()}\n`;
              macroCount++;
            }
          });
          if (macroCount > 0) return { count: macroCount, text };
        }
        // Fallback 1: generische Listitems mit Timestamp + Text
        const generic = panel.querySelectorAll('[role="listitem"], div[class*="segment"]');
        if (generic.length > 0) {
          generic.forEach((el) => {
            const time = el.querySelector('[class*="timestamp" i], [class*="Timestamp"]')?.textContent?.trim() || "";
            const tx = el.querySelector('[class*="text" i] yt-formatted-string, span[role="text"], yt-formatted-string')?.textContent?.trim() || "";
            if (tx) text += `[${time}] ${tx}\n`;
          });
          return { count: generic.length, text };
        }
        // Fallback 2: TreeWalker — extrahiere alle Text-Nodes, die einem Timestamp-Pattern folgen
        // Robust gegen Selector-Wandel, aber unschöner Output (keine Trennung)
        const allText = panel.textContent || "";
        const matches = allText.match(/(\d+:\d+(?::\d+)?)[\s ]+([^\n\d][^\n]+)/g);
        if (matches && matches.length > 0) {
          matches.forEach((m) => { text += m + "\n"; });
          return { count: matches.length, text };
        }
        return { count: 0, text: "" };
      }

      function tick() {
        const panel = findPanel();
        if (!panel) {
          if (Date.now() - start >= MAX_WAIT_MS) {
            resolve({ error: "Kein Transcript-Panel gefunden (12s gewartet)." });
            return;
          }
          setTimeout(tick, POLL_MS);
          return;
        }
        const { count, text } = collectSegments(panel);
        if (count > 0 && text.trim().length > 0) {
          resolve({ text });
          return;
        }
        if (Date.now() - start >= MAX_WAIT_MS) {
          resolve({
            error: `Transcript-Panel gefunden, aber leer (12s gewartet, ${count} Elemente, ${text.length} Zeichen).`,
          });
          return;
        }
        setTimeout(tick, POLL_MS);
      }

      // Erstes Polling nach 800ms — Panel braucht meist 1-3s nach Click
      setTimeout(tick, 800);
    });
  } catch (err) {
    return { error: err.toString() };
  }
}
