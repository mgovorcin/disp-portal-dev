// OPERA DISP Portal branding: replaces GeoLibre's header icon + name with an OPERA brand block
// ("OPERA DISP Portal" / "built on GeoLibre"). Injected by scripts/build_geolibre.sh; re-applied when
// React re-renders the header.
(function () {
  var TITLE = "OPERA DISP Portal";
  // Site base (the build injects this script as <base>branding/branding.js).
  var SCRIPT = (document.currentScript && document.currentScript.src) || location.href;
  var BASE = SCRIPT.replace(/branding\/branding\.js.*$/, "");
  var OPERA_URL = "https://www.jpl.nasa.gov/go/opera/";
  var GEOLIBRE_URL = "https://github.com/opengeos/GeoLibre";

  function brandBlock() {
    var a = document.createElement("span");
    a.className = "opera-brand";
    a.innerHTML =
      '<a class="opera-brand-mark" href="' + OPERA_URL + '" target="_blank" rel="noopener" ' +
      'title="OPERA: Observational Products for End-Users from Remote Sensing Analysis">' +
      '<img src="' + BASE + 'branding/opera-emblem.png" alt="OPERA" /></a>' +
      '<span class="opera-brand-text">' +
      '<span class="opera-brand-title">' + TITLE + "</span>" +
      '<span class="opera-brand-sub">built on <a href="' + GEOLIBRE_URL + '" target="_blank" rel="noopener">GeoLibre</a></span>' +
      "</span>";
    return a;
  }

  function apply() {
    var header = document.querySelector("header");
    if (!header) return;
    var host = header.firstElementChild;
    if (!host || host.querySelector(".opera-brand")) return;
    host.classList.add("opera-brand-host");
    host.prepend(brandBlock());
  }

  document.title = TITLE;
  document.querySelectorAll('link[rel~="icon"]').forEach(function (l) { l.remove(); });
  var icon = document.createElement("link");
  icon.rel = "icon";
  icon.href = BASE + "branding/opera-favicon.png";
  document.head.appendChild(icon);
  new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
  apply();
})();
