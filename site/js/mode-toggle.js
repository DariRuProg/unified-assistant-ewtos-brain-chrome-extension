(function () {
  var root = document.documentElement;
  var btn = document.getElementById('modeBtn');
  if (!btn) return;
  var sun = btn.querySelector('.icon-sun');
  var moon = btn.querySelector('.icon-moon');

  function render() {
    var dark = root.dataset.mode !== 'light';
    sun.style.display = dark ? 'block' : 'none';
    moon.style.display = dark ? 'none' : 'block';
    btn.setAttribute('aria-label', dark ? 'Zum hellen Modus wechseln' : 'Zum dunklen Modus wechseln');
  }

  btn.addEventListener('click', function () {
    root.dataset.mode = root.dataset.mode === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('ewtos-appearance', JSON.stringify({ mode: root.dataset.mode })); } catch (e) {}
    render();
  });

  render();
})();
