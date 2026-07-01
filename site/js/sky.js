/**
 * Himmel-Effekte für das "ewtos Studio"-Theme.
 * @author Dario | ewtos.com
 *
 * Injiziert einen .sky-fx-Layer (Sonne + Sternenfeld) in die dunklen
 * Studio-Sektionen und lässt per Zufallsintervall Sternschnuppen fliegen.
 * Sichtbarkeit wird per CSS über --stars-opacity gesteuert (0 im Hell-Modus).
 */
(function () {
  var SKY_SECTIONS = ['#office-brain', '#ueber', '#warum', '#download', 'footer'];
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  SKY_SECTIONS.forEach(function (sel) {
    var el = document.querySelector(sel);
    if (!el || el.querySelector('.sky-fx')) return;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';

    var fx = document.createElement('div');
    fx.className = 'sky-fx';
    fx.setAttribute('aria-hidden', 'true');

    // #cover hat bereits ein eigenes .stars-Feld — andere Sektionen bekommen eins
    if (sel !== '#cover') {
      var stars = document.createElement('div');
      stars.className = 'stars';
      fx.appendChild(stars);
    }
    var sun = document.createElement('div');
    sun.className = 'sun';
    fx.appendChild(sun);

    el.insertBefore(fx, el.firstChild);
  });

  if (reduceMotion) return;

  function isStudio() { var t = document.documentElement.dataset.theme; return t === 'studio' || t === 'studio-nova'; }
  function inViewport(el) {
    var vh = window.innerHeight || document.documentElement.clientHeight;
    if (!vh) return true; // Umgebung ohne Viewport-Höhe → nicht blockieren
    var r = el.getBoundingClientRect();
    return r.top < vh && r.bottom > 0;
  }

  function launchShootingStar() {
    if (isStudio()) {
      document.querySelectorAll('.sky-fx').forEach(function (fx) {
        if (parseFloat(getComputedStyle(fx).opacity) < 0.1) return; // im Hell-Modus aus
        if (!inViewport(fx)) return;

        var star = document.createElement('div');
        star.className = 'shooting-star';
        star.style.left = (8 + Math.random() * 55) + '%';
        star.style.top = (4 + Math.random() * 42) + '%';
        fx.appendChild(star);

        var dx = 200 + Math.random() * 180;
        var dy = dx * 0.42;
        star.animate([
          { opacity: 0, transform: 'translate(0,0) rotate(23deg)' },
          { opacity: 1, offset: 0.15 },
          { opacity: 1, offset: 0.8 },
          { opacity: 0, transform: 'translate(' + dx + 'px,' + dy + 'px) rotate(23deg)' }
        ], { duration: 700 + Math.random() * 500, easing: 'ease-out' })
          .onfinish = function () { star.remove(); };
      });
    }
    window.setTimeout(launchShootingStar, 4000 + Math.random() * 7000);
  }

  window.setTimeout(launchShootingStar, 2500);
})();
