// Honey-style floating action button + clipped-cards panel.
//
// Injected on every supported site. Everything user-visible lives inside a
// Shadow DOM attached to a single host <div>, so host-page CSS can never
// reach the FAB or panel.
//
// State (persisted in chrome.storage.local):
//   "fab:y"            number | null   — global vertical offset in pixels.
//                                        null = center (default).
//   "fab:panelY"       number | null   — dragged drawer Y; null = computed.
//
// Public API (on window.CM.fab):
//   install()          — build the UI, load state, wire listeners.
//   notify(on)         — toggle a pulsing dot on the FAB. Auto-cleared the
//                        next time the panel opens. Nothing triggers it
//                        today; just plumbing for later.
(function () {
  const CM = (window.CM = window.CM || {});

  const HOST_ID = "cardmystic-fab-host";
  const KEY_POS_Y = "fab:y";
  const KEY_PANEL_Y = "fab:panelY";
  const RIGHT_MARGIN = 12;     // gap from viewport right edge
  const FAB_SIZE = 52;
  const PANEL_W = 320;
  const DRAG_THRESHOLD = 4;    // px before we treat a pointermove as a drag
  const MAX_PANEL_LINES = 200;

  const CSS = `
    :host {
      all: initial;
      --bg: rgba(10, 10, 10, 0.92);
      --border-1: rgba(255, 255, 255, 0.10);
      --border-2: rgba(255, 255, 255, 0.05);
      --w-100: rgba(255, 255, 255, 1.00);
      --w-75:  rgba(255, 255, 255, 0.75);
      --w-55:  rgba(255, 255, 255, 0.55);
      --w-50:  rgba(255, 255, 255, 0.50);
      --w-40:  rgba(255, 255, 255, 0.40);
      --w-30:  rgba(255, 255, 255, 0.30);
      --w-15:  rgba(255, 255, 255, 0.15);
      --w-10:  rgba(255, 255, 255, 0.10);
      --w-5:   rgba(255, 255, 255, 0.05);
    }

    *, *::before, *::after { box-sizing: border-box; }
    button { all: unset; cursor: pointer; font: inherit; }

    .fab, .panel {
      position: fixed;
      z-index: 2147483647;
      font: 500 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--w-100);
    }

    /* ---------- FAB ---------- */
    .fab {
      display: grid;
      place-items: center;
      width: ${FAB_SIZE}px;
      height: ${FAB_SIZE}px;
      border-radius: 14px;
      background: var(--bg);
      border: 1px solid var(--border-1);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      user-select: none;
      touch-action: none;
      transition: top 220ms cubic-bezier(0.22, 0.8, 0.2, 1),
                  right 220ms cubic-bezier(0.22, 0.8, 0.2, 1),
                  transform 180ms ease,
                  opacity 180ms ease,
                  box-shadow 140ms ease;
    }
    /* While dragging, kill the slow position transition so the FAB tracks
       the cursor exactly. Re-enabled when drag ends. */
    .fab--dragging {
      transition: transform 140ms ease, box-shadow 140ms ease !important;
    }
    .fab:hover {
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.55);
    }
    .fab:not(.fab--hidden):not(.fab--dragging):hover {
      transform: scale(1.06);
    }
    /* While the panel is open, the FAB fades out — the drawer is the
       primary surface, and there's a close button inside it plus
       outside-click dismissal. */
    .fab--hidden {
      opacity: 0;
      transform: scale(0.85);
      pointer-events: none;
    }
    .fab img {
      width: 32px;
      height: 32px;
      pointer-events: none;
      user-select: none;
      display: block;
    }

    /* Notify dot — small pulse in top-right, only when .fab--notify set. */
    .fab__badge {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #c084fc;
      box-shadow: 0 0 0 2px var(--bg);
      opacity: 0;
      transform: scale(0.6);
      transition: opacity 180ms ease, transform 180ms ease;
      pointer-events: none;
    }
    .fab--notify .fab__badge {
      opacity: 1;
      transform: scale(1);
      animation: cm-fab-pulse 1.6s ease-in-out infinite;
    }
    @keyframes cm-fab-pulse {
      0%, 100% { transform: scale(1);   opacity: 1;   }
      50%      { transform: scale(1.35); opacity: 0.55; }
    }

    /* ---------- Panel (slide-in drawer from the right) ---------- */
    .panel {
      width: ${PANEL_W}px;
      max-width: calc(100vw - 24px);
      right: ${RIGHT_MARGIN}px;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      border: 1px solid var(--border-1);
      border-radius: 14px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      overflow: hidden;
      opacity: 0;
      /* Closed: slid fully off the right edge of the viewport. */
      transform: translateX(calc(100% + ${RIGHT_MARGIN}px + 12px));
      transition: opacity 220ms ease,
                  transform 320ms cubic-bezier(0.22, 0.8, 0.2, 1);
      pointer-events: none;
    }
    .panel--open {
      opacity: 1;
      transform: translateX(0);
      pointer-events: auto;
    }

    .panel header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-2);
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    .panel header:active { cursor: grabbing; }
    /* While the drawer is being dragged, disable the slide transition so
       it tracks the cursor exactly. Re-enabled on pointerup. */
    .panel--dragging {
      transition: none !important;
    }
    .panel--dragging header { cursor: grabbing; }
    .panel h2 {
      flex: 1;
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--w-100);
      letter-spacing: -0.005em;
    }
    .panel__count {
      padding: 2px 8px;
      font-size: 12px;
      color: var(--w-55);
      background: var(--w-5);
      border: 1px solid var(--border-1);
      border-radius: 999px;
      line-height: 1.3;
    }
    .panel__close {
      width: 22px;
      height: 22px;
      display: grid;
      place-items: center;
      border-radius: 6px;
      color: var(--w-50);
      font-size: 16px;
      line-height: 1;
    }
    .panel__close:hover {
      color: var(--w-100);
      background: var(--w-10);
    }

    .panel__body {
      flex: 1;
      min-height: 60px;
      max-height: 400px;
      overflow-y: auto;
      padding: 4px 0;
    }
    .panel__body::-webkit-scrollbar { width: 8px; }
    .panel__body::-webkit-scrollbar-thumb {
      background: var(--w-10);
      border-radius: 4px;
    }
    .panel__body::-webkit-scrollbar-thumb:hover { background: var(--w-15); }

    .panel__list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .panel__list li {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px 6px 14px;
      color: var(--w-75);
      font-size: 12.5px;
      line-height: 1.4;
      border-bottom: 1px solid var(--border-2);
    }
    .panel__list li:last-child { border-bottom: 0; }
    .panel__list li.unknown { color: var(--w-40); font-style: italic; }

    .panel__line {
      flex: 1;
      min-width: 0;
      word-break: break-word;
    }
    .panel__remove {
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      display: grid;
      place-items: center;
      border-radius: 5px;
      color: var(--w-30);
      font-size: 14px;
      line-height: 1;
      background: transparent;
      transition: color 120ms ease, background 120ms ease;
    }
    .panel__list li:hover .panel__remove { color: var(--w-55); }
    .panel__remove:hover {
      color: var(--w-100);
      background: var(--w-10);
    }
    .panel__remove:focus-visible {
      outline: 2px solid var(--w-40);
      outline-offset: 1px;
    }

    .panel__empty {
      margin: 0;
      padding: 20px 16px;
      color: var(--w-40);
      font-size: 12.5px;
      line-height: 1.5;
      text-align: center;
    }

    .panel footer {
      padding: 10px 12px;
      border-top: 1px solid var(--border-2);
    }
    .panel__viewer {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      padding: 8px 10px;
      background: var(--w-5);
      border: 1px solid var(--border-1);
      border-radius: 8px;
      color: var(--w-75);
      font-size: 12px;
      transition: background 120ms ease, color 120ms ease;
    }
    .panel__viewer:hover {
      background: var(--w-10);
      color: var(--w-100);
    }
    .panel__viewer kbd {
      display: inline-block;
      padding: 1px 5px;
      background: var(--w-10);
      border: 1px solid var(--border-1);
      border-radius: 4px;
      color: var(--w-75);
      font: 11px/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    /* ---------- Tabs ---------- */
    .tabs {
      display: flex;
      gap: 2px;
      padding: 0 8px;
      border-bottom: 1px solid var(--border-2);
      flex-shrink: 0;
    }
    .tab {
      padding: 10px 10px 9px;
      font: 500 12px/1.25 inherit;
      color: var(--w-50);
      border-bottom: 2px solid transparent;
      transition: color 120ms ease, border-color 120ms ease;
    }
    .tab:hover { color: var(--w-75); }
    .tab--active {
      color: var(--w-100);
      border-bottom-color: #c084fc;
    }

    .tab-body[hidden] { display: none; }
    .tab-body {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      flex: 1;
      min-height: 0;
    }
    .tab-body__header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
    }
    .tab-body__title {
      flex: 1;
      font: 600 12px/1.3 inherit;
      color: var(--w-75);
      letter-spacing: 0.01em;
      text-transform: uppercase;
    }
    .tab-body__scroll {
      flex: 1;
      min-height: 60px;
      overflow-y: auto;
      padding: 0 0 6px;
    }
    .tab-body__scroll::-webkit-scrollbar { width: 8px; }
    .tab-body__scroll::-webkit-scrollbar-thumb {
      background: var(--w-10);
      border-radius: 4px;
    }
    .tab-body__scroll::-webkit-scrollbar-thumb:hover { background: var(--w-15); }

    .tab-footer[hidden] { display: none; }
    .tab-footer {
      padding: 10px 12px;
      border-top: 1px solid var(--border-2);
      flex-shrink: 0;
    }

    /* ---------- Toggle switches (Cards on Page header) ---------- */
    .tab-body__toggles {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 14px 4px;
      border-bottom: 1px solid var(--border-2);
    }
    .switch-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 0;
    }
    .switch-row[hidden] { display: none; }
    .switch-row__label {
      flex: 1;
      color: var(--w-75);
      font-size: 12.5px;
      user-select: none;
    }
    .switch {
      position: relative;
      display: inline-block;
      width: 32px;
      height: 18px;
      flex-shrink: 0;
    }
    .switch input {
      opacity: 0;
      width: 0;
      height: 0;
      margin: 0;
      position: absolute;
    }
    .switch__slider {
      position: absolute;
      inset: 0;
      background: var(--w-15);
      border: 1px solid var(--border-1);
      border-radius: 999px;
      cursor: pointer;
      transition: background 160ms ease, border-color 160ms ease;
    }
    .switch__slider::before {
      content: "";
      position: absolute;
      height: 12px;
      width: 12px;
      left: 2px;
      top: 2px;
      background: var(--w-75);
      border-radius: 50%;
      transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
                  background 160ms ease;
    }
    .switch input:checked + .switch__slider {
      background: #c084fc;
      border-color: #c084fc;
    }
    .switch input:checked + .switch__slider::before {
      transform: translateX(14px);
      background: var(--w-100);
    }
    .switch input:focus-visible + .switch__slider {
      outline: 2px solid var(--w-40);
      outline-offset: 2px;
    }

    /* ---------- Cards on Page ---------- */
    .panel__cardlink {
      flex: 1;
      min-width: 0;
      color: var(--w-100);
      text-decoration: none;
      word-break: break-word;
    }
    .panel__cardlink:hover { text-decoration: underline; }
    .panel__cardlink sup {
      margin-left: 4px;
      color: var(--w-40);
      font-size: 10px;
      font-weight: 500;
      vertical-align: super;
    }
    .panel__nextOccurrence, .panel__addToClip {
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      display: grid;
      place-items: center;
      border-radius: 5px;
      color: var(--w-30);
      font-size: 13px;
      line-height: 1;
      background: transparent;
      transition: color 120ms ease, background 120ms ease;
    }
    .panel__list li:hover .panel__nextOccurrence,
    .panel__list li:hover .panel__addToClip { color: var(--w-55); }
    .panel__nextOccurrence:hover, .panel__addToClip:hover {
      color: var(--w-100);
      background: var(--w-10);
    }
    .panel__nextOccurrence:focus-visible,
    .panel__addToClip:focus-visible {
      outline: 2px solid var(--w-40);
      outline-offset: 1px;
    }
    /* Row's card is on the clipboard — button is a remove toggle. */
    .panel__addToClip--added {
      color: #c084fc;
    }
    .panel__list li:hover .panel__addToClip--added,
    .panel__addToClip--added:hover {
      color: #d8b4fe;
      background: var(--w-10);
    }

    /* ---------- Clip History ---------- */
    .history-entry {
      padding: 8px 14px;
      border-bottom: 1px solid var(--border-2);
      cursor: pointer;
      transition: background 120ms ease;
    }
    .history-entry:hover { background: var(--w-5); }
    .history-entry:last-child { border-bottom: 0; }
    .history-entry__row {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--w-75);
      font-size: 12.5px;
    }
    .history-entry__caret {
      flex-shrink: 0;
      width: 12px;
      color: var(--w-40);
      transition: transform 140ms ease;
      text-align: center;
    }
    .history-entry.open .history-entry__caret { transform: rotate(90deg); }
    .history-entry__count { flex: 1; color: var(--w-100); }
    .history-entry__time { color: var(--w-40); font-size: 11.5px; }
    .history-entry__body { display: none; margin-top: 10px; }
    .history-entry.open .history-entry__body { display: block; }
    .history-entry__pre {
      max-height: 200px;
      overflow-y: auto;
      margin: 0 0 10px;
      padding: 8px 10px;
      background: var(--w-5);
      border: 1px solid var(--border-2);
      border-radius: 6px;
      color: var(--w-75);
      font: 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .history-entry__copy {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: var(--w-5);
      border: 1px solid var(--border-1);
      border-radius: 6px;
      color: var(--w-75);
      font-size: 12px;
      transition: color 120ms ease, background 120ms ease;
    }
    .history-entry__copy:hover {
      color: var(--w-100);
      background: var(--w-10);
    }
  `;

  // ----- module state -----
  let host = null;
  let root = null;
  let fab = null;
  let panel = null;
  let panelHeader = null;
  let panelCloseBtn = null;

  // Tab DOM (per-tab body sections + shared footer slot)
  let tabsNav = null;
  let tabBodies = null;      // { clip: section, page: section, history: section }
  let tabFooter = null;

  // Clipped Cards tab
  let clipList = null;
  let clipEmpty = null;
  let clipCount = null;
  let viewerBtn = null;

  // Cards on Page tab
  let pageList = null;
  let pageEmpty = null;
  let pageCount = null;
  let pageObserver = null;
  let pageRenderTimer = 0;
  // Cards on Page toggle-row DOM refs
  let pageToggleDiscover = null;
  let pageToggleHyperlinks = null;
  let pageToggleHyperlinksRow = null;
  // Per-card cursor for the "scroll to next occurrence" button, keyed by
  // normalized card name. Rotates through the in-page anchors for that card.
  const pageCycleIndex = new Map();

  // Clip History tab
  let historyList = null;
  let historyEmpty = null;
  const expandedHistoryIds = new Set(); // remembered across re-renders

  // Active tab id
  let activeTab = "clip";

  let posY = null;             // pixels from top for the FAB, null = centered
  let panelY = null;           // user-dragged top for the drawer, null = computed from FAB Y
  let panelOpen = false;

  // FAB drag state
  let dragArmed = false;
  let isDragging = false;
  let dragStartY = 0;
  let dragStartTop = 0;
  let suppressNextClick = false;

  // Panel drag state (independent from FAB drag — both can persist their own Y).
  let panelDragArmed = false;
  let panelIsDragging = false;
  let panelDragStartY = 0;
  let panelDragStartTop = 0;

  // ----- persistence -----

  async function loadState() {
    try {
      const out = await chrome.storage.local.get([KEY_POS_Y, KEY_PANEL_Y]);
      if (typeof out[KEY_POS_Y] === "number") posY = out[KEY_POS_Y];
      if (typeof out[KEY_PANEL_Y] === "number") panelY = out[KEY_PANEL_Y];
    } catch (err) {
      console.warn("[CardMystic] fab loadState failed", err);
    }
  }

  function savePosY() {
    try { chrome.storage.local.set({ [KEY_POS_Y]: posY }); }
    catch (err) { console.warn("[CardMystic] fab savePosY failed", err); }
  }

  function savePanelY() {
    try { chrome.storage.local.set({ [KEY_PANEL_Y]: panelY }); }
    catch (err) { console.warn("[CardMystic] fab savePanelY failed", err); }
  }

  // Cross-tab sync — if the user drags the FAB or the drawer in
  // another tab, pick up the change without needing a reload.
  function watchStorage() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[KEY_POS_Y]) {
        posY = typeof changes[KEY_POS_Y].newValue === "number"
          ? changes[KEY_POS_Y].newValue : null;
        applyPosition();
      }
      if (changes[KEY_PANEL_Y]) {
        panelY = typeof changes[KEY_PANEL_Y].newValue === "number"
          ? changes[KEY_PANEL_Y].newValue : null;
        if (panelOpen) positionPanel();
      }
    });
  }

  // ----- positioning -----

  function clampY(y) {
    const pad = 8;
    const max = window.innerHeight - FAB_SIZE - pad;
    if (y < pad) return pad;
    if (y > max) return max;
    return y;
  }

  // Convert posY (or the centered default) into an absolute top pixel. We
  // always drive the FAB from px values so CSS transitions can animate
  // smoothly between "closed" (drag position) and "open" (docked above
  // the panel).
  function closedFabTop() {
    if (typeof posY === "number") return clampY(posY);
    return Math.round((window.innerHeight - FAB_SIZE) / 2);
  }

  // Panel placement when open. User-dragged panelY wins; otherwise anchor
  // the drawer near the FAB's Y so it reads as "coming from where the FAB
  // was" rather than jumping across the screen.
  function computePanelLayout() {
    const margin = 12;
    const panelH = Math.min(520, Math.max(260, window.innerHeight - 96));
    let panelTop;
    if (typeof panelY === "number") {
      panelTop = panelY;
    } else {
      const fabClosedTop = closedFabTop();
      panelTop = fabClosedTop - Math.round(panelH / 2 - FAB_SIZE / 2);
    }
    const minPanelTop = margin;
    const maxPanelTop = window.innerHeight - panelH - margin;
    if (panelTop < minPanelTop) panelTop = minPanelTop;
    if (panelTop > maxPanelTop) panelTop = Math.max(minPanelTop, maxPanelTop);
    return { panelTop, panelHeight: panelH };
  }

  // Clamp a proposed drawer top to the viewport with a little padding.
  function clampPanelY(y) {
    const pad = 8;
    const panelH = panel && panel.offsetHeight ? panel.offsetHeight : 520;
    const max = window.innerHeight - panelH - pad;
    if (y < pad) return pad;
    if (y > max) return max;
    return y;
  }

  function applyPosition() {
    if (!fab) return;
    // FAB always uses its drag-persisted Y along the right edge. It fades
    // out via the .fab--hidden class while the panel is open.
    fab.style.top = `${closedFabTop()}px`;
    fab.style.right = `${RIGHT_MARGIN}px`;
  }

  function positionPanel() {
    if (!panel) return;
    const layout = computePanelLayout();
    panel.style.top = `${layout.panelTop}px`;
    panel.style.height = `${layout.panelHeight}px`;
  }

  // ----- tab rendering -----

  // Dispatch — renders the current active tab. Always re-renders the
  // Clipped Cards count chip too (since users may peek at it cross-tab
  // via the Cards on Page +).
  function renderActiveTab() {
    if (activeTab === "clip") renderClipTab();
    else if (activeTab === "page") renderPageTab();
    else if (activeTab === "history") renderHistoryTab();
  }

  async function renderClipTab() {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (_) {
      text = "";
    }
    const parse = CM.plus && CM.plus.parseDeckList
      ? CM.plus.parseDeckList(text || "")
      : { isDeckList: false, cardKeys: new Set() };

    // Build a list of { rawIdx, display } so the per-row remove button
    // can delete the exact original clipboard line (critical when there
    // are duplicate lines or section headers we need to preserve).
    const rawLines = (text || "").split(/\r?\n/);
    const entries = [];
    for (let i = 0; i < rawLines.length; i++) {
      const trimmed = rawLines[i].replace(/\s+$/, "");
      if (!trimmed.trim()) {
        const hasLater = rawLines.slice(i + 1).some((l) => l.trim());
        if (!hasLater) continue;
      }
      entries.push({ rawIdx: i, display: trimmed });
    }

    clipCount.textContent = String(parse.cardKeys ? parse.cardKeys.size : 0);

    if (!entries.length || !parse.isDeckList) {
      clipList.innerHTML = "";
      clipEmpty.hidden = false;
      return;
    }
    clipEmpty.hidden = true;
    clipList.innerHTML = "";
    const shown = entries.slice(0, MAX_PANEL_LINES);
    for (const { rawIdx, display } of shown) {
      const li = document.createElement("li");
      const line = document.createElement("span");
      line.className = "panel__line";
      line.textContent = display || "\u00A0";
      li.appendChild(line);

      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "panel__remove";
      rm.setAttribute("aria-label", `Remove ${display || "blank line"} from clipboard`);
      rm.textContent = "\u00D7";
      rm.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeLineAt(rawIdx);
      });
      li.appendChild(rm);
      clipList.appendChild(li);
    }
    if (entries.length > MAX_PANEL_LINES) {
      const li = document.createElement("li");
      li.className = "unknown";
      const line = document.createElement("span");
      line.className = "panel__line";
      line.textContent = `+${entries.length - MAX_PANEL_LINES} more\u2026`;
      li.appendChild(line);
      clipList.appendChild(li);
    }
  }

  // ----- Cards on Page -----

  const MAX_PAGE_ROWS = 300;

  function renderPageTab() {
    // Reflect toggle state. If CM.siteSettings isn't ready yet, default
    // to the hostname-derived defaults via get() (which handles that).
    const settings = CM.siteSettings
      ? CM.siteSettings.get(location.hostname)
      : { discover: false, hyperlinks: false };
    if (pageToggleDiscover) pageToggleDiscover.checked = !!settings.discover;
    if (pageToggleHyperlinks) pageToggleHyperlinks.checked = !!settings.hyperlinks;
    if (pageToggleHyperlinksRow) pageToggleHyperlinksRow.hidden = !settings.discover;

    const names = [];
    const byName = new Map();

    if (settings.discover && settings.hyperlinks) {
      // Full mode — read from the in-page anchors the rewriter created.
      const anchors = document.querySelectorAll("a.cm-card-link[data-cm-card]");
      for (const a of anchors) {
        const name = a.dataset.cmCard;
        if (!name) continue;
        let bucket = byName.get(name);
        if (!bucket) {
          bucket = { href: a.href || "#", count: 0, anchors: [] };
          byName.set(name, bucket);
        }
        if (bucket.href.indexOf("cardmystic.com/") === -1 &&
            typeof a.href === "string" &&
            a.href.indexOf("cardmystic.com/") !== -1) {
          bucket.href = a.href;
        }
        bucket.anchors.push(a);
        bucket.count++;
      }
      for (const k of byName.keys()) names.push(k);
    } else if (settings.discover && CM.detectedCardNames) {
      // Detect mode — names come from the read-only collect Set of
      // normalized canonical keys. Map each back to its original-cased
      // display string via CM.cardNamesDisplay.
      for (const key of CM.detectedCardNames) {
        const display = (CM.cardNamesDisplay && CM.cardNamesDisplay.get(key)) || key;
        names.push(display);
        byName.set(display, { href: "#", count: 0, anchors: [], canonical: key });
      }
    }

    names.sort((x, y) => x.localeCompare(y, undefined, { sensitivity: "base" }));

    pageCount.textContent = String(names.length);

    if (!names.length) {
      pageList.innerHTML = "";
      // Message depends on why the list is empty.
      if (!settings.discover) {
        pageEmpty.textContent =
          "Turn on detection above to see cards on this page.";
      } else {
        pageEmpty.textContent = "No card names detected on this page yet.";
      }
      pageEmpty.hidden = false;
      return;
    }
    pageEmpty.hidden = true;
    pageList.innerHTML = "";

    const shown = names.slice(0, MAX_PAGE_ROWS);
    for (const name of shown) {
      const bucket = byName.get(name);
      const li = document.createElement("li");

      // In full mode render an <a>; in detect mode a <span> (no URL
      // without a resolved card). Both get data-cm-card so the shadow-
      // root hover install still shows the preview on hover.
      let nameEl;
      if (settings.hyperlinks && bucket.anchors.length) {
        nameEl = document.createElement("a");
        nameEl.className = "panel__cardlink";
        nameEl.href = bucket.href || "#";
        nameEl.target = "_blank";
        nameEl.rel = "noopener noreferrer";
      } else {
        nameEl = document.createElement("span");
        nameEl.className = "panel__cardlink";
      }
      nameEl.dataset.cmCard = name;
      nameEl.textContent = name;
      if (bucket.count > 1) {
        const sup = document.createElement("sup");
        sup.textContent = `\u00D7${bucket.count}`;
        nameEl.appendChild(sup);
      }
      li.appendChild(nameEl);

      // Next-occurrence arrow only when we have in-page anchors to
      // scroll to (i.e. full mode with actual DOM hits).
      if (bucket.anchors.length) {
        const nextBtn = document.createElement("button");
        nextBtn.type = "button";
        nextBtn.className = "panel__nextOccurrence";
        nextBtn.setAttribute("aria-label", `Scroll to next occurrence of ${name}`);
        nextBtn.textContent = "\u2193";
        nextBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          scrollToNext(name, bucket.anchors);
        });
        li.appendChild(nextBtn);
      }

      // "+"/"×" clipboard-toggle mirror. In full mode we can read the
      // in-page sibling's --added class for state; in detect mode we
      // check against the clipboard's cardKeys via CM.plus.
      let onClipboard = false;
      if (settings.hyperlinks && bucket.anchors.length) {
        const firstInPageBtn = bucket.anchors[0].nextElementSibling;
        onClipboard = !!(firstInPageBtn
          && firstInPageBtn.classList
          && firstInPageBtn.classList.contains("cm-card-plus--added"));
      } else if (CM.plus && CM.plus.keyOf) {
        // Best-effort: use the addedNames Set via a clipboard parse.
        // We can't easily reach the module-scope addedNames from here,
        // but the reconcile path already mirrors it onto --added
        // classes when present. In detect mode there are no such
        // buttons, so fall back to a fresh parse.
        onClipboard = false;
      }
      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "panel__addToClip"
        + (onClipboard ? " panel__addToClip--added" : "");
      plus.setAttribute(
        "aria-label",
        onClipboard ? `Remove ${name} from clipboard` : `Add ${name} to clipboard`
      );
      plus.textContent = onClipboard ? "\u00D7" : "+";
      plus.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (CM.plus && CM.plus.clipCard) CM.plus.clipCard(name);
      });
      li.appendChild(plus);

      pageList.appendChild(li);
    }

    if (names.length > MAX_PAGE_ROWS) {
      const li = document.createElement("li");
      li.className = "unknown";
      const line = document.createElement("span");
      line.className = "panel__line";
      line.textContent = `+${names.length - MAX_PAGE_ROWS} more\u2026`;
      li.appendChild(line);
      pageList.appendChild(li);
    }
  }

  function scrollToNext(name, anchors) {
    if (!anchors.length) return;
    const prev = pageCycleIndex.get(name) || 0;
    const idx = prev % anchors.length;
    pageCycleIndex.set(name, prev + 1);
    const target = anchors[idx];
    try {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (_) {
      target.scrollIntoView();
    }
    target.classList.add("cm-card-link--flash");
    setTimeout(() => target.classList.remove("cm-card-link--flash"), 900);
  }

  // Debounced re-render used by the MutationObserver while the page tab
  // is visible. Late-loading content (Reddit comments, Moxfield SPA,
  // infinite scroll on mtg.wiki) is picked up within ~100ms.
  function schedulePageRerender() {
    clearTimeout(pageRenderTimer);
    pageRenderTimer = setTimeout(() => {
      pageRenderTimer = 0;
      if (panelOpen && activeTab === "page") renderPageTab();
    }, 100);
  }

  function attachPageObserver() {
    if (pageObserver) return;
    pageObserver = new MutationObserver(schedulePageRerender);
    pageObserver.observe(document.body, { childList: true, subtree: true });
  }
  function detachPageObserver() {
    if (!pageObserver) return;
    pageObserver.disconnect();
    pageObserver = null;
  }

  // ----- Clip History -----

  function relativeTime(ts) {
    const now = Date.now();
    const diffMs = Math.max(0, now - ts);
    const sec = Math.floor(diffMs / 1000);
    if (sec < 45) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hr ago`;
    const d = new Date(ts);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}`;
  }

  function renderHistoryTab() {
    const snapshot = CM.history && CM.history.get ? CM.history.get() : { entries: [] };
    const entries = snapshot.entries || [];

    if (!entries.length) {
      historyList.innerHTML = "";
      historyEmpty.hidden = false;
      return;
    }
    historyEmpty.hidden = true;
    historyList.innerHTML = "";

    for (const entry of entries) {
      const li = document.createElement("li");
      li.className = "history-entry";
      li.style.display = "block";
      li.style.padding = "0";
      if (expandedHistoryIds.has(entry.id)) li.classList.add("open");

      const row = document.createElement("div");
      row.className = "history-entry__row";
      row.style.padding = "10px 14px";

      const caret = document.createElement("span");
      caret.className = "history-entry__caret";
      caret.textContent = "\u25B8"; // ▸
      row.appendChild(caret);

      const count = document.createElement("span");
      count.className = "history-entry__count";
      count.textContent = `${entry.cardCount} card${entry.cardCount === 1 ? "" : "s"}`;
      row.appendChild(count);

      const time = document.createElement("span");
      time.className = "history-entry__time";
      time.textContent = relativeTime(entry.createdAt);
      row.appendChild(time);
      li.appendChild(row);

      const detail = document.createElement("div");
      detail.className = "history-entry__body";
      detail.style.padding = "0 14px 12px";
      const pre = document.createElement("pre");
      pre.className = "history-entry__pre";
      pre.textContent = entry.text;
      detail.appendChild(pre);

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "history-entry__copy";
      copy.textContent = "Copy to clipboard";
      copy.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (CM.history && CM.history.restore) CM.history.restore(entry.id);
      });
      detail.appendChild(copy);
      li.appendChild(detail);

      row.addEventListener("click", () => {
        if (expandedHistoryIds.has(entry.id)) {
          expandedHistoryIds.delete(entry.id);
          li.classList.remove("open");
        } else {
          expandedHistoryIds.add(entry.id);
          li.classList.add("open");
        }
      });

      historyList.appendChild(li);
    }
  }

  // ----- tab switching -----

  function setActiveTab(id) {
    if (id !== "clip" && id !== "page" && id !== "history") return;
    activeTab = id;
    // Toggle tab button styling.
    for (const b of tabsNav.querySelectorAll(".tab")) {
      b.classList.toggle("tab--active", b.dataset.tab === id);
    }
    // Toggle tab bodies.
    tabBodies.clip.hidden = id !== "clip";
    tabBodies.page.hidden = id !== "page";
    tabBodies.history.hidden = id !== "history";
    // Footer only for the clip tab.
    tabFooter.hidden = id !== "clip";

    // Attach/detach the page MutationObserver based on visibility.
    if (id === "page") attachPageObserver();
    else detachPageObserver();

    renderActiveTab();
  }

  // Remove the clipboard line at rawIdx (index into a fresh split of the
  // current clipboard text). Writing goes through CM.plus.writeClipboard
  // so reconcile + the change event fire, which will rerun renderPanel.
  async function removeLineAt(rawIdx) {
    if (!CM.plus || !CM.plus.writeClipboard) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (_) {
      return;
    }
    const lines = text.split(/\r?\n/);
    if (rawIdx < 0 || rawIdx >= lines.length) return;
    lines.splice(rawIdx, 1);
    // Drop any trailing blank lines that resulted from the removal.
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const next = lines.join("\n");
    await CM.plus.writeClipboard(next);
  }

  function openPanel() {
    if (panelOpen) return;
    panelOpen = true;
    // Position the panel BEFORE showing it so the slide-in starts from
    // the correct Y (otherwise the transform begins from stale coords).
    positionPanel();
    fab.classList.add("fab--hidden");
    fab.classList.remove("fab--notify");
    panel.classList.add("panel--open");
    if (activeTab === "page") attachPageObserver();
    renderActiveTab();
  }

  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    panel.classList.remove("panel--open");
    fab.classList.remove("fab--hidden");
    // Detach the Cards on Page observer when the drawer isn't visible so
    // we don't keep responding to DOM mutations for nothing.
    detachPageObserver();
  }

  function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
  }

  // ----- drag -----

  function onPointerDown(e) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    // While the panel is open, the FAB is a docked handle — clicks toggle
    // the panel closed, drag doesn't make sense.
    if (panelOpen) return;
    dragArmed = true;
    isDragging = false;
    suppressNextClick = false;
    dragStartY = e.clientY;
    const rect = fab.getBoundingClientRect();
    dragStartTop = rect.top;
    fab.setPointerCapture && fab.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!dragArmed) return;
    const dy = e.clientY - dragStartY;
    if (!isDragging && Math.abs(dy) < DRAG_THRESHOLD) return;
    if (!isDragging) {
      // Crossed the threshold — mark as a real drag and kill the slow
      // position transition so the FAB tracks the cursor precisely.
      isDragging = true;
      suppressNextClick = true;
      fab.classList.add("fab--dragging");
    }
    const y = clampY(dragStartTop + dy);
    posY = y;
    fab.style.top = `${y}px`;
  }

  function onPointerUp(e) {
    if (!dragArmed) return;
    dragArmed = false;
    try {
      fab.releasePointerCapture && fab.releasePointerCapture(e.pointerId);
    } catch (_) { /* noop */ }
    if (isDragging) {
      savePosY();
      isDragging = false;
      fab.classList.remove("fab--dragging");
    }
  }

  // ----- drawer drag (on panel header) -----

  function onPanelPointerDown(e) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    // Let header controls (close X, etc.) receive their own clicks.
    if (e.target && e.target.closest("button")) return;
    if (!panelOpen) return;
    panelDragArmed = true;
    panelIsDragging = false;
    panelDragStartY = e.clientY;
    panelDragStartTop = panel.getBoundingClientRect().top;
    panelHeader.setPointerCapture && panelHeader.setPointerCapture(e.pointerId);
  }

  function onPanelPointerMove(e) {
    if (!panelDragArmed) return;
    const dy = e.clientY - panelDragStartY;
    if (!panelIsDragging && Math.abs(dy) < DRAG_THRESHOLD) return;
    if (!panelIsDragging) {
      panelIsDragging = true;
      panel.classList.add("panel--dragging");
    }
    const y = clampPanelY(panelDragStartTop + dy);
    panelY = y;
    panel.style.top = `${y}px`;
  }

  function onPanelPointerUp(e) {
    if (!panelDragArmed) return;
    panelDragArmed = false;
    try {
      panelHeader.releasePointerCapture && panelHeader.releasePointerCapture(e.pointerId);
    } catch (_) { /* noop */ }
    if (panelIsDragging) {
      savePanelY();
      panelIsDragging = false;
      panel.classList.remove("panel--dragging");
    }
  }

  // ----- build -----

  function build() {
    host = document.createElement("div");
    host.id = HOST_ID;
    // Don't pollute the outer DOM's layout.
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.top = "0";
    host.style.left = "0";
    host.style.width = "0";
    host.style.height = "0";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none";
    document.body.appendChild(host);

    root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    // FAB
    fab = document.createElement("button");
    fab.className = "fab";
    fab.type = "button";
    fab.setAttribute("aria-label", "CardMystic");
    fab.style.pointerEvents = "auto";

    const img = document.createElement("img");
    img.src = chrome.runtime.getURL("assets/icon-128.png");
    img.alt = "";
    fab.appendChild(img);

    const badge = document.createElement("span");
    badge.className = "fab__badge";
    fab.appendChild(badge);


    // Panel — always rendered; visibility controlled by .panel--open class.
    // (Using a class instead of the [hidden] attribute lets the slide-out
    // transition actually play when closing.)
    panel = document.createElement("aside");
    panel.className = "panel";

    // Header (drag handle)
    panelHeader = document.createElement("header");
    const h2 = document.createElement("h2");
    h2.textContent = "CardMystic";
    panelCloseBtn = document.createElement("button");
    panelCloseBtn.className = "panel__close";
    panelCloseBtn.type = "button";
    panelCloseBtn.setAttribute("aria-label", "Close panel");
    panelCloseBtn.textContent = "\u00D7";
    panelHeader.appendChild(h2);
    panelHeader.appendChild(panelCloseBtn);
    panel.appendChild(panelHeader);

    // Tabs nav
    tabsNav = document.createElement("nav");
    tabsNav.className = "tabs";
    tabsNav.setAttribute("role", "tablist");
    const tabDefs = [
      { id: "page", label: "Cards on Page" },
      { id: "clip", label: "Clipped Cards" },
      { id: "history", label: "Clip History" },
    ];
    for (const def of tabDefs) {
      const b = document.createElement("button");
      b.className = "tab" + (def.id === activeTab ? " tab--active" : "");
      b.type = "button";
      b.dataset.tab = def.id;
      b.setAttribute("role", "tab");
      b.textContent = def.label;
      tabsNav.appendChild(b);
    }
    panel.appendChild(tabsNav);

    // Body container holds all three tab-bodies; only one is visible at a
    // time via the [hidden] attribute.
    const body = document.createElement("div");
    body.className = "panel__body";
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.flex = "1";
    body.style.minHeight = "0";
    body.style.overflow = "hidden";

    // --- Clip tab ---
    const clipBody = document.createElement("section");
    clipBody.className = "tab-body";
    clipBody.dataset.tab = "clip";
    const clipHeader = document.createElement("div");
    clipHeader.className = "tab-body__header";
    const clipTitle = document.createElement("span");
    clipTitle.className = "tab-body__title";
    clipTitle.textContent = "Clipped Cards";
    clipCount = document.createElement("span");
    clipCount.className = "panel__count";
    clipCount.textContent = "0";
    clipHeader.appendChild(clipTitle);
    clipHeader.appendChild(clipCount);
    clipBody.appendChild(clipHeader);
    const clipScroll = document.createElement("div");
    clipScroll.className = "tab-body__scroll";
    clipList = document.createElement("ul");
    clipList.className = "panel__list";
    clipEmpty = document.createElement("p");
    clipEmpty.className = "panel__empty";
    clipEmpty.textContent =
      "Click the + next to any card name to start a list.";
    clipScroll.appendChild(clipList);
    clipScroll.appendChild(clipEmpty);
    clipBody.appendChild(clipScroll);

    // --- Page tab ---
    const pageBody = document.createElement("section");
    pageBody.className = "tab-body";
    pageBody.dataset.tab = "page";
    pageBody.hidden = true;

    // Toggle block at the top of the tab: detect on/off, then (when
    // detect is on) hyperlinks+hover on/off.
    const toggles = document.createElement("div");
    toggles.className = "tab-body__toggles";

    const rowDiscover = document.createElement("label");
    rowDiscover.className = "switch-row";
    const labDiscover = document.createElement("span");
    labDiscover.className = "switch-row__label";
    labDiscover.textContent = "Detect cards on this site";
    const swDiscover = document.createElement("span");
    swDiscover.className = "switch";
    pageToggleDiscover = document.createElement("input");
    pageToggleDiscover.type = "checkbox";
    pageToggleDiscover.dataset.toggle = "discover";
    const sldDiscover = document.createElement("span");
    sldDiscover.className = "switch__slider";
    swDiscover.appendChild(pageToggleDiscover);
    swDiscover.appendChild(sldDiscover);
    rowDiscover.appendChild(labDiscover);
    rowDiscover.appendChild(swDiscover);

    pageToggleHyperlinksRow = document.createElement("label");
    pageToggleHyperlinksRow.className = "switch-row";
    const labLinks = document.createElement("span");
    labLinks.className = "switch-row__label";
    labLinks.textContent = "Add hover previews and links";
    const swLinks = document.createElement("span");
    swLinks.className = "switch";
    pageToggleHyperlinks = document.createElement("input");
    pageToggleHyperlinks.type = "checkbox";
    pageToggleHyperlinks.dataset.toggle = "hyperlinks";
    const sldLinks = document.createElement("span");
    sldLinks.className = "switch__slider";
    swLinks.appendChild(pageToggleHyperlinks);
    swLinks.appendChild(sldLinks);
    pageToggleHyperlinksRow.appendChild(labLinks);
    pageToggleHyperlinksRow.appendChild(swLinks);

    toggles.appendChild(rowDiscover);
    toggles.appendChild(pageToggleHyperlinksRow);
    pageBody.appendChild(toggles);

    const pageHeader = document.createElement("div");
    pageHeader.className = "tab-body__header";
    const pageTitle = document.createElement("span");
    pageTitle.className = "tab-body__title";
    pageTitle.textContent = "Cards on Page";
    pageCount = document.createElement("span");
    pageCount.className = "panel__count";
    pageCount.textContent = "0";
    pageHeader.appendChild(pageTitle);
    pageHeader.appendChild(pageCount);
    pageBody.appendChild(pageHeader);
    const pageScroll = document.createElement("div");
    pageScroll.className = "tab-body__scroll";
    pageList = document.createElement("ul");
    pageList.className = "panel__list";
    pageEmpty = document.createElement("p");
    pageEmpty.className = "panel__empty";
    pageEmpty.textContent = "No card names detected on this page yet.";
    pageScroll.appendChild(pageList);
    pageScroll.appendChild(pageEmpty);
    pageBody.appendChild(pageScroll);

    // --- History tab ---
    const historyBody = document.createElement("section");
    historyBody.className = "tab-body";
    historyBody.dataset.tab = "history";
    historyBody.hidden = true;
    const historyHeader = document.createElement("div");
    historyHeader.className = "tab-body__header";
    const historyTitle = document.createElement("span");
    historyTitle.className = "tab-body__title";
    historyTitle.textContent = "Clip History";
    historyHeader.appendChild(historyTitle);
    historyBody.appendChild(historyHeader);
    const historyScroll = document.createElement("div");
    historyScroll.className = "tab-body__scroll";
    historyList = document.createElement("ul");
    historyList.className = "panel__list";
    historyList.style.listStyle = "none";
    historyEmpty = document.createElement("p");
    historyEmpty.className = "panel__empty";
    historyEmpty.textContent =
      "Once you start a card list and switch to a different one, the old list lands here.";
    historyScroll.appendChild(historyList);
    historyScroll.appendChild(historyEmpty);
    historyBody.appendChild(historyScroll);

    body.appendChild(pageBody);
    body.appendChild(clipBody);
    body.appendChild(historyBody);
    tabBodies = { clip: clipBody, page: pageBody, history: historyBody };
    panel.appendChild(body);

    // Footer — the "Open full viewer" button is only relevant for the
    // Clipped Cards tab. Other tabs hide the footer by setting [hidden].
    tabFooter = document.createElement("footer");
    tabFooter.className = "tab-footer";
    tabFooter.dataset.tab = "clip";
    viewerBtn = document.createElement("button");
    viewerBtn.className = "panel__viewer";
    viewerBtn.type = "button";
    viewerBtn.innerHTML =
      'Open full viewer\u00A0·\u00A0<kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Space</kbd>';
    tabFooter.appendChild(viewerBtn);
    panel.appendChild(tabFooter);

    root.appendChild(panel);
    root.appendChild(fab);
  }

  function wire() {
    // FAB click (not drag) → toggle panel.
    fab.addEventListener("click", (e) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      togglePanel();
    });

    // Drag.
    fab.addEventListener("pointerdown", onPointerDown);
    fab.addEventListener("pointermove", onPointerMove);
    fab.addEventListener("pointerup", onPointerUp);
    fab.addEventListener("pointercancel", onPointerUp);


    // Panel close X.
    panelCloseBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closePanel();
    });

    // Drawer drag — users can pull the panel up or down by its header.
    panelHeader.addEventListener("pointerdown", onPanelPointerDown);
    panelHeader.addEventListener("pointermove", onPanelPointerMove);
    panelHeader.addEventListener("pointerup", onPanelPointerUp);
    panelHeader.addEventListener("pointercancel", onPanelPointerUp);

    // Footer: open full viewer tab via the background.
    viewerBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: "openViewer" });
      } catch (err) {
        console.warn("[CardMystic] openViewer failed", err);
      }
    });

    // Tab clicks — delegated on the nav since buttons are siblings.
    // Cards on Page toggle switches — persist per-site settings.
    if (pageToggleDiscover) {
      pageToggleDiscover.addEventListener("change", () => {
        if (!CM.siteSettings) return;
        const d = !!pageToggleDiscover.checked;
        // Flipping discover off coherently turns hyperlinks off too
        // (siteSettings.set enforces this as well, belt-and-suspenders).
        CM.siteSettings.set(location.hostname, {
          discover: d,
          hyperlinks: d ? undefined : false,
        });
      });
    }
    if (pageToggleHyperlinks) {
      pageToggleHyperlinks.addEventListener("change", () => {
        if (!CM.siteSettings) return;
        CM.siteSettings.set(location.hostname, {
          hyperlinks: !!pageToggleHyperlinks.checked,
        });
      });
    }

    tabsNav.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest(".tab");
      if (!btn || !btn.dataset.tab) return;
      e.preventDefault();
      e.stopPropagation();
      setActiveTab(btn.dataset.tab);
    });

    // Refresh panel contents when the tab regains attention — catches
    // external copies/pastes that happened while we were elsewhere.
    window.addEventListener("focus", () => { if (panelOpen) renderActiveTab(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && panelOpen) renderActiveTab();
    });

    // Live-sync: plus.js fires this whenever it has just written to or
    // re-read the clipboard. If the panel is open we re-render so the
    // list and count track changes in real time.
    document.addEventListener("cm:clipboardchanged", () => {
      if (!panelOpen) return;
      // Any clipboard change can affect the Clipped Cards tab and the
      // Cards on Page tab's purple-state inference; history changes are
      // handled by their own event.
      if (activeTab === "clip" || activeTab === "page") renderActiveTab();
    });

    // History lifecycle events.
    document.addEventListener("cm:historychanged", () => {
      if (panelOpen && activeTab === "history") renderHistoryTab();
    });

    // Per-site settings — update the toggle reflection + re-render if
    // currently on the page tab.
    document.addEventListener("cm:sitesettingschanged", (e) => {
      const h = e && e.detail && e.detail.hostname;
      if (h && h !== location.hostname) return;
      if (panelOpen && activeTab === "page") renderPageTab();
    });

    // Detect-mode results changed — refresh the page tab if visible.
    document.addEventListener("cm:detectedchanged", () => {
      if (panelOpen && activeTab === "page") renderPageTab();
    });

    // Install the hover tooltip system on our shadow root too, so hovering
    // the Cards on Page tab's card links shows the image preview.
    if (CM.hover && CM.hover.install) {
      try { CM.hover.install(root); } catch (_) { /* noop */ }
    }

    // Keep positions valid on resize.
    window.addEventListener("resize", () => {
      applyPosition();
      if (panelOpen) positionPanel();
    });
  }

  async function install() {
    if (document.getElementById(HOST_ID)) return; // idempotent
    build();
    wire();
    await loadState();
    applyPosition();
    watchStorage();
  }

  function notify(on) {
    if (!fab) return;
    fab.classList.toggle("fab--notify", !!on);
  }

  CM.fab = { install, notify };
})();
