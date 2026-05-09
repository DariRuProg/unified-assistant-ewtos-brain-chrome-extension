// YouTube-Meta: zieht Title, Channel, Duration, Views, Publish-Date, Likes,
// Description aus dem aktiven YouTube-Tab via DOM-Scrape. ~300ms, kein Transcript.

export async function runYoutubeMeta({ tabId } = {}) {
  if (!tabId) throw new Error("tabId fehlt");
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const url = location.href;

      // --- Title ---
      const titleEl = document.querySelector("h1.ytd-watch-metadata yt-formatted-string")
        || document.querySelector("h1.title yt-formatted-string")
        || document.querySelector("ytd-video-primary-info-renderer h1");
      const docTitle = (document.title || "").replace(/\s*-\s*YouTube\s*$/, "").trim();
      const title = (titleEl?.textContent || docTitle).trim();

      // --- Channel ---
      const channelEl = document.querySelector("ytd-channel-name #text-container yt-formatted-string a")
        || document.querySelector("ytd-channel-name a")
        || document.querySelector("[itemprop='author'] [itemprop='name']");
      const channel = (channelEl?.textContent || "").trim();

      // --- Duration ---
      let duration = "";
      const durEl = document.querySelector(".ytp-time-duration");
      if (durEl) duration = durEl.textContent.trim();
      if (!duration) {
        const meta = document.querySelector("meta[itemprop='duration']");
        if (meta?.content) {
          const m = meta.content.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (m) {
            const h = parseInt(m[1] || "0", 10);
            const min = parseInt(m[2] || "0", 10);
            const s = parseInt(m[3] || "0", 10);
            const pad = (n) => String(n).padStart(2, "0");
            duration = h > 0 ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
          }
        }
      }

      // --- Views ---
      let views = "";
      const viewsEl = document.querySelector(".view-count")
        || document.querySelector("ytd-video-view-count-renderer .view-count")
        || document.querySelector("#info .view-count");
      if (viewsEl) views = viewsEl.textContent.trim();
      if (!views) {
        const interactionMeta = document.querySelector("meta[itemprop='interactionCount']");
        if (interactionMeta?.content) views = interactionMeta.content + " views";
      }

      // --- Publish-Date ---
      let published = "";
      const pubMeta = document.querySelector("meta[itemprop='datePublished']");
      if (pubMeta?.content) published = pubMeta.content.slice(0, 10);
      if (!published) {
        const uploadMeta = document.querySelector("meta[itemprop='uploadDate']");
        if (uploadMeta?.content) published = uploadMeta.content.slice(0, 10);
      }
      if (!published) {
        // Fallback: "vor 3 Tagen" aus den Info-Strings — schwer zu parsen, leer lassen
        const dateEl = document.querySelector("#info-strings yt-formatted-string");
        if (dateEl) published = dateEl.textContent.trim();
      }

      // --- Likes ---
      let likes = "";
      // Like-Button hat aria-label mit Count
      const likeBtn = document.querySelector("ytd-toggle-button-renderer button[aria-label*='Mag']")
        || document.querySelector("ytd-segmented-like-dislike-button-renderer button[aria-label*='Mag']")
        || document.querySelector("button[aria-label*='likes']")
        || document.querySelector("button[aria-label*='Like']");
      if (likeBtn) {
        const aria = likeBtn.getAttribute("aria-label") || "";
        const m = aria.match(/[\d., \s]+/);
        if (m) likes = m[0].trim();
      }
      if (!likes) {
        const likeText = document.querySelector("#segmented-like-button button .yt-spec-button-shape-next__button-text-content");
        if (likeText) likes = likeText.textContent.trim();
      }

      // --- Description (gekürzt auf 800 Zeichen, fürs Frontmatter zu lang) ---
      let description = "";
      const descEl = document.querySelector("#description-inline-expander yt-attributed-string")
        || document.querySelector("#description yt-formatted-string")
        || document.querySelector("ytd-text-inline-expander #snippet")
        || document.querySelector("meta[itemprop='description']");
      if (descEl) {
        description = (descEl.content || descEl.textContent || "").trim();
      }
      if (description.length > 800) description = description.slice(0, 800) + "…";

      return { url, title, channel, duration, views, published, likes, description };
    },
  });
  if (!result?.result) throw new Error("Konnte YouTube-Metadaten nicht lesen");
  return result.result;
}
