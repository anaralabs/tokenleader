/**
 * Legacy server-rendered dashboard: a single self-contained page (vanilla
 * JS, inline CSS) served at / when web/dist isn't built. Polls /stats/admin
 * every 5s; that route is gated by the optional dashboard token (main.ts).
 */
export function renderAdminHtml(serverUrl: string): string {
  const baseUrl = serverUrl.replace(/\/+$/, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=1280" />
<title>tokenleader</title>
<!-- /brand/favicon.svg rather than an inlined data: URI, so this page shows
     the same mark as the Vite dashboard and honours an operator's
     <data-dir>/brand/favicon.svg override. The route is never auth-gated. -->
<link rel="icon" type="image/svg+xml" href="/brand/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap">
<style>
  /* =====================================================================
     DESIGN TOKENS — light is the canonical mode; .theme-dark swaps.
     ===================================================================== */
  :root {
    /* Surfaces (HSL space-separated for use via hsl(var(--x))) */
    --background-primary: 0 0% 100%;
    --background-app:     60 1% 98%;
    --background-object:  0 0% 100%;
    --background-inverse: 0 0% 9%;
    --hover-app:          0 0% 90%;
    --active-app:         0 0% 88%;
    --hover-object:       0 0% 96%;
    --active-object:      0 0% 93%;
    /* Text */
    --text-primary:     0 0% 6%;
    --text-secondary:   0 0% 40%;
    --text-tertiary:    0 0% 54%;
    --text-muted:       0 0% 74%;
    --text-inverse:     0 0% 97%;
    --text-destructive: 349 100% 42%;
    /* Borders + controls */
    --border-primary:   0 0% 86%;
    --border-muted:     0 0% 95%;
    --control-primary:  0 0% 92%;
    --control-background: 0 0% 86%;
    --control-destructive: 342 98% 94%;
    /* Accent (iOS palette) */
    --accent-blue:    209 100% 50%; /* #007AFF */
    --accent-green:   135 59% 49%;  /* #34C759 */
    --accent-orange:  32 100% 50%;  /* #FF9500 */
    --ring:           209 83% 65%;
    /* Geometry */
    --radius:        0.5rem;
    --radius-card:   0.75rem;  /* rounded-xl */
    --radius-tile:   1rem;     /* rounded-2xl */
    /* Mono font for numeric / identifier display; system fallbacks cover
       a failed Google Fonts load. */
    --font-mono: "Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular,
                 "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    /* Shadows (feint/low/medium/high — used very sparingly) */
    --shadow-feint: 0 1px 2px rgba(0,0,0,0.04), 0 2px 6px rgba(0,0,0,0.06);
    --shadow-low:   0 1px 2px rgba(0,0,0,0.02), 0 2px 6px rgba(0,0,0,0.03);
    /* Contribution-grid ramp. Full hsl() values (not bare components):
       consumed directly via fill="var(--cg-N)". */
    --cg-0: hsl(0 0% 94%);
    --cg-1: hsl(0 0% 80%);
    --cg-2: hsl(0 0% 62%);
    --cg-3: hsl(0 0% 36%);
    --cg-4: hsl(0 0% 10%);
  }

  /* Light is the unconditional default — no prefers-color-scheme switch.
     The :root.theme-dark class (set by pressing D and persisted in
     localStorage) is the only way the dashboard goes dark. */
  :root.theme-light {
    --background-primary: 0 0% 100%;
    --background-app:     60 1% 98%;
    --background-object:  0 0% 100%;
    --background-inverse: 0 0% 9%;
    --hover-app:          0 0% 90%;
    --active-app:         0 0% 88%;
    --hover-object:       0 0% 96%;
    --active-object:      0 0% 93%;
    --text-primary:       0 0% 6%;
    --text-secondary:     0 0% 40%;
    --text-tertiary:      0 0% 54%;
    --text-muted:         0 0% 74%;
    --text-inverse:       0 0% 97%;
    --text-destructive:   349 100% 42%;
    --border-primary:     0 0% 86%;
    --border-muted:       0 0% 95%;
    --control-primary:    0 0% 92%;
    --control-background: 0 0% 86%;
    --control-destructive: 342 98% 94%;
    --ring:               209 83% 65%;
    --cg-0: hsl(0 0% 94%);
    --cg-1: hsl(0 0% 80%);
    --cg-2: hsl(0 0% 62%);
    --cg-3: hsl(0 0% 36%);
    --cg-4: hsl(0 0% 10%);
  }
  :root.theme-dark {
    --background-primary: 0 0% 9%;
    --background-app:     0 0% 7%;
    --background-object:  0 0% 12%;
    --background-inverse: 0 0% 97%;
    --hover-app:          0 0% 10%;
    --active-app:         0 0% 16%;
    --hover-object:       0 0% 15%;
    --active-object:      0 0% 17%;
    --text-primary:       0 0% 97%;
    --text-secondary:     0 0% 48%;
    --text-tertiary:      0 0% 56%;
    --text-muted:         0 0% 28%;
    --text-inverse:       0 0% 6%;
    --text-destructive:   349 100% 59%;
    --border-primary:     0 0% 15%;
    --border-muted:       0 0% 13%;
    --control-primary:    0 0% 12%;
    --control-background: 0 0% 15%;
    --control-destructive: 342 98% 16%;
    --ring:               212 65% 45%;
    --cg-0: hsl(0 0% 13%);
    --cg-1: hsl(0 0% 22%);
    --cg-2: hsl(0 0% 35%);
    --cg-3: hsl(0 0% 55%);
    --cg-4: hsl(0 0% 80%);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  html, body {
    background: hsl(var(--background-app));
    color: hsl(var(--text-primary));
    font-family: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI",
                 system-ui, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.5;
    letter-spacing: -0.01em;
    font-feature-settings: "ss01" 1, "ss02" 1, "ss03" 1, "cv01" 1, "cv11" 1;
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  body { min-height: 100vh; }
  ::selection { background: hsl(var(--accent-blue) / 0.18); }

  /* Mono utility for stat numbers, numeric cells, and the wordmark;
     tabular-nums covers the fallback fonts. */
  .mono,
  .stat .num,
  td.num,
  .lb-table td.user-cell,
  header .brand,
  header .poll {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum" 1, "zero" 1;
  }

  .muted   { color: hsl(var(--text-secondary)); }
  .muted-2 { color: hsl(var(--text-tertiary)); }
  .label {
    font-size: 10px; letter-spacing: 0.08em;
    text-transform: uppercase; color: hsl(var(--text-tertiary));
    font-weight: 500;
  }

  /* Health dot — small, calm, no shadow. iOS green for "ok". */
  .dot {
    display: inline-block; width: 6px; height: 6px; border-radius: 50%;
    background: hsl(var(--accent-green));
    vertical-align: middle; margin-right: 6px; margin-bottom: 1px;
  }
  .dot.bad { background: hsl(var(--text-destructive)); }

  /* =====================================================================
     HEADER — same 1280px max-width as the body so the rows align.
     ===================================================================== */
  header {
    max-width: 1280px;
    margin: 0 auto;
    padding: 16px 32px 14px;
    display: flex; align-items: center; gap: 14px;
  }
  header .brand {
    font-weight: 600;
    font-size: 14px;
    color: hsl(var(--text-primary));
    letter-spacing: -0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  header .brand-logo {
    /* 2:1 box — #icon-mark's viewBox is the wide asterisk pair, not a square. */
    width: 32px; height: 16px;
    display: block;
    fill: currentColor;
    color: hsl(var(--text-primary));
  }
  header .team  { color: hsl(var(--text-tertiary)); font-size: 13px; }
  header .spacer { flex: 1; }
  header .poll {
    color: hsl(var(--text-secondary));
    font-size: 12px;
  }

  /* =====================================================================
     LAYOUT
     ===================================================================== */
  .wrap { padding: 0 32px 48px; max-width: 1280px; margin: 0 auto; }
  /* Date-range bar — sits directly under the header (no page title), at
     the same 1280px max-width as the content. */
  .page-controls {
    max-width: 1280px;
    margin: 0 auto;
    padding: 22px 32px 18px;
    display: flex; align-items: center;
    gap: 14px;
  }
  /* Loading badge — sits next to the date pills, fades in only after
     ~250ms so cached fast responses don't flicker. No animation. */
  .loading-badge {
    font-size: 12px;
    color: hsl(var(--text-tertiary));
    font-weight: 500;
    letter-spacing: -0.005em;
    opacity: 0;
    transition: opacity 0.18s ease;
    min-width: 56px;
  }
  .loading-badge.on { opacity: 1; }

  /* Keyboard-shortcut hint chip (right-aligned). The <kbd> looks like a
     pressed mac key — single-character, mono font, small bevel. */
  .kbd-hint {
    margin-left: auto;
    font-size: 12px;
    color: hsl(var(--text-tertiary));
    font-weight: 500;
    display: inline-flex; align-items: center; gap: 6px;
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    color: hsl(var(--text-secondary));
    background: hsl(var(--background-object));
    border: 1px solid hsl(var(--border-primary));
    border-bottom-width: 2px;
    border-radius: 4px;
    padding: 2px 5px;
    min-width: 18px; text-align: center;
    display: inline-block;
  }
  section { margin-top: 20px; }

  /* =====================================================================
     CONTRIBUTIONS GRID — full-year GitHub-style calendar. Always everyone,
     always YTD; the date pills deliberately don't apply.
     ===================================================================== */
  .contribution-grid {
    background: transparent;
    padding: 0;
    overflow-x: auto;
  }
  .contribution-grid .cg-inner { display: inline-block; min-width: 100%; }
  .contribution-grid svg { display: block; shape-rendering: geometricPrecision; }
  .contribution-grid .cg-cell {
    transition: opacity 0.12s ease-in-out;
    rx: 2; ry: 2;
  }
  .contribution-grid .cg-cell:hover { opacity: 0.7; }
  .contribution-grid .cg-month { font-size: 11px; fill: hsl(var(--text-tertiary)); font-weight: 500; }
  .contribution-grid .cg-dow   { font-size: 10px; fill: hsl(var(--text-tertiary)); }
  .cg-tooltip {
    position: fixed; z-index: 1000; pointer-events: none;
    background: hsl(var(--background-inverse));
    color: hsl(var(--text-inverse));
    padding: 6px 10px; font-size: 12px; line-height: 1.4;
    white-space: nowrap; border-radius: 6px;
    box-shadow: var(--shadow-feint);
    font-weight: 500;
  }
  .cg-tooltip .cg-tt-date { font-weight: 600; margin-bottom: 2px; }
  .cg-tooltip.cg-hidden { display: none; }

  /* =====================================================================
     STATS STRIP — bordered card tiles.
     ===================================================================== */
  .strip {
    display: grid; grid-template-columns: repeat(5, 1fr);
    gap: 12px;
  }
  .stat {
    background: hsl(var(--background-object));
    border: 1px solid hsl(var(--border-muted));
    border-radius: var(--radius-card);
    padding: 18px 20px;
  }
  .stat .lbl {
    font-size: 11px; letter-spacing: 0.04em;
    text-transform: uppercase; font-weight: 500;
    color: hsl(var(--text-tertiary));
  }
  .stat .lbl .icon {
    width: 13px; height: 13px;
    color: hsl(var(--text-muted));
  }
  .stat .num {
    margin-top: 12px;
    font-size: 30px; font-weight: 600;
    line-height: 1.1;
    letter-spacing: -0.02em;
    color: hsl(var(--text-primary));
  }
  .stat .sub {
    margin-top: 6px;
    font-size: 12px; font-weight: 400;
    color: hsl(var(--text-secondary));
    letter-spacing: -0.005em;
  }

  /* =====================================================================
     CARD / TABLE
     ===================================================================== */
  .card {
    background: hsl(var(--background-object));
    border: 1px solid hsl(var(--border-muted));
    border-radius: var(--radius-card);
    overflow: hidden;
  }
  table {
    width: 100%; border-collapse: separate; border-spacing: 0;
  }
  th, td {
    padding: 12px 14px;
    text-align: left;
    white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
    border-bottom: 1px solid hsl(var(--border-muted));
  }
  tbody tr:last-child td { border-bottom: none; }
  th {
    font-size: 12px; font-weight: 500;
    color: hsl(var(--text-secondary));
    background: hsl(var(--background-object));
    letter-spacing: -0.005em;
    height: 36px;
  }
  td.num, th.num { text-align: right; }
  td {
    color: hsl(var(--text-primary));
    font-size: 13px;
    font-weight: 500;
  }
  tbody tr { transition: background-color 0.15s ease; }
  tbody tr:hover td { background: hsl(var(--hover-object)); }
  td.rank {
    color: hsl(var(--text-tertiary));
    width: 32px; font-weight: 500;
  }

  /* =====================================================================
     LEADERBOARD — primary surface. Slightly more generous padding.
     ===================================================================== */
  .lb-section { margin-top: 20px; }
  .lb-card {
    background: hsl(var(--background-object));
    border: 1px solid hsl(var(--border-muted));
    border-radius: var(--radius-card);
    overflow: hidden;
  }
  .lb-table th, .lb-table td { padding: 14px 18px; }
  .lb-table th { font-size: 12px; height: 40px; }
  .lb-table td { font-size: 13px; }
  .lb-table td.user-cell { font-weight: 600; font-size: 14px; }
  .lb-table td.rank { font-size: 13px; color: hsl(var(--text-tertiary)); width: 48px; }

  .empty {
    padding: 20px 18px;
    color: hsl(var(--text-tertiary));
    font-size: 13px;
    text-align: left;
  }
  /* Loading-state pulse for placeholders and the contribution-grid
     skeleton during the first fetch. */
  @keyframes skeleton-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.55; }
  }
  .empty,
  .contribution-grid.is-loading .cg-inner {
    animation: skeleton-pulse 1.6s ease-in-out infinite;
  }

  /* =====================================================================
     RANGE PILLS — borderless container; pills shift background on
     hover/active.
     ===================================================================== */
  .range {
    display: inline-flex; gap: 2px;
    border: none;
    padding: 2px;
    background: transparent;
  }
  .range button {
    background: transparent;
    color: hsl(var(--text-secondary));
    border: none;
    padding: 5px 10px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: -0.005em;
    text-transform: none;
    cursor: pointer;
    border-radius: var(--radius);
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .range button:hover {
    background: hsl(var(--hover-app));
    color: hsl(var(--text-primary));
  }
  .range button.on {
    background: hsl(var(--active-app));
    color: hsl(var(--text-primary));
    font-weight: 600;
  }

  /* =====================================================================
     DANGER ZONE — pink (text-destructive) not red.
     ===================================================================== */
  .danger { margin-top: 36px; }
  .danger summary {
    cursor: pointer; padding: 12px 16px;
    border: 1px solid hsl(var(--border-muted));
    color: hsl(var(--text-destructive));
    font-size: 12px; letter-spacing: -0.005em;
    text-transform: none; font-weight: 600;
    list-style: none;
    border-radius: var(--radius-card);
    background: hsl(var(--background-object));
    transition: background-color 0.15s ease;
  }
  .danger summary::-webkit-details-marker { display: none; }
  .danger summary:hover {
    background: hsl(var(--control-destructive));
  }
  .danger[open] summary {
    background: hsl(var(--control-destructive));
    border-bottom-left-radius: 0; border-bottom-right-radius: 0;
  }
  .danger-body {
    border: 1px solid hsl(var(--border-muted));
    border-top: none;
    padding: 18px 20px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 14px;
    background: hsl(var(--background-object));
    border-bottom-left-radius: var(--radius-card);
    border-bottom-right-radius: var(--radius-card);
  }
  .danger-body label {
    display: block;
    font-size: 11px; letter-spacing: -0.005em;
    text-transform: none; font-weight: 500;
    color: hsl(var(--text-secondary));
    margin-bottom: 6px;
  }
  .danger-body input, .danger-body select {
    width: 100%; padding: 6px 12px; height: 32px;
    border: 1px solid hsl(var(--control-background));
    background: hsl(var(--background-primary));
    color: hsl(var(--text-primary));
    font: inherit; font-size: 13px; font-weight: 500;
    border-radius: var(--radius);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .danger-body input:focus, .danger-body select:focus {
    outline: none;
    border-color: hsl(var(--ring));
    box-shadow: 0 0 0 2px hsl(var(--ring) / 0.2);
  }
  .danger-body input::placeholder { color: hsl(var(--text-secondary)); }
  .danger-body button {
    grid-column: 1 / -1;
    padding: 8px 16px; height: 36px;
    border: none;
    background: hsl(var(--control-destructive));
    color: hsl(var(--text-destructive));
    font: inherit; font-size: 13px; letter-spacing: -0.005em;
    text-transform: none; font-weight: 600;
    cursor: pointer; border-radius: var(--radius);
    transition: filter 0.15s ease;
  }
  .danger-body button:hover { filter: brightness(0.95); }
  .danger-status {
    grid-column: 1 / -1;
    font-size: 12px; color: hsl(var(--text-secondary));
    min-height: 16px;
    font-weight: 500;
  }
  .danger-status.ok  { color: hsl(var(--accent-green)); }
  .danger-status.bad { color: hsl(var(--text-destructive)); }

  /* Daemon fleet status pills — theme-safe via the accent vars. */
  .fleet-badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 10px;
    letter-spacing: 0.04em;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .fleet-ok      { color: hsl(var(--accent-green));  border-color: hsl(var(--accent-green) / 0.35);  background: hsl(var(--accent-green) / 0.10); }
  .fleet-stale   { color: hsl(var(--accent-orange)); border-color: hsl(var(--accent-orange) / 0.40); background: hsl(var(--accent-orange) / 0.12); }
  .fleet-unknown { color: hsl(var(--text-tertiary)); border-color: hsl(var(--border-primary)); }
  .fleet-neutral { color: hsl(var(--text-secondary)); border-color: hsl(var(--border-primary)); }

  /* =====================================================================
     ICONS — shared SVG symbols; fill: currentColor adapts to theme.
     ===================================================================== */
  .icon {
    width: 14px; height: 14px;
    display: inline-block;
    vertical-align: -2px;
    fill: currentColor;
    flex-shrink: 0;
  }
  .icon-lg { width: 16px; height: 16px; vertical-align: -3px; }
  /* Rank-1 trophy. The span is a flex-centered block the same height as
     the digit cells' text line, so it aligns with the digits below. */
  .rank-trophy {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    height: 1.5em;
    line-height: 1;
    vertical-align: baseline;
  }
  .icon.trophy {
    color: hsl(var(--accent-orange));
    width: 18px; height: 18px;
    vertical-align: baseline;
  }
  /* Rank column: center-aligned across header + body so the trophy,
     the "#" label, and the digits 2..N all line up on the same axis. */
  .lb-table th.rank-col,
  .lb-table td.rank {
    text-align: center;
    vertical-align: middle;
  }
  .rank-trophy { justify-content: center; }
  .stat .lbl { display: inline-flex; align-items: center; gap: 6px; }
  .cg-tt-row {
    display: flex; align-items: center; gap: 6px;
    margin-top: 3px;
    font-variant-numeric: tabular-nums;
  }
</style>
</head>
<body>

<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">
  <symbol id="icon-mark" viewBox="0 0 236.288 118.144">
    <!-- Anara asterisk-pair mark (anara/apps/web/public/brand/anara-mark.svg).
         Inline rather than <img src="/brand/logo.svg"> so it inherits
         fill: currentColor and tracks the light/dark theme toggle; the 2:1
         viewBox is why header .brand-logo above is 32x16, not square. -->
    <path d="M64.3557 44.8681L102.776 21.4366L112.176 37.7746L72.4561 59.2037L112.179 80.5022L102.774 96.8484L64.3557 73.2847L65.4188 118.144H46.7474L47.8099 73.2794L9.2407 96.8537L0 80.4951L39.7095 59.2037L0.00235973 37.7811L9.23834 21.4314L47.8105 44.874L46.7474 0H65.4188L64.3557 44.8681Z"/>
    <path d="M188.465 44.8681L226.886 21.4366L236.286 37.7746L196.566 59.2037L236.288 80.5022L226.884 96.8484L188.465 73.2847L189.528 118.144H170.857L171.92 73.2794L133.35 96.8537L124.111 80.4951L163.819 59.2037L124.113 37.7811L133.348 21.4314L171.92 44.874L170.857 0H189.528L188.465 44.8681Z"/>
  </symbol>
  <symbol id="icon-trophy" viewBox="0 0 24 24">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M7 2C5.89543 2 5 2.89543 5 4H4C2.89543 4 2 4.89543 2 6V7C2 9.09706 3.61375 10.8172 5.66717 10.9864C6.65237 13.0719 8.63747 14.5925 11.0039 14.9297V17H8C6.89543 17 6 17.8954 6 19V20C6 21.1046 6.89543 22 8 22H16C17.1046 22 18 21.1046 18 20V19C18 17.8954 17.1046 17 16 17H13.0039V14.9286C15.3669 14.5892 17.3487 13.0696 18.3328 10.9864C20.3862 10.8172 22 9.09706 22 7V6C22 4.89543 21.1046 4 20 4H19C19 2.89543 18.1046 2 17 2H7ZM4 6H5V8C5 8.25512 5.01365 8.50705 5.04025 8.7551C4.42032 8.41539 4 7.75678 4 7V6ZM20 7C20 7.75678 19.5797 8.41539 18.9597 8.7551C18.9864 8.50705 19 8.25512 19 8V6H20V7Z"/>
  </symbol>
  <symbol id="icon-messages" viewBox="0 0 24 24">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M2 9C2 5.68629 4.68629 3 8 3H16C19.3137 3 22 5.68629 22 9V15C22 18.3137 19.3137 21 16 21H3C2.44772 21 2 20.5523 2 20V9ZM9 9C8.44772 9 8 9.44772 8 10C8 10.5523 8.44772 11 9 11H15C15.5523 11 16 10.5523 16 10C16 9.44772 15.5523 9 15 9H9ZM9 13C8.44772 13 8 13.4477 8 14C8 14.5523 8.44772 15 9 15H12C12.5523 15 13 14.5523 13 14C13 13.4477 12.5523 13 12 13H9Z"/>
  </symbol>
  <symbol id="icon-tokens" viewBox="0 0 24 24">
    <path d="M14 19C14 20.1046 11.3137 21 8 21C4.68629 21 2 20.1046 2 19V16.2666C2.39455 16.5005 2.83555 16.6877 3.2832 16.8369C4.55936 17.2623 6.22682 17.5 8 17.5C9.77318 17.5 11.4406 17.2623 12.7168 16.8369C13.1645 16.6877 13.6055 16.5005 14 16.2666V19Z"/>
    <path d="M22 15C22 16.1046 19.3137 17 16 17C15.7802 17 15.5633 16.995 15.3496 16.9873V13.8965L15.3457 13.8984C15.3387 13.7531 15.3158 13.6156 15.2822 13.4854C15.5191 13.494 15.7585 13.5 16 13.5C17.7732 13.5 19.4406 13.2623 20.7168 12.8369C21.1645 12.6877 21.6055 12.5005 22 12.2666V15Z"/>
    <path d="M8 12C11.3137 12 14 12.8954 14 14C14 15.1046 11.3137 16 8 16C4.68629 16 2 15.1046 2 14C2 12.8954 4.68629 12 8 12Z"/>
    <path d="M22 10C22 11.1046 19.3137 12 16 12C15.2796 12 14.5892 11.9545 13.9492 11.877C13.561 11.643 13.1213 11.4551 12.6699 11.3047C12.0427 11.0956 11.3175 10.9315 10.5293 10.8203C10.1899 10.5696 10 10.2929 10 10V7.2666C10.3945 7.50053 10.8355 7.6877 11.2832 7.83691C12.5594 8.26229 14.2268 8.5 16 8.5C17.7732 8.5 19.4406 8.26229 20.7168 7.83691C21.1645 7.6877 21.6055 7.50053 22 7.2666V10Z"/>
    <path d="M16 3C19.3137 3 22 3.89543 22 5C22 6.10457 19.3137 7 16 7C12.6863 7 10 6.10457 10 5C10 3.89543 12.6863 3 16 3Z"/>
  </symbol>
  <symbol id="icon-money" viewBox="0 0 24 24">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M12.0002 0.5C12.6904 0.500095 13.2502 1.0597 13.2502 1.75V2.58398C15.0933 2.81534 16.9219 3.54471 18.1847 4.87012C18.6607 5.36983 18.6422 6.16052 18.1427 6.63672C17.6429 7.11276 16.8513 7.09345 16.3752 6.59375C15.6494 5.8322 14.5057 5.31815 13.2502 5.10742V11.1787C14.4553 11.4936 15.7677 11.8651 16.8175 12.457C17.4679 12.8238 18.0868 13.3095 18.5412 13.9805C19.0055 14.6664 19.2501 15.476 19.2502 16.4004C19.2502 18.0859 18.3639 19.3594 17.1466 20.1826C16.0463 20.9266 14.6533 21.3251 13.2502 21.4512V22.25C13.2502 22.9403 12.6904 23.4999 12.0002 23.5C11.3099 23.4999 10.7502 22.9403 10.7502 22.25V21.3965C9.93511 21.2864 9.1312 21.0877 8.38199 20.793C6.96933 20.2372 5.65265 19.3049 4.89957 17.9082C4.57233 17.3007 4.80001 16.5424 5.40738 16.2148C6.01487 15.8877 6.77314 16.1144 7.10074 16.7217C7.49047 17.4445 8.24567 18.0531 9.29703 18.4668C9.75039 18.6451 10.2421 18.7769 10.7502 18.8662V13.0996C9.67158 12.7912 8.55321 12.403 7.62809 11.8174C6.25547 10.9483 5.25016 9.60822 5.25016 7.57129C5.2502 6.06868 5.94169 4.87255 6.96891 4.04102C7.9657 3.23431 9.26215 2.77561 10.5744 2.59375C10.6325 2.58571 10.6915 2.58026 10.7502 2.57324V1.75C10.7502 1.05972 11.3099 0.50013 12.0002 0.5ZM13.2502 18.9414C14.2578 18.8229 15.1304 18.5277 15.7462 18.1113C16.4216 17.6545 16.7502 17.094 16.7502 16.4004C16.7501 15.9392 16.6353 15.6248 16.4709 15.3818C16.2964 15.1243 16.0161 14.8756 15.589 14.6348C14.9646 14.2828 14.1746 14.0242 13.2502 13.7686V18.9414ZM10.7502 5.09766C9.82454 5.2489 9.05884 5.56627 8.54215 5.98438C8.02524 6.40279 7.7502 6.91573 7.75016 7.57129C7.75016 8.6038 8.18277 9.20925 8.96598 9.70508C9.45736 10.0161 10.0596 10.2605 10.7502 10.4844V5.09766Z"/>
  </symbol>
  <symbol id="icon-models" viewBox="0 0 24 24">
    <path d="M3.56945 13.0002L3.1544 13.2026C1.65687 13.9331 1.65687 16.0672 3.1544 16.7977L11.1235 20.6851C11.6769 20.955 12.3238 20.955 12.8772 20.6851L20.8463 16.7977C22.3438 16.0672 22.3438 13.9331 20.8463 13.2026L20.4312 13.0002L12.8772 16.6851C12.3238 16.955 11.6769 16.955 11.1235 16.6851L3.56945 13.0002Z"/>
    <path d="M12.8772 3.31526C12.3238 3.04531 11.6769 3.0453 11.1235 3.31526L3.1544 7.20262C1.65687 7.93312 1.65686 10.0672 3.1544 10.7977L11.1235 14.6851C11.6769 14.955 12.3238 14.955 12.8772 14.6851L20.8463 10.7977C22.3438 10.0672 22.3438 7.93313 20.8463 7.20262L12.8772 3.31526Z"/>
  </symbol>
  <symbol id="icon-users" viewBox="0 0 24 24">
    <path d="M3.49902 7C3.49902 4.79086 5.28988 3 7.49902 3C9.70816 3 11.499 4.79086 11.499 7C11.499 9.20914 9.70816 11 7.49902 11C5.28988 11 3.49902 9.20914 3.49902 7Z"/>
    <path d="M12.499 7C12.499 4.79086 14.2899 3 16.499 3C18.7082 3 20.499 4.79086 20.499 7C20.499 9.20914 18.7082 11 16.499 11C14.2899 11 12.499 9.20914 12.499 7Z"/>
    <path d="M7.49876 12C10.3695 12 13.0926 13.9807 14.1062 17.6135C14.6361 19.5131 13.016 21 11.3528 21H3.64471C1.98155 21 0.36144 19.5131 0.891377 17.6135C1.90488 13.9807 4.62798 12 7.49876 12Z"/>
    <path d="M16.0334 17.0761C15.5456 15.3276 14.7069 13.8486 13.6289 12.7021C14.5244 12.2386 15.5031 12 16.4995 12C19.3703 12 22.0934 13.9807 23.1069 17.6135C23.6368 19.5131 22.0167 21 20.3535 21H15.3297C16.0978 19.9549 16.4485 18.5641 16.0334 17.0761Z"/>
  </symbol>
</svg>

<header>
  <span class="brand">
    <svg class="brand-logo" aria-hidden="true"><use href="#icon-mark"/></svg>
    leaderboard
  </span>
  <span class="team" id="team-name" hidden></span>
  <span class="spacer"></span>
  <span class="poll"><span id="health-dot" class="dot"></span><span id="health-text">online</span> &nbsp;·&nbsp; <span id="lastPoll">last poll --</span></span>
</header>

<div class="page-controls">
  <span class="range" id="range-picker" role="tablist"></span>
  <span id="loading-badge" class="loading-badge" aria-live="polite"></span>
  <span class="kbd-hint">Press <kbd>D</kbd> to toggle theme</span>
</div>

<div class="wrap">

  <div class="strip">
    <div class="stat">
      <div class="lbl"><svg class="icon"><use href="#icon-messages"/></svg>Messages</div>
      <div class="num" id="m-messages">--</div>
    </div>
    <div class="stat">
      <div class="lbl"><svg class="icon"><use href="#icon-tokens"/></svg>Total tokens</div>
      <div class="num" id="m-tokens">--</div>
    </div>
    <div class="stat">
      <div class="lbl"><svg class="icon"><use href="#icon-money"/></svg>Total cost</div>
      <div class="num" id="m-cost">--</div>
    </div>
    <div class="stat">
      <div class="lbl"><svg class="icon"><use href="#icon-models"/></svg>Models tracked</div>
      <div class="num" id="m-models">--</div>
    </div>
    <div class="stat">
      <div class="lbl"><svg class="icon"><use href="#icon-users"/></svg>Active users</div>
      <div class="num" id="m-users">--</div>
    </div>
  </div>

  <section>
    <div class="contribution-grid" id="contribution-grid">
      <div class="cg-inner" id="cg-inner">
        <div class="empty">loading…</div>
      </div>
    </div>
  </section>

  <section class="lb-section">
    <div class="card lb-card">
      <table class="lb-table">
        <thead><tr>
          <th class="rank-col" style="width:48px;">#</th>
          <th>User</th>
          <th class="num">Messages</th>
          <th class="num">Input</th>
          <th class="num">Output</th>
          <th class="num">Cache Create</th>
          <th class="num">Cache Read</th>
          <th class="num">Cost</th>
          <th>Last active</th>
        </tr></thead>
        <tbody id="lb-body">
          <tr><td colspan="9" class="empty">loading…</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <section>
    <div class="card">
      <table>
        <thead><tr>
          <th>Model</th>
          <th class="num">Messages</th>
          <th class="num">Input</th>
          <th class="num">Output</th>
          <th class="num">Cache Create</th>
          <th class="num">Cache Read</th>
          <th class="num">Cost</th>
        </tr></thead>
        <tbody id="mdl-body">
          <tr><td colspan="7" class="empty">loading…</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <section id="fleet-section" style="display:none;">
    <div class="card">
      <table>
        <thead><tr>
          <th>Daemon fleet <span id="fleet-summary" class="muted" style="font-weight:400; letter-spacing:0;"></span></th>
          <th>Version</th>
          <th>Arch</th>
          <th>Status</th>
          <th>Last check-in</th>
        </tr></thead>
        <tbody id="fleet-body">
          <tr><td colspan="5" class="empty">loading…</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <section id="uninstalled-section" style="display:none;">
    <div class="card feed">
      <ol id="uninstalled-list"></ol>
    </div>
  </section>

  <details class="danger" id="danger-zone">
    <summary>Danger zone — admin maintenance</summary>
    <div class="danger-body">
      <div>
        <label for="admin-token">Admin bearer (TOKENLEADER_ADMIN_TOKEN)</label>
        <input id="admin-token" type="password" autocomplete="off" spellcheck="false" placeholder="paste server admin token" />
      </div>
      <div>
        <label for="clear-scope">Scope</label>
        <select id="clear-scope">
          <option value="all">all — wipe events table</option>
          <option value="user">user — wipe one user's events</option>
          <option value="reset-user">reset-user — events + TOFU claim</option>
          <option value="full">full — drop &amp; recreate all tables</option>
        </select>
      </div>
      <div style="grid-column: 1 / -1;">
        <label for="clear-user">User (for user / reset-user)</label>
        <input id="clear-user" type="text" autocomplete="off" spellcheck="false" placeholder="username" />
      </div>
      <button type="button" id="clear-btn">Clear DB</button>
      <div class="danger-status" id="clear-status">No action taken.</div>
    </div>
  </details>

</div>

<script>
(function () {
  "use strict";

  var BASE = ${JSON.stringify(baseUrl)};
  var LEGACY_TOKEN_KEY = "tokenleaderToken";
  var ADMIN_TOKEN_KEY  = "tokenleaderAdminToken";
  var RANGE_KEY        = "tokenleaderRangeDays";
  var THEME_KEY        = "tokenleaderTheme";
  var POLL_MS = 5000;
  var DAY_MS = 86400000;
  var timer = null;
  var lastPollAt = 0;
  var lastUptimeMs = 0;

  // Theme: default = prefers-color-scheme; pressing 'd' overrides and
  // pins the choice in localStorage.
  function applyTheme(theme) {
    var root = document.documentElement;
    root.classList.remove("theme-light", "theme-dark");
    if (theme === "dark") root.classList.add("theme-dark");
    else if (theme === "light") root.classList.add("theme-light");
  }
  function effectiveTheme() {
    var root = document.documentElement;
    if (root.classList.contains("theme-dark")) return "dark";
    if (root.classList.contains("theme-light")) return "light";
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark" : "light";
  }
  (function initTheme() {
    try {
      var saved = localStorage.getItem(THEME_KEY);
      if (saved === "dark" || saved === "light") applyTheme(saved);
    } catch (_) {}
  })();
  document.addEventListener("keydown", function (e) {
    if (e.key !== "d" && e.key !== "D") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
              t.isContentEditable)) return;
    var next = effectiveTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
  });
  // Date-range selector: "7"/"30" (rolling days), "all", or "YYYY-MM".
  var rangeDays = (function () {
    // Default = current UTC month; an explicit month pick is remembered,
    // rolling windows never are.
    try {
      var v = localStorage.getItem(RANGE_KEY);
      if (v && parseMonthRange(v)) return v;
    } catch (_) {}
    var d = new Date();
    return d.getUTCFullYear() + "-" + (d.getUTCMonth() < 9 ? "0" : "") + (d.getUTCMonth() + 1);
  })();

  // Clean up the legacy bearer-token key (the dashboard is now public).
  try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch (_) {}

  function parseMonthRange(r) {
    // [0-9] not \d: this JS lives in a template literal, where \d is an invalid
    // escape and the backslash is dropped (\d -> d), breaking the regex.
    var m = /^([0-9]{4})-([0-9]{2})$/.exec(r);
    if (!m) return null;
    var y = Number(m[1]); var mo = Number(m[2]) - 1;
    if (!isFinite(y) || mo < 0 || mo > 11) return null;
    return { startMs: Date.UTC(y, mo, 1), endMs: Date.UTC(y, mo + 1, 1) };
  }
  function currentSince() {
    if (rangeDays === "all") return 0;
    var month = parseMonthRange(rangeDays);
    if (month) return month.startMs;
    var n = Number(rangeDays);
    if (!isFinite(n) || n <= 0) return 0;
    return Date.now() - n * DAY_MS;
  }
  function currentUntil() {
    var month = parseMonthRange(rangeDays);
    return month ? month.endMs : 0;
  }

  function $(id) { return document.getElementById(id); }
  function fmtInt(n) {
    if (n == null || isNaN(n)) return "--";
    return Number(n).toLocaleString("en-US");
  }
  function fmtCompact(n) {
    if (n == null || isNaN(n)) return "--";
    n = Number(n);
    var abs = Math.abs(n);
    if (abs >= 1e12) return (n/1e12).toFixed(2) + "T";
    if (abs >= 1e9)  return (n/1e9).toFixed(2)  + "B";
    if (abs >= 1e6)  return (n/1e6).toFixed(2)  + "M";
    if (abs >= 1e3)  return (n/1e3).toFixed(2)  + "K";
    return String(n);
  }
  function fmtUsd(n) {
    if (n == null || isNaN(n)) return "$0.00";
    n = Number(n);
    if (n >= 1000) return "$" + n.toFixed(0);
    if (n >= 10)   return "$" + n.toFixed(2);
    return "$" + n.toFixed(4);
  }
  function fmtBytes(n) {
    if (n == null || isNaN(n)) return "--";
    var u = ["B","KB","MB","GB","TB"]; var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i === 0 ? 0 : 1) + u[i];
  }
  function fmtUptime(ms) {
    if (ms == null) return "--";
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s %= 86400;
    var h = Math.floor(s / 3600);  s %= 3600;
    var m = Math.floor(s / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }
  function relTime(ts) {
    if (!ts) return "--";
    var d = Date.now() - ts;
    if (d < 0) d = 0;
    var s = Math.floor(d/1000);
    if (s < 60)     return s + "s ago";
    if (s < 3600)   return Math.floor(s/60) + "m ago";
    if (s < 86400)  return Math.floor(s/3600) + "h ago";
    return Math.floor(s/86400) + "d ago";
  }
  function hhmmss(ts) {
    var d = new Date(ts);
    var p = function(x){return x<10?"0"+x:""+x;};
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function escape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function setHealth(ok) {
    var dot = $("health-dot");
    var txt = $("health-text");
    if (ok) {
      dot.classList.remove("bad");
      txt.textContent = "online";
    } else {
      dot.classList.add("bad");
      txt.textContent = "server error";
    }
  }
  function setLastPoll() {
    $("lastPoll").textContent = "last poll " + (lastPollAt ? relTime(lastPollAt) : "--");
  }
  setInterval(setLastPoll, 1000);

  // Loading-indicator state. Tracks the count of in-flight dashboard
  // fetches and reveals the "loading" badge only after 250ms so that
  // cache hits (<10ms responses) don't flash the indicator.
  var inflight = 0;
  var loadingTimer = null;
  function beginLoad() {
    inflight++;
    if (loadingTimer) return;
    loadingTimer = setTimeout(function () {
      loadingTimer = null;
      if (inflight > 0) {
        var el = $("loading-badge");
        if (el) { el.textContent = "loading"; el.classList.add("on"); }
      }
    }, 250);
  }
  function endLoad() {
    inflight = Math.max(0, inflight - 1);
    if (inflight > 0) return;
    if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
    var el = $("loading-badge");
    if (el) { el.classList.remove("on"); el.textContent = ""; }
  }

  function buildAdminUrl() {
    var since = currentSince();
    var until = currentUntil();
    var qs = [];
    if (since > 0) qs.push("since=" + since);
    if (until > 0) qs.push("until=" + until);
    return BASE + "/stats/admin" + (qs.length ? ("?" + qs.join("&")) : "");
  }

  function refresh(force) {
    if (!force && document.visibilityState !== "visible") return;
    beginLoad();
    fetch(buildAdminUrl(), { cache: "no-store" }).then(function (r) {
      if (!r.ok) { setHealth(false); return null; }
      return r.json();
    }).then(function (data) {
      if (!data) return;
      lastPollAt = Date.now();
      setHealth(true);
      setLastPoll();
      render(data);
    }).catch(function () { setHealth(false); })
      .finally(function () { endLoad(); });
  }

  // Daemon fleet: each teammate's build vs the published version. Own
  // slow timer; hidden until one teammate has a row.
  function fetchFleet(force) {
    var now = Date.now();
    if (!force && now - fleetLastFetchAt < FLEET_POLL_MS) return;
    fleetLastFetchAt = now;
    fetch(BASE + "/stats/fleet", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data) renderFleet(data); })
      .catch(function () {});
  }

  function renderFleet(data) {
    var fleet = (data && data.fleet) || [];
    var latest = (data && data.latestVersion) || null;
    var sec = $("fleet-section");
    var body = $("fleet-body");
    var summary = $("fleet-summary");
    if (!sec || !body) return;
    if (fleet.length === 0) { sec.style.display = "none"; body.innerHTML = ""; return; }
    sec.style.display = "";
    var onLatest = 0, stale = 0, unknown = 0, uncomparable = 0;
    var rows = "";
    for (var i = 0; i < fleet.length; i++) {
      var f = fleet[i];
      var verCell, statusCell;
      if (!f.reporting) {
        unknown++;
        verCell = '<span class="muted-2">unknown</span>';
        statusCell = '<span class="fleet-badge fleet-unknown">old daemon</span>';
      } else if (f.isLatest === true) {
        onLatest++;
        verCell = escape(f.version);
        statusCell = '<span class="fleet-badge fleet-ok">latest</span>';
      } else if (f.isLatest === false) {
        stale++;
        verCell = escape(f.version);
        statusCell = '<span class="fleet-badge fleet-stale">stale</span>';
      } else {
        // isLatest null — nothing published to compare against; report
        // the build, don't call it stale.
        uncomparable++;
        verCell = escape(f.version);
        statusCell = '<span class="fleet-badge fleet-neutral">reporting</span>';
      }
      rows += '<tr>'
        + '<td>' + escape(f.user) + '</td>'
        + '<td>' + verCell + '</td>'
        + '<td class="muted">' + escape(f.arch || '—') + '</td>'
        + '<td>' + statusCell + '</td>'
        + '<td class="muted">' + (f.lastSeen ? relTime(f.lastSeen) : '—') + '</td>'
        + '</tr>';
    }
    body.innerHTML = rows;
    if (summary) {
      var parts;
      if (latest) {
        parts = [onLatest + ' on latest (' + escape(latest) + ')'];
        if (stale) parts.push(stale + ' stale');
      } else {
        parts = [uncomparable + ' reporting (no published version yet)'];
      }
      if (unknown) parts.push(unknown + ' unknown');
      summary.textContent = '— ' + parts.join(' · ');
    }
  }

  function render(data) {
    var srv = data.server || {};
    var lb  = data.leaderboard || [];
    var mdl = data.byModel || [];
    var rec = data.recent || [];
    var msgs = data.messages || { userMessages: 0, assistantMessages: 0 };
    lastUptimeMs = srv.uptimeMs || 0;

    // Display identity comes from the server block (TOKENLEADER_TEAM_NAME).
    // Unset → wordmark-only header and the bare product title.
    var team = srv.teamName || "";
    var teamEl = $("team-name");
    teamEl.textContent = team;
    teamEl.hidden = !team;
    document.title = team ? team + " — tokenleader" : "tokenleader";

    // stats strip
    var totalTokens = 0;
    var totalCost = 0;
    for (var i = 0; i < lb.length; i++) {
      totalTokens += (lb[i].totalInputTokens || 0)
                   + (lb[i].totalOutputTokens || 0)
                   + (lb[i].totalCacheCreationTokens || 0)
                   + (lb[i].totalCacheReadTokens || 0);
    }
    for (var j = 0; j < mdl.length; j++) totalCost += (mdl[j].costUsd || 0);

    var uMsg = msgs.userMessages || 0;
    var aMsg = msgs.assistantMessages || 0;
    var totalMsg = uMsg + aMsg;
    $("m-messages").textContent = fmtCompact(totalMsg);
    $("m-tokens").textContent   = fmtCompact(totalTokens);
    $("m-users").textContent    = fmtInt(lb.length);
    $("m-models").textContent   = fmtInt(mdl.length);
    $("m-cost").textContent     = fmtUsd(totalCost);

    // leaderboard
    var lbBody = $("lb-body");
    if (lb.length === 0) {
      lbBody.innerHTML = '<tr><td colspan="9" class="empty">no users yet</td></tr>';
    } else {
      var html = "";
      for (var n = 0; n < lb.length; n++) {
        var u = lb[n];
        var rowU = u.userMessages || 0;
        var rowA = u.assistantMessages || 0;
        var msgTotal = rowU + rowA;
        // Combined messages count; tiny sub-line shows user/assistant split.
        var msgCell = fmtInt(msgTotal)
          + '<div class="muted" style="font-size:9px;letter-spacing:0.04em;">'
          + fmtInt(rowU) + ' u  /  ' + fmtInt(rowA) + ' a'
          + '</div>';
        html += '<tr>'
          + '<td class="rank num">'
          +   (n === 0
                ? '<span class="rank-trophy" aria-label="1"><svg class="icon trophy" aria-hidden="true"><use href="#icon-trophy"/></svg></span>'
                : (n + 1))
          + '</td>'
          + '<td>' + escape(u.user) + '</td>'
          + '<td class="num">' + msgCell + '</td>'
          + '<td class="num">' + fmtCompact(u.totalInputTokens) + '</td>'
          + '<td class="num">' + fmtCompact(u.totalOutputTokens) + '</td>'
          + '<td class="num">' + fmtCompact(u.totalCacheCreationTokens) + '</td>'
          + '<td class="num">' + fmtCompact(u.totalCacheReadTokens) + '</td>'
          + '<td class="num">' + fmtUsd(u.costUsd) + '</td>'
          + '<td class="muted">' + relTime(u.lastEventAt) + '</td>'
          + '</tr>';
      }
      lbBody.innerHTML = html;
    }
    // models
    var mdlBody = $("mdl-body");
    if (mdl.length === 0) {
      mdlBody.innerHTML = '<tr><td colspan="7" class="empty">no models yet</td></tr>';
    } else {
      var mh = "";
      for (var p = 0; p < mdl.length; p++) {
        var m = mdl[p];
        var cost = m.unknownPrice ? '<span class="muted-2">—</span>' : fmtUsd(m.costUsd);
        mh += '<tr>'
          + '<td>' + escape(m.model) + '</td>'
          + '<td class="num">' + fmtInt(m.count) + '</td>'
          + '<td class="num">' + fmtCompact(m.inputTokens) + '</td>'
          + '<td class="num">' + fmtCompact(m.outputTokens) + '</td>'
          + '<td class="num">' + fmtCompact(m.cacheCreationTokens) + '</td>'
          + '<td class="num">' + fmtCompact(m.cacheReadTokens) + '</td>'
          + '<td class="num">' + cost + '</td>'
          + '</tr>';
      }
      mdlBody.innerHTML = mh;
    }
    // Recently uninstalled — hidden when empty; lifetime data regardless
    // of the active date-range pill.
    var uninst = data.uninstalled || [];
    var uSec = $("uninstalled-section");
    var uList = $("uninstalled-list");
    if (uSec && uList) {
      if (uninst.length === 0) {
        uSec.style.display = "none";
        uList.innerHTML = "";
      } else {
        uSec.style.display = "";
        var uh = "";
        for (var ui = 0; ui < uninst.length; ui++) {
          var row = uninst[ui];
          uh += '<li class="umsg">'
            + '<span class="ts">' + hhmmss(row.uninstalledAt) + '</span>'
            + '<span class="line">'
            +   '<span class="who">' + escape(row.user) + '</span> '
            +   '<span class="src">uninstalled ' + relTime(row.uninstalledAt) + '</span>'
            + '</span>'
            + '</li>';
        }
        uList.innerHTML = uh;
      }
    }

  }

  // ============================================================
  // Contributions chart (GitHub-style 53 x 7 day calendar).
  // 60s cadence, fixed YTD window, always all-users — decoupled from
  // the 5s admin poll and the range pills.
  // ============================================================
  var CG_POLL_MS = 60 * 1000;
  var cgTimer = null;
  var cgLastFetchAt = 0;
  // Fleet panel polls slowly: versions only change on check-in or deploy.
  var FLEET_POLL_MS = 60 * 1000;
  var fleetTimer = null;
  var fleetLastFetchAt = 0;
  var cgTooltipEl = null;
  var cgLastRows = null;
  var cgResizeTimer = null;

  function cgEnsureTooltip() {
    if (cgTooltipEl) return cgTooltipEl;
    cgTooltipEl = document.createElement("div");
    cgTooltipEl.className = "cg-tooltip cg-hidden";
    document.body.appendChild(cgTooltipEl);
    return cgTooltipEl;
  }
  function cgQuartiles(values) {
    var nz = [];
    for (var i = 0; i < values.length; i++) if (values[i] > 0) nz.push(values[i]);
    if (nz.length === 0) return [1, 1, 1, 1];
    nz.sort(function (a, b) { return a - b; });
    function q(p) {
      var idx = Math.min(nz.length - 1, Math.floor(p * (nz.length - 1)));
      return nz[idx];
    }
    return [q(0.25), q(0.50), q(0.75), nz[nz.length - 1]];
  }
  function cgLevel(v, cuts) {
    if (v <= 0) return 0;
    if (v <= cuts[0]) return 1;
    if (v <= cuts[1]) return 2;
    if (v <= cuts[2]) return 3;
    return 4;
  }
  function cgDateFmt(d) {
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return months[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
  }
  function cgPositionTooltip(ev) {
    var t = cgEnsureTooltip();
    var pad = 12;
    var x = ev.clientX + pad;
    var y = ev.clientY + pad;
    var w = t.offsetWidth;
    if (x + w > window.innerWidth - 8) x = ev.clientX - pad - w;
    t.style.left = x + "px";
    t.style.top  = y + "px";
  }
  function cgShowTooltip(html, ev) {
    var t = cgEnsureTooltip();
    t.innerHTML = html;
    t.classList.remove("cg-hidden");
    cgPositionTooltip(ev);
  }
  function cgHideTooltip() {
    if (cgTooltipEl) cgTooltipEl.classList.add("cg-hidden");
  }
  function cgBuildDays(rows, endMs) {
    var byKey = {};
    for (var i = 0; i < rows.length; i++) byKey[rows[i].bucketLabel] = rows[i];
    function pad(n) { return n < 10 ? "0" + n : "" + n; }
    function keyFor(d) {
      return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
    }
    function topUserOfDay(row) {
      // byUser is only present with no user filter — this chart never
      // filters, so it's always populated.
      if (!row || !row.byUser || row.byUser.length === 0) return null;
      var best = row.byUser[0];
      for (var i = 1; i < row.byUser.length; i++) {
        if (row.byUser[i].events > best.events) best = row.byUser[i];
      }
      return best;
    }
    var year = new Date(endMs).getUTCFullYear();
    var jan1Utc = Date.UTC(year, 0, 1);
    var dec31Utc = Date.UTC(year, 11, 31);
    var jan1Dow = new Date(jan1Utc).getUTCDay();
    var dec31Dow = new Date(dec31Utc).getUTCDay();
    var firstDay = jan1Utc - jan1Dow * 86400000;
    var lastDay  = dec31Utc + (6 - dec31Dow) * 86400000;
    var totalDays = Math.floor((lastDay - firstDay) / 86400000) + 1;
    var days = [];
    for (var j = 0; j < totalDays; j++) {
      var ms = firstDay + j * 86400000;
      var k = keyFor(new Date(ms));
      var row = byKey[k];
      var inYear = new Date(ms).getUTCFullYear() === year;
      var top = inYear ? topUserOfDay(row) : null;
      days.push({
        dateMs: ms,
        inYear: inYear,
        messages: row && inYear ? row.events : 0,
        tokens: row && inYear ? (row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens + (row.reasoningTokens || 0)) : 0,
        costUsd: row && inYear ? row.costUsd : 0,
        topUser: top ? top.user : null,
        topUserMessages: top ? top.events : 0,
      });
    }
    return days;
  }
  function cgRender(rows) {
    var inner = $("cg-inner");
    if (!inner) return;
    var days = cgBuildDays(rows, Date.now());
    var counts = days.map(function (d) { return d.messages; });
    var cuts = cgQuartiles(counts);
    var COLS = 53, ROWS_N = 7;
    var LEFT = 28, TOP = 20;
    var GAP = 3;
    var availW = inner.clientWidth || inner.getBoundingClientRect().width || 720;
    var CELL = Math.floor((availW - LEFT - (COLS - 1) * GAP) / COLS);
    if (CELL < 8) CELL = 8;
    if (CELL > 28) CELL = 28;
    var W = LEFT + COLS * CELL + (COLS - 1) * GAP;
    var H = TOP  + ROWS_N * CELL + (ROWS_N - 1) * GAP;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';
    var dowLabels = { 1: "M", 3: "W", 5: "F" };
    for (var r = 0; r < ROWS_N; r++) {
      if (!dowLabels[r]) continue;
      var ly = TOP + r * (CELL + GAP) + CELL - 1;
      svg += '<text class="cg-dow" x="0" y="' + ly + '">' + dowLabels[r] + '</text>';
    }
    var currentYear = new Date().getUTCFullYear();
    var lastMonth = -1;
    for (var c = 0; c < COLS; c++) {
      var firstDayIdx = c * 7;
      if (firstDayIdx >= days.length) break;
      var d = new Date(days[firstDayIdx].dateMs);
      var mIdx = d.getUTCMonth();
      // Suppress the label for the leading partial week of the previous
      // year — column 0's "Dec" would otherwise appear before "Jan".
      var inCurrentYear = d.getUTCFullYear() === currentYear;
      if (mIdx !== lastMonth && inCurrentYear) {
        var mx = LEFT + c * (CELL + GAP);
        var monthName = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][mIdx];
        svg += '<text class="cg-month" x="' + mx + '" y="10">' + monthName + '</text>';
        lastMonth = mIdx;
      }
      for (var rr = 0; rr < ROWS_N; rr++) {
        var idx = c * 7 + rr;
        if (idx >= days.length) break;
        var dd = days[idx];
        var lvl = dd.inYear ? cgLevel(dd.messages, cuts) : 0;
        var x = LEFT + c * (CELL + GAP);
        var y = TOP  + rr * (CELL + GAP);
        svg += '<rect class="cg-cell" data-idx="' + idx + '" x="' + x + '" y="' + y + '" width="' + CELL + '" height="' + CELL + '" fill="var(--cg-' + lvl + ')"></rect>';
      }
    }
    svg += '</svg>';
    inner.innerHTML = svg;
    var rects = inner.querySelectorAll("rect.cg-cell");
    var ICON_MESSAGES = '<svg class="icon" aria-hidden="true"><use href="#icon-messages"/></svg>';
    var ICON_TOKENS   = '<svg class="icon" aria-hidden="true"><use href="#icon-tokens"/></svg>';
    var ICON_MONEY    = '<svg class="icon" aria-hidden="true"><use href="#icon-money"/></svg>';
    var ICON_TROPHY   = '<svg class="icon" aria-hidden="true"><use href="#icon-trophy"/></svg>';
    rects.forEach(function (rect) {
      rect.addEventListener("mouseenter", function (ev) {
        var idx = Number(rect.getAttribute("data-idx"));
        var dd = days[idx];
        if (!dd) return;
        var html = '<div class="cg-tt-date">' + cgDateFmt(new Date(dd.dateMs)) + '</div>';
        if (!dd.inYear) {
          html += '<div class="cg-tt-row">outside year</div>';
        } else if (dd.messages === 0) {
          html += '<div class="cg-tt-row">no activity</div>';
        } else {
          html += '<div class="cg-tt-row">' + ICON_MESSAGES + fmtInt(dd.messages)
               + (dd.messages === 1 ? ' message' : ' messages') + '</div>';
          if (dd.tokens > 0) {
            html += '<div class="cg-tt-row">' + ICON_TOKENS + fmtCompact(dd.tokens) + ' tokens</div>';
          }
          if (dd.costUsd > 0) {
            html += '<div class="cg-tt-row">' + ICON_MONEY + fmtUsd(dd.costUsd) + '</div>';
          }
          if (dd.topUser) {
            html += '<div class="cg-tt-row">' + ICON_TROPHY + escape(dd.topUser) + '</div>';
          }
        }
        cgShowTooltip(html, ev);
      });
      rect.addEventListener("mousemove", function (ev) { cgPositionTooltip(ev); });
      rect.addEventListener("mouseleave", cgHideTooltip);
    });
  }
  function refreshContributionGrid(force) {
    var now = Date.now();
    if (!force && now - cgLastFetchAt < CG_POLL_MS) return;
    cgLastFetchAt = now;
    // Always YTD, no user filter.
    var jan1 = Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
    var url = BASE + "/stats/timeseries?bucket=day&since=" + jan1;
    var cgRoot = $("contribution-grid");
    if (!cgLastRows && cgRoot) {
      // Skeleton grid while the first request is in flight; cgRender([])
      // builds a full year of zero-activity cells.
      cgRoot.classList.add("is-loading");
      cgRender([]);
    }
    beginLoad();
    fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) return null;
      return r.json();
    }).then(function (data) {
      if (!data || !Array.isArray(data.rows)) return;
      cgLastRows = data.rows;
      if (cgRoot) cgRoot.classList.remove("is-loading");
      cgRender(data.rows);
    }).catch(function () { /* keep previous render */ })
      .finally(function () { endLoad(); });
  }
  window.addEventListener("resize", function () {
    if (cgResizeTimer) clearTimeout(cgResizeTimer);
    cgResizeTimer = setTimeout(function () {
      cgResizeTimer = null;
      if (cgLastRows) cgRender(cgLastRows);
    }, 120);
  });

  function start() {
    if (timer) return;
    refresh(false);
    refreshContributionGrid(true);
    fetchFleet(true);
    timer = setInterval(function () { refresh(false); }, POLL_MS);
    cgTimer = setInterval(function () {
      if (document.visibilityState === "visible") refreshContributionGrid(false);
    }, CG_POLL_MS);
    fleetTimer = setInterval(function () {
      if (document.visibilityState === "visible") fetchFleet(false);
    }, FLEET_POLL_MS);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (cgTimer) { clearInterval(cgTimer); cgTimer = null; }
    if (fleetTimer) { clearInterval(fleetTimer); fleetTimer = null; }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") start(); else stop();
  });
  window.addEventListener("focus", function () {
    refresh(true);
    refreshContributionGrid(false);
    fetchFleet(false);
  });

  // ---- range pill picker --------------------------------------------------
  function setRange(r) {
    rangeDays = r;
    try { localStorage.setItem(RANGE_KEY, r); } catch (_) {}
    var btns = document.querySelectorAll("#range-picker button");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("on", btns[i].getAttribute("data-range") === r);
    }
    refresh(true);
  }
  function populateRangePicker() {
    var picker = $("range-picker");
    if (!picker) return;
    var MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    var now = new Date();
    var y = now.getUTCFullYear();
    var curMo = now.getUTCMonth();
    var html = '<button type="button" data-range="7"   role="tab">7D</button>'
             + '<button type="button" data-range="30"  role="tab">30D</button>';
    // One pill per elapsed month of the current calendar year (Jan..curMo).
    // UTC so the boundaries line up with the server's strftime UTC buckets.
    for (var mo = 0; mo <= curMo; mo++) {
      var key = y + "-" + (mo < 9 ? "0" : "") + (mo + 1);
      html += '<button type="button" data-range="' + key + '" role="tab">' + MONTHS[mo] + '</button>';
    }
    html += '<button type="button" data-range="all" role="tab">ALL</button>';
    picker.innerHTML = html;
  }
  (function bindRange() {
    var picker = $("range-picker");
    if (!picker) return;
    populateRangePicker();
    setRange(rangeDays); // sync "on" class
    picker.addEventListener("click", function (e) {
      var t = e.target;
      while (t && t !== picker && t.tagName !== "BUTTON") t = t.parentNode;
      if (!t || t === picker) return;
      var r = t.getAttribute("data-range");
      if (r) setRange(r);
    });
  })();

  // ---- danger zone --------------------------------------------------------
  (function bindDanger() {
    var tokenInput = $("admin-token");
    var scopeSel   = $("clear-scope");
    var userInput  = $("clear-user");
    var btn        = $("clear-btn");
    var status     = $("clear-status");
    if (!tokenInput || !btn) return;
    try {
      var saved = localStorage.getItem(ADMIN_TOKEN_KEY);
      if (saved) tokenInput.value = saved;
    } catch (_) {}
    tokenInput.addEventListener("change", function () {
      try { localStorage.setItem(ADMIN_TOKEN_KEY, tokenInput.value); } catch (_) {}
    });
    btn.addEventListener("click", function () {
      var token = tokenInput.value.trim();
      var scope = scopeSel.value;
      var user  = userInput.value.trim();
      if (!token) {
        status.textContent = "Set the admin bearer first.";
        status.className = "danger-status bad";
        return;
      }
      if ((scope === "user" || scope === "reset-user") && !user) {
        status.textContent = "scope=" + scope + " requires a user.";
        status.className = "danger-status bad";
        return;
      }
      var summary = (scope === "full") ? "DROP all tables (full reset)"
                : (scope === "all")  ? "wipe ALL events"
                : (scope === "user") ? "wipe events for '" + user + "'"
                : "wipe events + TOFU secret for '" + user + "'";
      if (!window.confirm("Confirm: " + summary + ". Type OK only if you mean it.")) return;
      status.textContent = "working…";
      status.className = "danger-status";
      var body = { scope: scope };
      if (scope === "user" || scope === "reset-user") body.user = user;
      try { localStorage.setItem(ADMIN_TOKEN_KEY, token); } catch (_) {}
      fetch(BASE + "/admin/clear", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token,
        },
        body: JSON.stringify(body),
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
      }).then(function (res) {
        if (res.ok) {
          status.textContent = "OK — " + JSON.stringify(res.body);
          status.className = "danger-status ok";
          refresh(true);
        } else {
          status.textContent = "HTTP " + res.status + " — " +
            (res.body && res.body.error ? res.body.error : "failed");
          status.className = "danger-status bad";
        }
      }).catch(function (err) {
        status.textContent = "network error: " + String(err);
        status.className = "danger-status bad";
      });
    });
  })();

  // boot
  refresh(true);
  start();
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
