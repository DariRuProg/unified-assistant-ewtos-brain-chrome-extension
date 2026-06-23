// Theme and dark mode helpers. ewtos.com

const html = document.documentElement;

export function applyTheme(theme, darkMode) {
  if (theme && theme !== "neutral") {
    html.dataset.theme = theme;
  } else {
    delete html.dataset.theme;
  }
  if (darkMode) {
    html.dataset.mode = "dark";
  } else {
    delete html.dataset.mode;
  }
}

export function updateDarkToggleIcon(darkMode) {
  const btn = document.getElementById("dark-toggle");
  if (btn) btn.textContent = darkMode ? "☽" : "☀";
}
