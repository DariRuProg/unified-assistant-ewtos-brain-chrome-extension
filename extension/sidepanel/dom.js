// DOM helper utilities. ewtos.com

export function el(tag, props = {}) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  return node;
}

export function extractYouTubeId(url) {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}

export function makeYouTubeThumb(url) {
  const id = extractYouTubeId(url);
  if (!id) return null;
  const img = el("img", { className: "yt-thumb", src: `https://img.youtube.com/vi/${id}/mqdefault.jpg`, alt: "" });
  img.loading = "lazy";
  img.onerror = () => img.classList.add("yt-thumb-error");
  return img;
}
