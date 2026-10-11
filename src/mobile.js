// Phones: the top section (mode switch, title, tiles, tabs, search) slides away while scrolling down
// and comes back as soon as you scroll up. Styles are in src/mobile.css (html.rd-bar-hidden).
(() => {
  const phone = matchMedia("(max-width:600px)");
  const root = document.documentElement;
  let lastY = scrollY, ticking = false;
  // Distance to slide: the mode switch plus whichever header is showing, so both leave the screen together.
  function measure(){
    const modes = document.querySelector(".modes");
    const head = [...document.querySelectorAll("header.top")].find(h => h.offsetParent);
    const mh = modes ? modes.offsetHeight : 0;
    root.style.setProperty("--rd-modes-h", mh + "px");
    root.style.setProperty("--rd-bar-h", mh + (head ? head.offsetHeight : 0) + "px");
  }
  function onScroll(){
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = Math.max(0, scrollY), dy = y - lastY;
      if (!phone.matches || y < 60) root.classList.remove("rd-bar-hidden");
      else if (dy > 6){ if (!root.classList.contains("rd-bar-hidden")){ measure(); root.classList.add("rd-bar-hidden"); } }
      else if (dy < -6) root.classList.remove("rd-bar-hidden");
      if (Math.abs(dy) > 6 || y < 60) lastY = y;
    });
  }
  addEventListener("scroll", onScroll, {passive: true});
  addEventListener("resize", measure);
  // Switching tabs or modes changes which header shows and how tall it is.
  document.addEventListener("click", e => e.target.closest?.("[role=tab],.tile") && setTimeout(() => { measure(); root.classList.remove("rd-bar-hidden"); }, 0));
  measure(); setTimeout(measure, 1500);
})();
