// CardMystic clipboard viewer. A static extension page that shows whatever
// is on the system clipboard as plain text. Rendered on load and re-rendered
// whenever the tab regains focus / visibility, so pressing Alt+Shift+Z while
// the viewer already exists (service worker focuses this tab) surfaces any
// freshly-added card names automatically.
//
// `clipboardRead` in manifest.json lets an extension page call readText()
// without needing a transient user activation, but the document must have
// focus — when it doesn't (e.g. the service worker created the tab while
// another window was focused), we fall back to an explanatory message.
(function () {
  const out = document.getElementById("out");
  const meta = document.getElementById("meta");
  const empty = document.getElementById("empty");
  const errEl = document.getElementById("error");

  function setState({ body = "", emptyHint = false, errorHint = false, lines = 0 }) {
    out.textContent = body;
    out.hidden = !body;
    empty.hidden = !emptyHint;
    errEl.hidden = !errorHint;
    if (emptyHint || errorHint || !body) {
      meta.textContent = "";
    } else {
      meta.textContent = `${lines} line${lines === 1 ? "" : "s"}`;
    }
  }

  function countLines(text) {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean).length;
  }

  async function render() {
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch (_) {
      setState({ errorHint: true });
      return;
    }
    if (!text || !text.trim()) {
      setState({ emptyHint: true });
      return;
    }
    setState({ body: text, lines: countLines(text) });
  }

  // First paint.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render, { once: true });
  } else {
    render();
  }

  // Refresh when the tab becomes active again — covers the service worker
  // bringing the viewer forward on a repeat Alt+Shift+Z, and also normal
  // tab-switching by the user.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") render();
  });
  window.addEventListener("focus", render);
})();
