// YouTube transcript scraper — opens video in a hidden minimized window,
// clicks the "Show transcript" button, scrapes segments with timestamps.
//
// Ported from OfficeBrain-Extension-Youtube-Transcript-Getter.

const TAB_LOAD_DELAY_MS = 6000;
const TRANSCRIPT_RENDER_DELAY_MS = 2000;

export async function runYoutubeTranscript(params) {
  const url = params?.url;
  if (!url) throw new Error("url required");

  const win = await createHiddenWindow();
  try {
    return await fetchTranscript(url, win.id);
  } finally {
    chrome.windows.remove(win.id).catch(() => {});
  }
}

function createHiddenWindow() {
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

    return new Promise((resolve) => {
      setTimeout(() => {
        let fullText = "";

        const oldEls = document.querySelectorAll("ytd-transcript-segment-renderer");
        if (oldEls.length > 0) {
          oldEls.forEach((el) => {
            const time = el.querySelector(".segment-timestamp")?.textContent?.trim() || "";
            const text = el.querySelector(".segment-text")?.textContent?.trim() || "";
            if (text) fullText += `[${time}] ${text}\n`;
          });
        } else {
          const newEls = document.querySelectorAll("transcript-segment-view-model");
          newEls.forEach((el) => {
            const timeEl = el.querySelector('[class*="Timestamp"]');
            const textEl = el.querySelector('span[role="text"]');
            const time = timeEl ? timeEl.textContent.trim() : "";
            const text = textEl ? textEl.textContent.trim() : "";
            if (text) fullText += `[${time}] ${text}\n`;
          });
        }

        if (fullText.length > 0) resolve({ text: fullText });
        else resolve({ error: "Kein Transkript-Panel gefunden oder leer." });
      }, 2000);
    });
  } catch (err) {
    return { error: err.toString() };
  }
}
