// Hover preview. A single fixed-position <img> follows the cursor while the
// user is hovering a [data-cm-card] link. The tooltip is image-only — no
// label, no chrome.
(function () {
  const CM = (window.CM = window.CM || {});

  const SHOW_DELAY = 120;
  const HIDE_DELAY = 60;
  const OFFSET_X = 18;
  const OFFSET_Y = 18;

  let tip = null;
  let showTimer = null;
  let hideTimer = null;
  let currentTarget = null;
  let lastX = 0;
  let lastY = 0;

  function ensureTip() {
    if (tip) return;
    tip = document.createElement("img");
    tip.className = "cm-hover-tooltip";
    tip.alt = "";
    tip.hidden = true;
    document.body.appendChild(tip);
  }

  function positionAtCursor() {
    if (!tip || tip.hidden) return;
    const tw = tip.offsetWidth || 244;
    const th = tip.offsetHeight || 340;
    const margin = 8;

    let left = lastX + OFFSET_X;
    let top = lastY + OFFSET_Y;

    // Flip to the other side if we'd overflow the viewport.
    if (left + tw + margin > window.innerWidth) {
      left = lastX - tw - OFFSET_X;
    }
    if (top + th + margin > window.innerHeight) {
      top = lastY - th - OFFSET_Y;
    }
    if (left < margin) left = margin;
    if (top < margin) top = margin;

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function show(target) {
    ensureTip();
    currentTarget = target;
    const name = target.dataset.cmCard;
    if (!name) return;

    tip.removeAttribute("src");
    tip.hidden = false;
    positionAtCursor();

    chrome.runtime.sendMessage({ type: "getCard", name }, (resp) => {
      if (currentTarget !== target || tip.hidden) return;
      if (!resp || !resp.ok || !resp.data || resp.data.notFound) {
        hide();
        return;
      }
      const data = resp.data;
      const img = data.image || (data.faces && data.faces[0] && data.faces[0].image);
      if (img) {
        tip.onload = positionAtCursor;
        tip.src = img;
      } else {
        hide();
      }
    });
  }

  function hide() {
    if (!tip) return;
    tip.hidden = true;
    tip.removeAttribute("src");
    currentTarget = null;
  }

  // Two elements "belong to the same card" if both carry data-cm-card with
  // the same value. Used so that hovering from an `a.cm-card-link` to its
  // adjacent `.cm-card-plus` (both siblings, both tagged with the same card
  // name) doesn't flicker the tooltip off and on.
  function sameCard(a, b) {
    if (!a || !b) return false;
    const an = a.dataset && a.dataset.cmCard;
    const bn = b.dataset && b.dataset.cmCard;
    return !!an && an === bn;
  }

  function onOver(e) {
    const target = e.target.closest && e.target.closest("[data-cm-card]");
    if (!target) return;
    lastX = e.clientX;
    lastY = e.clientY;
    clearTimeout(hideTimer);
    // If we're moving between two elements of the same card (anchor ↔ "+"),
    // just update currentTarget in place — no re-fetch, no re-flash.
    if (currentTarget && sameCard(currentTarget, target) && tip && !tip.hidden) {
      currentTarget = target;
      positionAtCursor();
      return;
    }
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(target), SHOW_DELAY);
  }

  function onMove(e) {
    const target = e.target.closest && e.target.closest("[data-cm-card]");
    if (!target) return;
    lastX = e.clientX;
    lastY = e.clientY;
    if (currentTarget && sameCard(currentTarget, target) && tip && !tip.hidden) {
      positionAtCursor();
    }
  }

  function onOut(e) {
    const target = e.target.closest && e.target.closest("[data-cm-card]");
    if (!target) return;
    // Cursor is moving inside the same element — ignore.
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;
    // Cursor is moving to a sibling that belongs to the same card (anchor
    // ↔ "+" jump). Hold the tooltip open; the onOver handler on the new
    // element will take over as currentTarget.
    const nextCard =
      e.relatedTarget && e.relatedTarget.closest
        ? e.relatedTarget.closest("[data-cm-card]")
        : null;
    if (nextCard && sameCard(target, nextCard)) return;
    clearTimeout(showTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY);
  }

  function install() {
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseout", onOut, true);
  }

  CM.hover = { install };
})();
