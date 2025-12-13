<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Airdrop Empire</title>
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"
  />

  <!-- Telegram WebApp JS – needed so window.Telegram exists -->
  <script src="https://telegram.org/js/telegram-web-app.js"></script>

  <style>
    * {
      box-sizing: border-box;
      -webkit-tap-highlight-color: transparent;
    }

    html, body {
      height: 100%;
    }

    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text",
        sans-serif;
      background: radial-gradient(circle at top, #1e3a8a, #020617 48%, #000000 90%);
      color: white;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100dvh;
    }

    .app-shell {
      width: 100%;
      max-width: 420px;
      height: 100vh;
      max-height: 900px;
      background: radial-gradient(
        circle at top,
        #1e293b 0%,
        #020617 30%,
        #000000 85%
      );
      border-radius: 32px 32px 0 0;
      box-shadow: 0 18px 60px rgba(15, 23, 42, 0.8),
        inset 0 0 1px rgba(255, 255, 255, 0.08);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding-top: calc(10px + env(safe-area-inset-top));
      padding-bottom: 8px;
      position: relative;
    }

    .top-bar {
      padding: calc(env(safe-area-inset-top) * 0.35) 16px 2px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      color: rgba(255, 255, 255, 0.7);
    }

    .top-bar-left,
    .top-bar-right {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .top-dot-menu {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 2px;
      cursor: pointer;
      background: radial-gradient(
        circle at 0 0,
        rgba(255, 255, 255, 0.12),
        transparent 60%
      );
    }

    .top-dot-menu span {
      width: 3px;
      height: 3px;
      border-radius: 999px;
      background: rgba(248, 250, 252, 0.9);
    }

    .mini-app-label {
      font-size: 11px;
      color: rgba(148, 163, 184, 0.9);
      margin-left: 2px;
    }

    .header {
      padding: 4px 16px 0;
    }

    .card {
      background: radial-gradient(
        circle at 0 -40%,
        #f97316 0%,
        #ec4899 35%,
        #1e293b 70%
      );
      border-radius: 24px;
      padding: 14px 14px 12px;
      display: flex;
      align-items: stretch;
      gap: 10px;
      position: relative;
      overflow: hidden;
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.95),
        inset 0 0 0 1px rgba(248, 250, 252, 0.1);
    }

    .card::before {
      content: "";
      position: absolute;
      inset: -40%;
      background:
        radial-gradient(circle at 0 -10%, rgba(254, 249, 195, 0.3), transparent 55%),
        radial-gradient(circle at 120% -10%, rgba(251, 113, 133, 0.35), transparent 55%);
      mix-blend-mode: screen;
      opacity: 0.9;
      pointer-events: none;
    }

    .card-badge {
      width: 40px;
      height: 40px;
      border-radius: 16px;
      background: radial-gradient(circle at 30% 0, #facc15, #fb923c);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 14px 30px rgba(15, 23, 42, 0.9),
        inset 0 0 0 1px rgba(248, 250, 252, 0.4);
      position: relative;
      z-index: 1;
      flex-shrink: 0;
    }

    .card-badge span {
      font-size: 22px;
    }

    .card-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
      position: relative;
      z-index: 1;
    }

    .card-title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-shadow: 0 2px 12px rgba(15, 23, 42, 0.9);
    }

    .card-subtitle {
      font-size: 11px;
      color: rgba(248, 250, 252, 0.9);
      line-height: 1.35;
      max-width: 220px;
    }

    .card-pill {
      margin-top: 2px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 7px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.9);
      box-shadow: 0 10px 20px rgba(15, 23, 42, 0.9),
        inset 0 0 0 1px rgba(148, 163, 184, 0.5);
      font-size: 10px;
      color: rgba(226, 232, 240, 0.95);
    }

    .card-pill span:nth-child(2) {
      padding-left: 6px;
      border-left: 1px solid rgba(148, 163, 184, 0.6);
    }

    .card-balance-col {
      min-width: 96px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      justify-content: center;
      gap: 4px;
      position: relative;
      z-index: 1;
    }

    .card-balance-label {
      font-size: 10px;
      color: rgba(226, 232, 240, 0.85);
    }

    .card-balance-value {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-shadow: 0 0 18px rgba(15, 23, 42, 0.8);
    }

    .card-balance-token {
      font-size: 11px;
      color: rgba(226, 232, 240, 0.9);
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.85);
      box-shadow: 0 10px 20px rgba(15, 23, 42, 0.95),
        inset 0 0 0 1px rgba(148, 163, 184, 0.4);
    }

    .card-balance-token span:first-child {
      font-size: 13px;
    }

    /* Global rank block */
    .global-rank-block {
      margin-top: 6px;
      width: 100%;
      padding: 6px 8px;
      border-radius: 14px;
      background: rgba(15, 23, 42, 0.96);
      box-shadow:
        0 10px 22px rgba(15, 23, 42, 0.95),
        inset 0 0 0 1px rgba(148, 163, 184, 0.45);
    }

    .global-rank-top-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 4px;
    }

    .global-rank-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: rgba(148, 163, 184, 0.96);
      white-space: nowrap;
    }

    .global-rank-value {
      font-size: 12px;
      font-weight: 600;
      color: rgba(248, 250, 252, 0.98);
    }

    .global-rank-bar {
      position: relative;
      width: 100%;
      height: 5px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 1);
      overflow: hidden;
      box-shadow: inset 0 0 0 1px rgba(30, 64, 175, 0.8);
      margin-bottom: 3px;
    }

    .global-rank-fill {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: linear-gradient(
        90deg,
        rgba(56, 189, 248, 0.9),
        rgba(251, 191, 36, 0.95),
        rgba(249, 115, 22, 0.95)
      );
      transform-origin: left center;
      transform: scaleX(0);
      transition: transform 0.35s ease-out;
    }

    .global-rank-next {
      font-size: 10px;
      color: rgba(148, 163, 184, 0.96);
      text-align: right;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .rank-bar {
      margin-top: 10px;
      margin-bottom: 4px;
      background: linear-gradient(
        90deg,
        rgba(15, 23, 42, 0.96),
        rgba(15, 23, 42, 0.98)
      );
      border-radius: 999px;
      padding: 5px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: relative;
      overflow: hidden;
      box-shadow: 0 12px 24px rgba(15, 23, 42, 1),
        inset 0 0 0 1px rgba(255, 255, 255, 0.04);
    }

    .rank-fill {
      position: absolute;
      inset: 1px;
      border-radius: 999px;
      background: linear-gradient(
        90deg,
        rgba(234, 88, 12, 0.3),
        rgba(234, 179, 8, 0.28)
      );
      transform-origin: left center;
      transform: scaleX(0);
      transition: transform 0.35s ease-out;
      opacity: 0.9;
    }

    .rank-label {
      position: relative;
      z-index: 1;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: rgba(248, 250, 252, 0.9);
    }

    .rank-points {
      position: relative;
      z-index: 1;
      font-size: 11px;
      color: rgba(226, 232, 240, 0.94);
    }

    .main {
      flex: 1;
      padding: 4px 16px 4px;
      overflow-y: auto;
      scrollbar-width: none;
    }

    .main::-webkit-scrollbar {
      display: none;
    }

    .tap-card {
      margin-top: 8px;
      border-radius: 24px;
      padding: 12px 14px 16px;
      background: radial-gradient(
          circle at 0 -20%,
          rgba(251, 191, 36, 0.25),
          transparent 55%
        ),
        radial-gradient(
          circle at 100% -20%,
          rgba(96, 165, 250, 0.35),
          transparent 60%
        ),
        radial-gradient(
          circle at 50% 120%,
          rgba(13, 148, 136, 0.3),
          transparent 60%
        ),
        linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(15, 23, 42, 0.95));
      box-shadow: 0 18px 45px rgba(15, 23, 42, 0.98),
        inset 0 0 0 1px rgba(148, 163, 184, 0.16);
      position: relative;
      overflow: hidden;
    }

    .tap-card::before {
      content: "";
      position: absolute;
      inset: -30%;
      background: radial-gradient(
          circle at 0 -30%,
          rgba(253, 224, 71, 0.2),
          transparent 55%
        ),
        radial-gradient(
          circle at 100% 0,
          rgba(129, 140, 248, 0.18),
          transparent 55%
        );
      mix-blend-mode: screen;
      opacity: 0.9;
      pointer-events: none;
    }

    .tap-card-header {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .tap-card-left {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 230px;
    }

    .tap-title {
      font-size: 16px;
      font-weight: 600;
    }

    .tap-subtitle {
      font-size: 11px;
      color: rgba(226, 232, 240, 0.9);
      line-height: 1.4;
    }

    .tap-hint {
      font-size: 11px;
      color: rgba(248, 250, 252, 0.95);
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 7px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.9);
      box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.4);
    }

    .tap-btn-wrap {
      margin-top: 10px;
      display: flex;
      justify-content: center;
    }

    .tap-btn-main {
      width: 180px;
      height: 180px;
      border-radius: 50%;
      border: none;
      background: radial-gradient(
          circle at 30% 0%,
          rgba(253, 224, 71, 0.45),
          transparent 50%
        ),
        radial-gradient(
          circle at 70% 0%,
          rgba(251, 113, 133, 0.45),
          transparent 50%
        ),
        radial-gradient(
          circle at 50% 120%,
          rgba(14, 165, 233, 0.6),
          transparent 55%
        ),
        linear-gradient(145deg, #0f172a, #020617);
      box-shadow:
        0 24px 60px rgba(15, 23, 42, 1),
        0 0 0 1px rgba(248, 250, 252, 0.12),
        inset 0 0 0 1px rgba(15, 23, 42, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
      position: relative;
      overflow: hidden;
    }

    .tap-btn-main::before {
      content: "";
      position: absolute;
      inset: 18%;
      border-radius: 999px;
      border: 1px dashed rgba(248, 250, 252, 0.4);
      opacity: 0.65;
    }

    .tap-btn-main:active {
      transform: scale(0.97);
      box-shadow:
        0 18px 45px rgba(15, 23, 42, 0.9),
        0 0 0 1px rgba(248, 250, 252, 0.08),
        inset 0 0 0 1px rgba(15, 23, 42, 0.9);
    }

    .tap-btn-ring {
      position: absolute;
      inset: 6px;
      border-radius: 999px;
      border: 1px solid rgba(248, 250, 252, 0.12);
      box-shadow: 0 0 35px rgba(56, 189, 248, 0.6);
      opacity: 0.85;
    }

    .tap-btn-label {
      position: relative;
      z-index: 1;
    }

    .tap-metrics {
      margin-top: 12px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      position: relative;
      z-index: 1;
    }

    .tap-metric {
      border-radius: 14px;
      padding: 7px 9px 6px;
      background: rgba(15, 23, 42, 0.96);
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.95),
        inset 0 0 0 1px rgba(148, 163, 184, 0.3);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .metric-label {
      font-size: 10px;
      color: rgba(148, 163, 184, 0.96);
    }

    .metric-value {
      font-size: 14px;
      font-weight: 600;
    }

    .metric-sub {
      font-size: 10px;
      color: rgba(148, 163, 184, 0.96);
    }

    .energy-bar {
      width: 100%;
      height: 5px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 1);
      overflow: hidden;
      position: relative;
      box-shadow: inset 0 0 0 1px rgba(30, 64, 175, 0.8);
    }

    .energy-fill {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: linear-gradient(
        90deg,
        rgb(34, 197, 94),
        rgb(234, 179, 8),
        rgb(248, 113, 113)
      );
      transform-origin: left center;
      transform: scaleX(1);
      transition: transform 0.25s ease-out;
    }

    .tasks {
      margin-top: 12px;
      margin-bottom: 16px;
    }

    .tasks-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }

    .tasks-title {
      font-size: 13px;
      font-weight: 600;
    }

    .tasks-subtitle {
      font-size: 11px;
      color: rgba(148, 163, 184, 0.96);
      margin-bottom: 8px;
    }

    .tasks-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .task-card {
      border-radius: 18px;
      padding: 8px 9px;
      background: linear-gradient(
        145deg,
        rgba(15, 23, 42, 0.98),
        rgba(15, 23, 42, 0.98)
      );
      box-shadow: 0 12px 26px rgba(15, 23, 42, 0.98),
        inset 0 0 0 1px rgba(148, 163, 184, 0.28);
      display: flex;
      flex-direction: column;
      gap: 4px;
      cursor: pointer;
      position: relative;
      overflow: hidden;
    }
    .task-card.task-disabled {
      opacity: 0.55;
      filter: saturate(0.7);
    }

    .task-card.task-disabled::after {
      content: "";
      position: absolute;
      inset: 0;
      background: rgba(2, 6, 23, 0.35);
      pointer-events: none;
    }


    .task-card::before {
      content: "";
      position: absolute;
      inset: -30%;
      background: radial-gradient(
          circle at 0 0,
          rgba(251, 191, 36, 0.2),
          transparent 55%
        ),
        radial-gradient(
          circle at 120% -10%,
          rgba(96, 165, 250, 0.2),
          transparent 55%
        );
      opacity: 0.9;
      mix-blend-mode: screen;
      pointer-events: none;
    }

    .task-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      position: relative;
      z-index: 1;
    }

    .task-title {
      font-size: 12px;
      font-weight: 600;
    }

    .task-reward {
      font-size: 11px;
      color: rgba(251, 191, 36, 0.95);
    }

    .task-desc {
      position: relative;
      z-index: 1;
      font-size: 10px;
      color: rgba(148, 163, 184, 0.96);
      line-height: 1.35;
    }

    .streak-row {
      margin-top: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .streak-label {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      color: rgba(248, 250, 252, 0.96);
    }

    .streak-meter {
      width: 120px;
      height: 6px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.9);
      overflow: hidden;
      box-shadow: inset 0 0 0 1px rgba(30, 64, 175, 0.9);
    }

    .streak-meter-fill {
      width: 0%;
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(
        90deg,
        rgba(234, 179, 8, 0.95),
        rgba(244, 114, 182, 0.95)
      );
      transition: width 0.3s ease-out;
    }

    .bottom-nav {
      margin-top: 2px;
      padding: 6px 10px 4px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      border-radius: 999px;
      background: radial-gradient(
        circle at 0 -40%,
        rgba(15, 23, 42, 1),
        rgba(15, 23, 42, 1)
      );
      box-shadow: 0 -4px 26px rgba(15, 23, 42, 0.8),
        inset 0 0 0 1px rgba(30, 64, 175, 0.8);
      position: sticky;
      bottom: 0;
      z-index: 5;
    }

    .nav-btn {
      flex: 1;
      border-radius: 999px;
      border: none;
      background: transparent;
      color: rgba(148, 163, 184, 0.96);
      font-size: 11px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      padding: 5px 0 4px;
      cursor: pointer;
    }

    .nav-btn span {
      font-size: 10px;
    }

    .nav-btn .nav-icon {
      font-size: 16px;
    }

    .nav-btn.active {
      background: radial-gradient(
        circle at 50% 0,
        rgba(251, 191, 36, 0.12),
        rgba(30, 64, 175, 0.96)
      );
      color: rgba(248, 250, 252, 0.98);
      box-shadow: 0 8px 18px rgba(15, 23, 42, 0.9),
        inset 0 0 0 1px rgba(148, 163, 184, 0.5);
    }

    .friends-sheet {
      color: white;
    }

    .sheet-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.7);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s ease-out;
      z-index: 10;
    }

    .sheet-backdrop.show {
      opacity: 1;
      pointer-events: auto;
    }

    .sheet {
      position: fixed;
      left: 50%;
      bottom: 0;
      transform: translateX(-50%) translateY(100%);
      width: 100%;
      max-width: 420px;
      max-height: 82vh;
      background: radial-gradient(
        circle at 0 -40%,
        #1e293b 0%,
        #020617 30%,
        #020617 100%
      );
      border-radius: 24px 24px 0 0;
      box-shadow: 0 -20px 60px rgba(15, 23, 42, 1),
        inset 0 0 0 1px rgba(148, 163, 184, 0.18);
      display: flex;
      flex-direction: column;
      z-index: 20;
      opacity: 0;
      pointer-events: none;
      transition: transform 0.18s ease-out, opacity 0.18s ease-out;
      overflow: hidden;
    }

    .sheet.show {
      transform: translateX(-50%) translateY(0%);
      opacity: 1;
      pointer-events: auto;
    }

    .sheet-header {
      padding: 12px 16px 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border-bottom: 1px solid rgba(30, 64, 175, 0.7);
    }

    .sheet-title {
      font-size: 14px;
      font-weight: 600;
    }

    .sheet-subtitle {
      font-size: 11px;
      color: rgba(148, 163, 184, 0.96);
      margin-top: 2px;
      max-width: 260px;
    }

    .sheet-close {
      width: 26px;
      height: 26px;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.7);
      background: rgba(15, 23, 42, 0.96);
      color: rgba(248, 250, 252, 0.96);
      font-size: 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .sheet-body {
      padding: 10px 16px 16px;
      overflow-y: auto;
      scrollbar-width: none;
    }

    .sheet-body::-webkit-scrollbar {
      display: none;
    }

    .friends-summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }

    .friends-summary-col {
      border-radius: 16px;
      padding: 8px 9px;
      background: rgba(15, 23, 42, 0.98);
      box-shadow: 0 12px 26px rgba(15, 23, 42, 0.98),
        inset 0 0 0 1px rgba(148, 163, 184, 0.25);
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
    }

    .friends-summary-col span:first-child {
      color: rgba(148, 163, 184, 0.96);
    }

    .friends-summary-col span:last-child {
      font-size: 14px;
      font-weight: 600;
    }

    .friends-link-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }

    .friends-link {
      flex: 1;
      padding: 7px 9px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.95);
      box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.5);
      font-size: 11px;
      color: rgba(226, 232, 240, 0.98);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .friends-copy-btn {
      flex-shrink: 0;
      border-radius: 999px;
      border: none;
      background: rgba(30, 64, 175, 1);
      color: white;
      font-size: 11px;
      padding: 6px 10px 5px;
      cursor: pointer;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.9);
    }

    .friends-share-btn {
      width: 100%;
      margin-top: 2px;
      margin-bottom: 10px;
      border-radius: 999px;
      border: none;
      background: linear-gradient(
        90deg,
        rgba(56, 189, 248, 1),
        rgba(249, 115, 22, 1)
      );
      color: rgba(15, 23, 42, 1);
      font-size: 12px;
      font-weight: 600;
      padding: 9px 0 8px;
      cursor: pointer;
      box-shadow: 0 14px 32px rgba(15, 23, 42, 1);
    }

    .friends-boost-pill {
      border-radius: 16px;
      padding: 8px 9px;
      background: rgba(15, 23, 42, 0.95);
      box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.35);
      font-size: 11px;
      color: rgba(226, 232, 240, 0.96);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .withdraw-card {
      border-radius: 18px;
      padding: 10px 11px;
      background: radial-gradient(
          circle at 0 -20%,
          rgba(56, 189, 248, 0.22),
          transparent 55%
        ),
        linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(15, 23, 42, 0.96));
      box-shadow: 0 18px 45px rgba(15, 23, 42, 1),
        inset 0 0 0 1px rgba(148, 163, 184, 0.25);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .withdraw-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .withdraw-amount {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.08em;
    }

    .balance-token-icon {
      width: 36px;
      height: 36px;
      border-radius: 999px;
      background: radial-gradient(circle at 30% 0, #fbbf24, #f97316);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 14px 30px rgba(15, 23, 42, 1),
        inset 0 0 0 1px rgba(248, 250, 252, 0.4);
    }

    .withdraw-sub {
      font-size: 11px;
      color: rgba(226, 232, 240, 0.96);
    }

    .coming-soon-pill {
      margin-top: 10px;
      border-radius: 999px;
      padding: 7px 10px;
      background: rgba(15, 23, 42, 0.96);
      box-shadow: inset 0 0 0 1px rgba(30, 64, 175, 0.9);
      font-size: 11px;
      color: rgba(226, 232, 240, 0.96);
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .coming-soon-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: #22c55e;
      box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.25);
    }

    .withdraw-help {
      margin-top: 10px;
      font-size: 11px;
      color: rgba(148, 163, 184, 0.96);
    }

    .withdraw-bottom-btn {
      margin-top: 12px;
      width: 100%;
      border-radius: 999px;
      border: none;
      padding: 9px 0 8px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(15, 23, 42, 1);
      color: rgba(148, 163, 184, 0.96);
      box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.3);
    }

    .toast {
      position: fixed;
      left: 50%;
      bottom: 82px;
      transform: translateX(-50%) translateY(10%);
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.96);
      padding: 6px 12px 6px;
      border: 1px solid rgba(148, 163, 184, 0.7);
      font-size: 11px;
      color: rgba(248, 250, 252, 0.96);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      box-shadow: 0 18px 45px rgba(15, 23, 42, 0.98);
      opacity: 0;
      transition: opacity 0.16s ease-out, transform 0.16s ease-out;
      z-index: 40;
      pointer-events: none;
    }

    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0%);
    }

    .toast-icon {
      font-size: 14px;
    }

    @media (max-width: 600px) {
      body {
        align-items: stretch;
      }
      .app-shell {
        max-width: 100%;
        height: 100dvh;
        max-height: none;
        border-radius: 0;
        box-shadow: none;
      }
      .main {
        padding-bottom: 12px;
      }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <div class="top-bar">
      <div class="top-bar-left">
        <div class="top-dot-menu">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <span class="mini-app-label">Airdrop Empire · Mini app</span>
      </div>
      <div class="top-bar-right">
        <span style="font-size: 11px; color: rgba(148,163,184,0.9)">Early access</span>
      </div>
    </div>

    <div class="header">
      <div class="card">
        <div class="card-badge">
          <span>🪙</span>
        </div>
        <div class="card-main">
          <div class="card-title">Airdrop Empire</div>
          <div class="card-subtitle">Tap, complete quests & invite friends to farm your airdrop allocation.</div>
          <div class="card-pill">
            <span>Live testnet farm</span>
            <span>Points → token allocation</span>
          </div>
        </div>
        <div class="card-balance-col">
          <span class="card-balance-label">Your balance</span>
          <span class="card-balance-value" id="balanceText">0</span>
          <span class="card-balance-token">
            <span>🌕</span>
            <span id="rankName">Recruit</span>
          </span>

          <!-- Global Rank block -->
          <div class="global-rank-block">
            <div class="global-rank-top-row">
              <span class="global-rank-label">Global rank</span>
              <span class="global-rank-value" id="globalRankValue">#–</span>
            </div>
            <div class="global-rank-bar">
              <div class="global-rank-fill" id="globalRankFill"></div>
            </div>
            <div class="global-rank-next" id="globalRankNextText">
              Play to join the leaderboard
            </div>
          </div>
          <!-- END Global Rank block -->
        </div>
      </div>

      <div class="rank-bar">
        <div class="rank-fill" id="rankProgressFill"></div>
        <div class="rank-label">
          <span id="rankPointsText">0</span>
        </div>
        <div class="rank-points">
          Next rank at <span id="nextRankPointsText">10,000</span> pts
        </div>
      </div>
    </div>

    <div class="main">
      <div class="tap-card">
        <div class="tap-card-header">
          <div class="tap-card-left">
            <div class="tap-title">Tap to farm points</div>
            <div class="tap-subtitle">
              Your energy refills over time. Use it to farm your allocation before the token goes live.
            </div>
            <div class="tap-hint">
              Each tap currently gives <span id="perTap">+1</span> 🌕.
            </div>
          </div>
        </div>

        <div class="tap-btn-wrap">
          <button class="tap-btn-main" id="tapBtn">
            <div class="tap-btn-ring"></div>
            <div class="tap-btn-label">Tap</div>
          </button>
        </div>

        <div class="tap-metrics">
          <div class="tap-metric">
            <div class="metric-label">Energy</div>
            <div class="energy-bar">
              <div class="energy-fill" id="energyFill"></div>
            </div>
            <div class="metric-sub">
              <span id="energyText">0 / 50</span>
            </div>
          </div>
          <div class="tap-metric">
            <div class="metric-label">Today</div>
            <div class="metric-value" id="todayText">0</div>
          </div>
          <div class="tap-metric">
            <div class="metric-label">Rank points</div>
            <div class="metric-value" id="rankMetricPointsText">0</div>
            <div class="metric-sub">
              Progress to next rank
            </div>
          </div>
        </div>

        <div class="streak-row">
          <div class="streak-label">
            <span>🔥</span>
            <span>Daily streak</span>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <div class="streak-meter">
              <div class="streak-meter-fill" id="streakMeterFill"></div>
            </div>
            <span id="streakDaysText">0 days</span>
          </div>
        </div>
      </div>

      <div class="tasks">
        <div class="tasks-title-row">
          <div class="tasks-title">Boost quests</div>
        </div>
        <div class="tasks-subtitle">
          Complete one-time boosts now. Pro quests & on-chain missions are coming soon.
        </div>

        <!-- Boost quests grid with Double Points + Energy refill -->
        <div class="tasks-grid">
          <div
            class="task-card"
            data-code="pro_quest"
            data-code="daily"
            data-reward="500"
          >
            <div class="task-top">
              <div class="task-title">Daily check-in</div>
              <div class="task-reward" id="dailyRewardText">+500 🌕</div>
            </div>
            <div class="task-desc">
              Claim your once-per-day login bonus to keep your streak alive.
            </div>
          </div>

          <div
            class="task-card"
            data-code="instagram_follow"
            data-reward="1000"
          >
            <div class="task-top">
              <div class="task-title">Follow on Instagram</div>
              <div class="task-reward">+1,000 🌕</div>
            </div>
            <div class="task-desc">
              Tap to follow the official Airdrop Empire Instagram for alpha drops.
            </div>
          </div>

          <div
            class="task-card"
            data-code="invite_friend"
            data-reward="800"
          >
            <div class="task-top">
              <div class="task-title">Invite a friend</div>
              <div class="task-reward">+800 🌕</div>
            </div>
            <div class="task-desc">
              Share your invite link. You earn once friends actually join & farm.
            </div>
          </div>

          <!-- Double points boost -->
          <div
            class="task-card"
            data-code="double_boost"
            data-reward="0"
          >
            <div class="task-top">
              <div class="task-title">Double points boost</div>
              <div class="task-reward" id="doubleBoostRewardText">x2 · 10 mins</div>
            </div>
            <div class="task-desc">
              Activate 10 minutes of x2 tap points via a sponsor action or by spending points.
            </div>
          </div>

          <!-- Energy refill boost -->
          <div
            class="task-card"
            data-code="boost_energy"
            data-reward="0"
          >
            <div class="task-top">
              <div class="task-title">Emergency energy refill</div>
              <div class="task-reward" id="energyRefillRewardText">⚡ Full bar</div>
            </div>
            <div class="task-desc">
              Refill energy instantly by completing a sponsor action or spending points.
            </div>
          </div>

          <div
            class="task-card"
            data-code="pro_quest"
            data-reward="0"
          >
            <div class="task-top">
              <div class="task-title">Pro quests (soon)</div>
              <div class="task-reward">🚧</div>
            </div>
            <div class="task-desc">
              On-chain partner quests, extra rewards & elite missions are in development.
            </div>
          </div>
        </div>
      </div>

      <div class="bottom-nav">
        <button class="nav-btn active" id="tabFarm">
          <div class="nav-icon">⚡️</div>
          <span>Farm</span>
        </button>
        <button class="nav-btn" id="tabTasks">
          <div class="nav-icon">✅</div>
          <span>Tasks</span>
        </button>
        <button class="nav-btn" id="tabFriends">
          <div class="nav-icon">🏆</div>
          <span>Leaderboard</span>
        </button>
        <button class="nav-btn" id="tabWithdraw">
          <div class="nav-icon">💳</div>
          <span>Withdraw</span>
        </button>
      </div>
    </div>
  </div>

  <div class="sheet-backdrop" id="sheetBackdrop"></div>

  <div class="sheet" id="friendsSheet">
    <div class="sheet-header">
      <div>
        <div class="sheet-title">Invite friends · boost your airdrop</div>
        <div class="sheet-subtitle">
          Share your link. You earn when your friends join via Telegram and start farming.
        </div>
      </div>
      <button class="sheet-close" id="friendsClose">×</button>
    </div>

    <div class="sheet-body">
      <div class="friends-summary">
        <div class="friends-summary-col">
          <span>Friends joined</span>
          <span id="friendsJoinedText">0</span>
        </div>
        <div class="friends-summary-col">
          <span>Referral points</span>
          <span id="referralPointsText">0</span>
        </div>
      </div>

      <div class="friends-link-row">
        <div class="friends-link" id="inviteLinkText">
          https://resilient-kheer-041b8c.netlify.app
        </div>
        <button class="friends-copy-btn" id="copyInviteBtn">Copy</button>
      </div>

      <button class="friends-share-btn" id="shareTelegramBtn">
        Share
      </button>

      <div class="friends-boost-pill">
        <span>Invite a friend now for an instant boost (from backend):</span>
        <span>+800 🌕</span>
      </div>
    </div>
  </div>

  <div class="sheet" id="withdrawSheet">
    <div class="sheet-header">
      <div>
        <div class="sheet-title">Withdraw · coming soon</div>
        <div class="sheet-subtitle">
          Withdrawals open after the Airdrop Empire token launches publicly.
        </div>
      </div>
      <button class="sheet-close" id="withdrawClose">×</button>
    </div>
    <div class="sheet-body">
      <div class="withdraw-card">
        <div class="withdraw-row">
          <div>
            <div
              style="font-size: 11px; color: rgba(148, 163, 184, 0.95)"
            >
              Your current balance
            </div>
            <div class="withdraw-amount" id="withdrawBalanceText">0</div>
          </div>
          <div class="balance-token-icon">
            <span>🪙</span>
          </div>
        </div>
        <div class="withdraw-sub">
          Withdrawals are not live yet. Your points will convert into token
          allocation when the Airdrop Empire token launches.
        </div>
      </div>

      <div class="coming-soon-pill">
        <div class="coming-soon-dot"></div>
        <span>On-chain withdraws &amp; quests are under construction.</span>
      </div>

      <div class="withdraw-help">
        Stay tuned in the official Airdrop Empire Telegram and Instagram for
        launch announcements and premium quests.
      </div>

      <button class="withdraw-bottom-btn" disabled>
        Withdrawals opening soon
      </button>
    </div>
  </div>

  <div class="toast" id="toast">
    <span class="toast-icon">✨</span>
    <span id="toastText">Saved</span>
  </div>

  <!-- SCRIPT STARTS IN PART 2 -->
  <script>
const tg =
  window.Telegram && window.Telegram.WebApp
    ? window.Telegram.WebApp
    : null;

if (tg) {
  tg.expand();
  if (typeof tg.requestFullscreen === "function") {
    tg.requestFullscreen();
  }
  tg.setHeaderColor("#050816");
  tg.setBackgroundColor("#050816");
}

// Signed mini-app payload from Telegram (for backend)
const initDataRaw = tg && tg.initData ? tg.initData : "";

// Real Telegram user id from WebApp
const telegramIdFromWebApp =
  tg && tg.initDataUnsafe && tg.initDataUnsafe.user
    ? tg.initDataUnsafe.user.id
    : null;

// Dev / browser fallback ID
let fallbackTelegramId = null;
if (!telegramIdFromWebApp) {
  const stored = localStorage.getItem("ae_dev_telegram_id");
  if (stored) {
    const parsed = Number(stored);
    if (!Number.isNaN(parsed) && parsed > 0) {
      fallbackTelegramId = parsed;
    }
  }

  if (!fallbackTelegramId) {
    fallbackTelegramId =
      1000000000 + Math.floor(Math.random() * 9000000000);
    localStorage.setItem(
      "ae_dev_telegram_id",
      String(fallbackTelegramId)
    );
  }
}

// ID we send to backend
const effectiveTelegramId = telegramIdFromWebApp || fallbackTelegramId || null;

const API_BASE = "https://airdrop-empire-bot.onrender.com";
const FALLBACK_REF_LINK = "https://t.me/airdropempireappbot";

const BALANCE_KEY = "ae_balance";
const ENERGY_KEY = "ae_energy";
const TODAY_KEY = "ae_today";
const LAST_DAY_KEY = "ae_lastday";

const STREAK_DAYS_KEY = "ae_streak_days";
const LAST_CHECKIN_KEY = "ae_last_checkin";
const DAILY_TASK_KEY = "ae_daily_claimed_day";
const INSTAGRAM_TASK_KEY = "ae_instagram_done";
const INVITE_TASK_KEY = "ae_invite_done";
const DAILY_CLAIM_AT_KEY = "ae_daily_claim_at";
const INSTAGRAM_CLAIM_AT_KEY = "ae_instagram_claim_at";

// UI-only cooldown helpers (backend will enforce too once we patch it)
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const maxEnergy = 50;
const perTapBase = 1;

const balanceText = document.getElementById("balanceText");
const energyText = document.getElementById("energyText");
const todayText = document.getElementById("todayText");
const perTapText = document.getElementById("perTap");
const tapBtn = document.getElementById("tapBtn");
const toast = document.getElementById("toast");
const toastText = document.getElementById("toastText");

const rankNameEl = document.getElementById("rankName");
const rankPointsTextEl = document.getElementById("rankPointsText");
const nextRankPointsTextEl = document.getElementById("nextRankPointsText");
const rankProgressFill = document.getElementById("rankProgressFill");

const streakDaysText = document.getElementById("streakDaysText");
const streakMeterFill = document.getElementById("streakMeterFill");

const tabFarm = document.getElementById("tabFarm");
const tabTasks = document.getElementById("tabTasks");
const tabFriends = document.getElementById("tabFriends");
const tabWithdraw = document.getElementById("tabWithdraw");

const sheetBackdrop = document.getElementById("sheetBackdrop");
const friendsSheet = document.getElementById("friendsSheet");
const withdrawSheet = document.getElementById("withdrawSheet");
const friendsClose = document.getElementById("friendsClose");
const withdrawClose = document.getElementById("withdrawClose");

const friendsJoinedText = document.getElementById("friendsJoinedText");
const referralPointsText = document.getElementById("referralPointsText");
const inviteLinkText = document.getElementById("inviteLinkText");
const copyInviteBtn = document.getElementById("copyInviteBtn");
const shareTelegramBtn = document.getElementById("shareTelegramBtn");

const withdrawBalanceText = document.getElementById("withdrawBalanceText");

// Global rank DOM refs
const globalRankValueEl = document.getElementById("globalRankValue");
const globalRankFillEl = document.getElementById("globalRankFill");
const globalRankNextTextEl = document.getElementById("globalRankNextText");
const dailyRewardTextEl = document.getElementById("dailyRewardText");
const doubleBoostRewardTextEl = document.getElementById("doubleBoostRewardText");
const energyRefillRewardTextEl = document.getElementById("energyRefillRewardText");


function showToast(message) {
  toastText.textContent = message;
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 2100);
}

function formatNumber(n) {
  return n.toLocaleString("en-GB");
}

function getTodayString() {
  return new Date().toDateString();
}

const rankConfig = [
  { name: "Recruit", min: 0, max: 10000 },
  { name: "Grinder", min: 10000, max: 50000 },
  { name: "Operator", min: 50000, max: 150000 },
  { name: "Commander", min: 150000, max: 500000 },
  { name: "General", min: 500000, max: 1500000 },
  { name: "Empire OG", min: 1500000, max: 999999999 },
];

const state = {
  bal: 0,
  energy: maxEnergy,
  today: 0,
  lastDay: "",
  streakDays: 0,
  lastCheckin: "",
  friendsJoined: 0,
  referralPoints: 0,
  inviteLink: FALLBACK_REF_LINK,
  globalRank: null,
  globalTotal: null,

  // Double points boost client state
  doubleBoostActive: false,
  doubleBoostUntil: null,
};

function saveStateLocal(s) {
  localStorage.setItem(BALANCE_KEY, String(s.bal));
  localStorage.setItem(ENERGY_KEY, String(s.energy));
  localStorage.setItem(TODAY_KEY, String(s.today));
  localStorage.setItem(LAST_DAY_KEY, s.lastDay || "");

  localStorage.setItem(STREAK_DAYS_KEY, String(s.streakDays || 0));
  localStorage.setItem(LAST_CHECKIN_KEY, s.lastCheckin || "");
}

function loadStateLocal() {
  const todayStr = getTodayString();

  // Backend is now the source of truth.
  // Do NOT load balance/energy/today from localStorage anymore.
  state.bal = 0;
  state.energy = maxEnergy;
  state.today = 0;
  state.lastDay = todayStr;

  // Keep ONLY streak data locally
  const savedStreak = parseInt(localStorage.getItem(STREAK_DAYS_KEY) || "0", 10);
  const savedLastCheckin = localStorage.getItem(LAST_CHECKIN_KEY) || "";

  state.streakDays = isNaN(savedStreak) ? 0 : savedStreak;
  state.lastCheckin = savedLastCheckin;
}

function findRank(bal) {
  let current = rankConfig[0];
  for (const r of rankConfig) {
    if (bal >= r.min && bal < r.max) {
      current = r;
      break;
    }
    if (bal >= r.max) {
      current = r;
    }
  }
  return current;
}

// Global rank visuals (local + backend)
function updateGlobalRankVisuals() {
  if (!globalRankValueEl || !globalRankFillEl || !globalRankNextTextEl) return;

  const balance = Math.max(0, Number(state.bal || 0));

  const milestones = [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
  let nextMilestone = milestones[milestones.length - 1];
  for (const m of milestones) {
    if (balance < m) {
      nextMilestone = m;
      break;
    }
  }

  const hasBackendRank =
    typeof state.globalRank === "number" &&
    state.globalRank > 0 &&
    typeof state.globalTotal === "number" &&
    state.globalTotal > 0;

  if (hasBackendRank) {
    const rank = Math.max(1, Math.floor(state.globalRank));
    const total = Math.max(rank, Math.floor(state.globalTotal));
    globalRankValueEl.textContent = `#${formatNumber(rank)}`;

    const percentile = 1 - rank / total;
    const clamped = Math.max(0, Math.min(1, percentile));
    globalRankFillEl.style.transform = `scaleX(${clamped})`;
  } else {
    const totalPlayersApprox = 1000000;
    const cappedBalance = Math.max(0, Math.min(balance, totalPlayersApprox));
    const percentile = 1 - cappedBalance / totalPlayersApprox;
    const pseudoRank = Math.max(1, Math.round(percentile * totalPlayersApprox));
    globalRankValueEl.textContent = `#${formatNumber(pseudoRank)}`;

    const fill = Math.max(0, Math.min(1, balance / nextMilestone));
    globalRankFillEl.style.transform = `scaleX(${fill})`;
  }

  if (balance === 0) {
    globalRankNextTextEl.textContent = "Play to join the leaderboard";
  } else if (balance >= milestones[milestones.length - 1]) {
    globalRankNextTextEl.textContent = "You’re among the top players";
  } else {
    const diff = nextMilestone - balance;
    globalRankNextTextEl.textContent = `+${formatNumber(diff)} pts to next milestone`;
  }
}

function render() {
  balanceText.textContent = formatNumber(state.bal);
  todayText.textContent = formatNumber(state.today);

  // Points per tap (x2 when boost active)
  const effectivePerTap = state.doubleBoostActive ? perTapBase * 2 : perTapBase;
  if (perTapText) {
    perTapText.textContent = `+${effectivePerTap}`;
  }

  const energyPct = Math.max(0, Math.min(1, state.energy / maxEnergy));
  const energyFill = document.getElementById("energyFill");
  if (energyFill) {
    energyFill.style.transform = `scaleX(${energyPct})`;
  }
  energyText.textContent = `${state.energy} / ${maxEnergy}`;

  const rank = findRank(state.bal);
  rankNameEl.textContent = rank.name;
  rankPointsTextEl.textContent = formatNumber(state.bal);
  const nextRankPoints = rank.max;
  nextRankPointsTextEl.textContent = formatNumber(nextRankPoints);
  const rankMetricPoints = document.getElementById("rankMetricPointsText");
  if (rankMetricPoints) {
    rankMetricPoints.textContent = formatNumber(state.bal);
  }

  let range = rank.max - rank.min;
  if (range <= 0) range = 1;
  const progress = Math.max(0, Math.min(1, (state.bal - rank.min) / range));
  rankProgressFill.style.transform = `scaleX(${progress})`;

  streakDaysText.textContent = `${state.streakDays} day${state.streakDays === 1 ? "" : "s"}`;
  const streakPct = Math.max(0, Math.min(1, state.streakDays / 7));
  streakMeterFill.style.width = `${Math.round(streakPct * 100)}%`;

  friendsJoinedText.textContent = formatNumber(state.friendsJoined || 0);
  referralPointsText.textContent = formatNumber(state.referralPoints || 0);
  inviteLinkText.textContent = state.inviteLink || FALLBACK_REF_LINK;

  withdrawBalanceText.textContent = formatNumber(state.bal);

  // Global rank block
  updateGlobalRankVisuals();
  updateTaskCardStates();
}


function msToCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function getStoredMs(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function setStoredMs(key, ms) {
  localStorage.setItem(key, String(ms));
}

function updateTaskCardStates() {
  // Daily check-in cooldown (UI only; backend will enforce once/day too)
  const lastDaily = getStoredMs(DAILY_CLAIM_AT_KEY);
  const now = Date.now();
  const remaining = lastDaily ? Math.max(0, DAILY_COOLDOWN_MS - (now - lastDaily)) : 0;
  const dailyCard = document.querySelector('.task-card[data-code="daily"]');

  if (dailyRewardTextEl && dailyCard) {
    if (remaining > 0) {
      dailyRewardTextEl.textContent = `Claim in ${msToCountdown(remaining)}`;
      dailyCard.classList.add("task-disabled");
    } else {
      dailyRewardTextEl.textContent = "+500 🌕";
      dailyCard.classList.remove("task-disabled");
    }
  }

  // Instagram one-time claim (UI only; backend should enforce later)
  const igClaimedAt = getStoredMs(INSTAGRAM_CLAIM_AT_KEY);
  const igCard = document.querySelector('.task-card[data-code="instagram_follow"]');
  if (igCard) {
    if (igClaimedAt) {
      igCard.classList.add("task-disabled");
    } else {
      igCard.classList.remove("task-disabled");
    }
  }

  // LOCAL_DOUBLE_EXPIRY: ensure UI turns off when boost time passes even if user doesn't refresh
  if (state.doubleBoostUntil) {
    const untilMs = Date.parse(state.doubleBoostUntil);
    if (!isNaN(untilMs) && Date.now() > untilMs) {
      state.doubleBoostActive = false;
      state.doubleBoostUntil = null;
      saveStateLocal(state);
    }
  }

  // Double boost button: show active state
  const doubleCard = document.querySelector('.task-card[data-code="double_boost"]');
  if (doubleCard && doubleBoostRewardTextEl) {
    if (state.doubleBoostActive) {
      doubleBoostRewardTextEl.textContent = "Active ✨";
      doubleCard.classList.add("task-disabled");
    } else {
      doubleBoostRewardTextEl.textContent = "x2 · 10 mins";
      doubleCard.classList.remove("task-disabled");
    }
  }

  // Energy refill: disable if already full
  const energyCard = document.querySelector('.task-card[data-code="boost_energy"]');
  if (energyCard && energyRefillRewardTextEl) {
    if ((state.energy || 0) >= maxEnergy) {
      energyRefillRewardTextEl.textContent = "Full ✅";
      energyCard.classList.add("task-disabled");
    } else {
      energyRefillRewardTextEl.textContent = "⚡ Full bar";
      energyCard.classList.remove("task-disabled");
    }
  }
}

// keep task timers fresh
setInterval(updateTaskCardStates, 1000);


// 🔐 Centralised POST helper – now refuses to call backend with no Telegram info
async function apiPost(path, body) {
  if (!initDataRaw && !effectiveTelegramId) {
    console.warn("No Telegram auth data – open inside Telegram mini app.");
    showToast("Open from Telegram to save your progress.");
    return { ok: false, reason: "NO_TELEGRAM_ID" };
  }

  try {
    const res = await fetch(API_BASE + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        initData: initDataRaw || "",
        telegram_id: effectiveTelegramId,
        ...body,
      }),
    });

    const data = await res.json();
    return data;
  } catch (err) {
    console.error("API error", err);
    showToast("Network error – try again");
    return null;
  }
}

function applyBackendState(data) {
  if (!data || !data.ok) return;

  if (typeof data.balance === "number") {
    state.bal = data.balance;
  }

  if (typeof data.energy === "number") state.energy = data.energy;
  if (typeof data.today === "number") state.today = data.today;

  if (typeof data.referrals_count === "number") {
    state.friendsJoined = data.referrals_count;
  }
  if (typeof data.referrals_points === "number") {
    state.referralPoints = data.referrals_points;
  }

  if (typeof data.global_rank === "number") {
    state.globalRank = data.global_rank;
  }

  if (typeof data.global_total === "number") {
    state.globalTotal = data.global_total;
  }

  // Double boost flags from backend
  if (typeof data.double_boost_active === "boolean") {
    state.doubleBoostActive = data.double_boost_active;
  }
  if (data.double_boost_until) {
    state.doubleBoostUntil = data.double_boost_until;
  }

  if (data.invite_link) {
    state.inviteLink = data.invite_link;
  }

  saveStateLocal(state);
}

async function initFromBackend() {
  const res = await apiPost("/api/state", {});
  if (res && res.ok) {
    applyBackendState(res);
    render();
    updateTaskCardStates();
  }
}

tapBtn.addEventListener("click", async () => {
  if (state.energy <= 0) {
    showToast("⚡ Out of energy – come back later.");
    return;
  }

  try {
    const res = await apiPost("/api/tap", {});

    if (!res || res.ok !== true) {
      console.error("Tap backend error:", res);
      if (res && res.reason === "NO_TELEGRAM_ID") {
        // already toasted in apiPost
      } else {
        showToast("Network error – tap not saved.");
      }
      return;
    }

    applyBackendState(res);
    render();

    const perTap = state.doubleBoostActive ? perTapBase * 2 : perTapBase;
    showToast(`+${perTap.toLocaleString("en-GB")} points`);
  } catch (err) {
    console.error("Tap click error:", err);
    showToast("Network error – tap not saved.");
  }
});

async function handleDailyTask(reward) {
  // UI cooldown guard (backend should enforce too)
  const lastDaily = getStoredMs(DAILY_CLAIM_AT_KEY);
  const now = Date.now();
  if (lastDaily && now - lastDaily < DAILY_COOLDOWN_MS) {
    const remaining = DAILY_COOLDOWN_MS - (now - lastDaily);
    showToast(`Daily already claimed. Try again in ${msToCountdown(remaining)}.`);
    updateTaskCardStates();
    return;
  }

  const res = await apiPost("/api/task", { taskName: "daily", reward });

  if (!res) return;

  if (!res.ok) {
    if (res.reason !== "NO_TELEGRAM_ID") {
      // If backend has its own cooldown reason, surface it
      if (res.nextAt) {
        const nextAt = new Date(res.nextAt).getTime();
        if (Number.isFinite(nextAt)) {
          const remaining2 = Math.max(0, nextAt - Date.now());
          showToast(`Daily already claimed. Try again in ${msToCountdown(remaining2)}.`);
          setStoredMs(DAILY_CLAIM_AT_KEY, Date.now()); // lock UI for the day
          updateTaskCardStates();
          return;
        }
      }
      showToast("Daily task already claimed or error.");
    }
    return;
  }

  // Mark claimed locally so the UI doesn't keep offering it
  setStoredMs(DAILY_CLAIM_AT_KEY, Date.now());

  applyBackendState(res);
  render();
  updateTaskCardStates();

  showToast(`+${reward.toLocaleString("en-GB")} daily bonus added`);
}

async function handleInstagramTask(reward) {
  const claimedAt = getStoredMs(INSTAGRAM_CLAIM_AT_KEY);
  if (claimedAt) {
    window.open("https://www.instagram.com/airdropempireapp/", "_blank");
    showToast("Instagram boost already claimed.");
    updateTaskCardStates();
    return;
  }

  // Always open the link (user action), but do NOT grant points locally.
  window.open("https://www.instagram.com/airdropempireapp/", "_blank");

  const res = await apiPost("/api/task", { taskName: "instagram_follow", reward });

  if (!res) return;

  if (!res.ok) {
    if (res.reason !== "NO_TELEGRAM_ID") {
      showToast("Instagram bonus already claimed or error.");
    }
    return;
  }

  setStoredMs(INSTAGRAM_CLAIM_AT_KEY, Date.now());

  applyBackendState(res);
  render();
  updateTaskCardStates();

  showToast(`+${reward.toLocaleString("en-GB")} Instagram bonus`);
}

async function handleInviteTask() {
  sheetBackdrop.classList.add("show");
  friendsSheet.classList.add("show");
  setActiveTab(tabFriends);
  showToast("Share your link – you earn when friends actually join.");
}

// ⚡ Energy refill boost
const ENERGY_REFILL_COST_CLIENT = 500;   // keep in sync with backend
const DOUBLE_BOOST_COST_CLIENT = 1000;   // keep in sync with backend

async function handleEnergyBoostTask() {
  if ((state.energy || 0) >= maxEnergy) {
    showToast("Your energy is already full.");
    updateTaskCardStates();
    return;
  }

  const hasPoints = (state.bal || 0) >= ENERGY_REFILL_COST_CLIENT;
  if (!hasPoints) {
    showToast(`Need ${ENERGY_REFILL_COST_CLIENT.toLocaleString("en-GB")} points to refill.`);
    return;
  }

  const ok = window.confirm(
    `Spend ${ENERGY_REFILL_COST_CLIENT.toLocaleString("en-GB")} points to refill energy now?`
  );
  if (!ok) return;

  const res = await apiPost("/api/boost/energy", { method: "points" });

  if (!res) return;

  if (!res.ok) {
    if (res.reason === "ENERGY_FULL") {
      showToast("Your energy is already full.");
    } else if (res.reason === "NOT_ENOUGH_POINTS") {
      showToast("Not enough points for energy refill.");
    } else if (res.reason !== "NO_TELEGRAM_ID") {
      showToast("Energy boost failed – try again.");
    }
    return;
  }

  applyBackendState(res);
  render();
  updateTaskCardStates();

  showToast(res.message || "⚡ Energy refilled!");
}

// Double points boost handler
async function handleDoubleBoostTask() {
  if (state.doubleBoostActive) {
    showToast("Double points is already active.");
    updateTaskCardStates();
    return;
  }

  const hasPoints = (state.bal || 0) >= DOUBLE_BOOST_COST_CLIENT;
  if (!hasPoints) {
    showToast(`Need ${DOUBLE_BOOST_COST_CLIENT.toLocaleString("en-GB")} points for double boost.`);
    return;
  }

  const ok = window.confirm(
    `Spend ${DOUBLE_BOOST_COST_CLIENT.toLocaleString("en-GB")} points for 10 minutes of x2 taps?`
  );
  if (!ok) return;

  const res = await apiPost("/api/boost/double", { method: "points" });

  if (!res) return;

  if (!res.ok) {
    if (res.reason === "NOT_ENOUGH_POINTS") {
      showToast("Not enough points for double boost.");
    } else if (res.reason !== "NO_TELEGRAM_ID") {
      showToast("Double boost failed – try again.");
    }
    return;
  }

  applyBackendState(res);
  render();
  updateTaskCardStates();

  showToast(res.message || "✨ Double points boost activated!");
}

function handleProQuest() {
  showToast("Pro quests are coming soon.");
}

// Task click router (includes double_boost)
document.querySelectorAll(".task-card").forEach((card) => {
  card.addEventListener("click", () => {
    if (card.classList.contains("task-disabled")) {
      const codeDisabled = card.getAttribute("data-code");
      if (codeDisabled === "daily") {
        showToast("Daily check-in is on cooldown.");
      } else if (codeDisabled === "double_boost") {
        showToast("Double points is already active.");
      } else if (codeDisabled === "boost_energy") {
        showToast("Energy is already full.");
      } else {
        showToast("This quest is not available right now.");
      }
      return;
    }
    if (card.classList.contains("task-disabled")) {
      // Keep UX clean: explain why it's disabled
      const codeDisabled = card.getAttribute("data-code");
      if (codeDisabled === "daily") {
        showToast("Daily check-in is on cooldown.");
      } else if (codeDisabled === "double_boost") {
        showToast("Double points is already active.");
      } else if (codeDisabled === "boost_energy") {
        showToast("Energy is already full.");
      } else {
        showToast("This quest is not available yet.");
      }
      return;
    }

    const code = card.getAttribute("data-code");
    const reward = parseInt(card.getAttribute("data-reward") || "0", 10);

    if (code === "daily") {
      handleDailyTask(reward);
    } else if (code === "instagram_follow") {
      handleInstagramTask(reward);
    } else if (code === "invite_friend") {
      handleInviteTask();
    } else if (code === "double_boost") {
      handleDoubleBoostTask();
    } else if (code === "boost_energy") {
      handleEnergyBoostTask();
    } else if (code === "pro_quest") {
      handleProQuest();
    }
  });
});

function setActiveTab(activeBtn) {
  [tabFarm, tabTasks, tabFriends, tabWithdraw].forEach((btn) => {
    if (!btn) return;
    if (btn === activeBtn) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

tabFarm.addEventListener("click", () => {
  setActiveTab(tabFarm);
  sheetBackdrop.classList.remove("show");
  friendsSheet.classList.remove("show");
  withdrawSheet.classList.remove("show");
});

tabTasks.addEventListener("click", () => {
  setActiveTab(tabTasks);
  showToast("Scroll down to see all quests.");
});

tabFriends.addEventListener("click", () => {
  setActiveTab(tabFriends);
  openLeaderboard("friends");
});

tabWithdraw.addEventListener("click", async () => {
  setActiveTab(tabWithdraw);
  sheetBackdrop.classList.add("show");
  withdrawSheet.classList.add("show");
  const res = await apiPost("/api/withdraw/info", {});
  if (res && res.ok && typeof res.balance === "number") {
    withdrawBalanceText.textContent = formatNumber(res.balance);
  } else {
    withdrawBalanceText.textContent = formatNumber(state.bal);
  }
});

friendsClose.addEventListener("click", () => {
  friendsSheet.classList.remove("show");
  sheetBackdrop.classList.remove("show");
  setActiveTab(tabFarm);
});

withdrawClose.addEventListener("click", () => {
  withdrawSheet.classList.remove("show");
  sheetBackdrop.classList.remove("show");
  setActiveTab(tabFarm);
});

sheetBackdrop.addEventListener("click", () => {
  friendsSheet.classList.remove("show");
  withdrawSheet.classList.remove("show");
  sheetBackdrop.classList.remove("show");
  setActiveTab(tabFarm);
});

copyInviteBtn.addEventListener("click", async () => {
  const link = state.inviteLink || FALLBACK_REF_LINK;
  try {
    await navigator.clipboard.writeText(link);
    showToast("Invite link copied");
  } catch (e) {
    showToast("Could not copy link");
  }
});

shareTelegramBtn.addEventListener("click", () => {
  const link = state.inviteLink || FALLBACK_REF_LINK;
  const text = encodeURIComponent(
    `🔥 Join me in Airdrop Empire and farm the airdrop:\n${link}`
  );
  window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`, "_blank");
});

// ---------------- LEADERBOARD OVERLAY ----------------
const leaderboardHTML = `
  <div id="leaderboardScreen" style="
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: none;
    flex-direction: column;
    background: radial-gradient(circle at top left, rgba(251,191,36,0.15), transparent 55%),
                radial-gradient(circle at bottom right, rgba(59,130,246,0.25), #020617 65%);
    color: #e5e7eb;
    padding: 16px 16px 24px 16px;
    box-sizing: border-box;
  ">
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
      <div style="display:flex; flex-direction:column;">
        <span style="font-size:14px; opacity:0.7;">Airdrop Empire</span>
        <span style="font-size:20px; font-weight:700;">Leaderboard</span>
      </div>
      <button id="lbCloseBtn" style="
        width:32px;
        height:32px;
        border-radius:999px;
        border:none;
        background:rgba(15,23,42,0.9);
        color:#e5e7eb;
        font-size:18px;
        display:flex;
        align-items:center;
        justify-content:center;
      ">
        ×
      </button>
    </div>

    <div style="display:flex; gap:8px; margin-bottom:16px;">
      <button id="lbTabGlobal" class="lb-tab-btn" style="
        flex:1;
        border-radius:999px;
        border:none;
        padding:8px 0;
        font-size:14px;
        font-weight:600;
        background:rgba(15,23,42,0.9);
        color:#e5e7eb;
      ">Global</button>
      <button id="lbTabDaily" class="lb-tab-btn" style="
        flex:1;
        border-radius:999px;
        border:none;
        padding:8px 0;
        font-size:14px;
        font-weight:600;
        background:rgba(15,23,42,0.5);
        color:#9ca3af;
      ">Daily</button>
      <button id="lbTabFriends" class="lb-tab-btn" style="
        flex:1;
        border-radius:999px;
        border:none;
        padding:8px 0;
        font-size:14px;
        font-weight:600;
        background:rgba(15,23,42,0.5);
        color:#9ca3af;
      ">Friends</button>
    </div>

    <div id="lbMySummary" style="
      border-radius:16px;
      padding:10px 12px;
      background:linear-gradient(90deg, rgba(15,23,42,0.95), rgba(30,64,175,0.9));
      margin-bottom:12px;
      font-size:12px;
      display:flex;
      justify-content:space-between;
      gap:8px;
    ">
      <div id="lbMySummaryText">Your rank info will appear here.</div>
    </div>

    <div id="lbOvertakeBanner" style="display:none; margin-bottom:12px;"></div>

    <div id="lbContent" style="
      flex:1;
      overflow-y:auto;
      padding-right:4px;
    ">
    </div>

    <div id="lbFooterInvite" style="
      margin-top:12px;
      font-size:12px;
      opacity:0.9;
      text-align:center;
    ">
      Invite friends from the Friends tab to climb the leaderboard faster.
    </div>
  </div>
`;

document.body.insertAdjacentHTML("beforeend", leaderboardHTML);

const leaderboardScreen = document.getElementById("leaderboardScreen");
const lbCloseBtn = document.getElementById("lbCloseBtn");
const lbTabGlobal = document.getElementById("lbTabGlobal");
const lbTabDaily = document.getElementById("lbTabDaily");
const lbTabFriends = document.getElementById("lbTabFriends");
const lbContent = document.getElementById("lbContent");
const lbMySummary = document.getElementById("lbMySummary");
const lbMySummaryText = document.getElementById("lbMySummaryText");
const lbOvertakeBanner = document.getElementById("lbOvertakeBanner");
const lbFooterInvite = document.getElementById("lbFooterInvite");
function setLeaderboardTabActive(activeKey) {
  const tabs = [
    { key: "global", el: lbTabGlobal },
    { key: "daily", el: lbTabDaily },
    { key: "friends", el: lbTabFriends },
  ];
  tabs.forEach(({ key, el }) => {
    if (!el) return;
    if (key === activeKey) {
      el.style.background = "linear-gradient(135deg,#fbbf24,#fb923c)";
      el.style.color = "#111827";
    } else {
      el.style.background = "rgba(15,23,42,0.7)";
      el.style.color = "#9ca3af";
    }
  });
}

function openLeaderboard(initialTab) {
  if (!leaderboardScreen) return;
  leaderboardScreen.style.display = "flex";
  document.body.style.overflow = "hidden";
  const tab = initialTab || "global";
  if (tab === "friends") {
    setLeaderboardTabActive("friends");
    loadFriendsLeaderboard();
  } else if (tab === "daily") {
    setLeaderboardTabActive("daily");
    loadDailyLeaderboard();
  } else {
    setLeaderboardTabActive("global");
    loadGlobalLeaderboard();
  }
}

function closeLeaderboard() {
  if (!leaderboardScreen) return;
  leaderboardScreen.style.display = "none";
  document.body.style.overflow = "";
}

lbCloseBtn.addEventListener("click", () => {
  closeLeaderboard();
  setActiveTab(tabFarm);
});

function renderMySummary(prefix, rank, total) {
  if (!lbMySummaryText) return;
  if (!rank || !total) {
    lbMySummaryText.textContent = "Play to join the leaderboard.";
    return;
  }
  lbMySummaryText.textContent = `${prefix} #${formatNumber(rank)} of ${formatNumber(total)} players`;
}

function renderList(items, getRank, getName, getValue, highlightTid) {
  if (!lbContent) return;
  if (!Array.isArray(items) || items.length === 0) {
    lbContent.innerHTML = '<div style="padding:24px; text-align:center; opacity:0.7;">No data yet. Start playing to appear here.</div>';
    return;
  }
  let html = "";
  for (const row of items) {
    const rank = getRank(row);
    const name = getName(row) || "Player";
    const value = getValue(row);
    const isMe = highlightTid && Number(row.telegram_id) === Number(highlightTid);
    html += `
      <div style="
        display:flex;
        justify-content:space-between;
        align-items:center;
        padding:10px 12px;
        margin-bottom:8px;
        border-radius:12px;
        background:${isMe ? "rgba(251,191,36,0.15)" : "rgba(15,23,42,0.9)"};
        border:${isMe ? "1px solid rgba(251,191,36,0.8)" : "1px solid rgba(15,23,42,0.9)"};
        font-size:13px;
      ">
        <div>
          <div style="font-weight:600;">#${formatNumber(rank)} · ${name}</div>
        </div>
        <div style="text-align:right; font-variant-numeric:tabular-nums;">
          <div>${formatNumber(value)} pts</div>
        </div>
      </div>
    `;
  }
  lbContent.innerHTML = html;
}

function loadGlobalLeaderboard() {
  lbOvertakeBanner.style.display = "none";
  lbOvertakeBanner.innerHTML = "";
  lbFooterInvite.style.display = "block";
  lbContent.innerHTML = '<div style="padding:24px; text-align:center; opacity:0.7;">Loading global leaderboard…</div>';
  apiPost("/api/leaderboard/global", {}).then((res) => {
    if (!res || !res.ok) {
      lbContent.innerHTML = '<div style="padding:24px; text-align:center; opacity:0.7;">Error loading leaderboard.</div>';
      renderMySummary("Global rank", null, null);
      return;
    }
    const me = res.me || {};
    renderMySummary("Global rank", me.global_rank, me.global_total);
    renderList(
      res.global || [],
      (row) => row.global_rank,
      (row) => row.username || row.first_name || row.last_name,
      (row) => row.balance || 0,
      me.telegram_id
    );
  });
}

function loadDailyLeaderboard() {
  lbOvertakeBanner.style.display = "none";
  lbOvertakeBanner.innerHTML = "";
  lbFooterInvite.style.display = "block";
  lbContent.innerHTML = '<div style="padding:24px; text-align:center; opacity:0.7;">Loading daily ranks…</div>';
  apiPost("/api/leaderboard/daily", {}).then((res) => {
    if (!res || !res.ok) {
      lbContent.innerHTML = '<div style="padding:24px; text-align:center; opacity:0.7;">Error loading daily leaderboard.</div>';
      renderMySummary("Daily rank", null, null);
      return;
    }
    const me = res.me || {};
    renderMySummary("Daily rank", me.daily_rank, me.daily_total);
    renderList(
      res.daily || [],
      (row) => row.daily_rank,
      (row) => row.username || row.first_name || row.last_name,
      (row) => row.today_farmed || 0,
      me.telegram_id
    );
  });
}

function loadFriendsLeaderboard() {
  lbContent.innerHTML = '<div style="padding:24px; text-align:center; opacity:0.7;">Loading friends leaderboard…</div>';
  apiPost("/api/leaderboard/friends", {}).then((res) => {
    if (!res || !res.ok) {
      lbContent.innerHTML = '<div style="padding:24px; text-align:center; opacity:0.7;">Error loading friends leaderboard.</div>';
      renderMySummary("Friends rank", null, null);
      lbOvertakeBanner.style.display = "none";
      lbOvertakeBanner.innerHTML = "";
      lbFooterInvite.style.display = "block";
      return;
    }
    const me = res.me || {};
    renderMySummary("Friends rank", me.friend_rank, (res.friends || []).length);

    if (res.overtake && res.overtake.target_display_name && typeof res.overtake.need_points === "number") {
      lbOvertakeBanner.style.display = "block";
      lbOvertakeBanner.innerHTML = `
        <div style="
          border-radius:16px;
          padding:10px 12px;
          background:linear-gradient(90deg,#fbbf24,#fb923c);
          color:#111827;
          font-size:13px;
          font-weight:600;
          text-align:left;
          margin-bottom:4px;
        ">
          ⭐ Overtake ${res.overtake.target_display_name} by +${formatNumber(res.overtake.need_points)} pts
        </div>
      `;
    } else {
      lbOvertakeBanner.style.display = "none";
      lbOvertakeBanner.innerHTML = "";
    }

    lbFooterInvite.style.display = "block";
    renderList(
      res.friends || [],
      (row) => row.friend_rank,
      (row) => row.username || row.first_name || row.last_name,
      (row) => row.balance || 0,
      me.telegram_id
    );
  });
}

lbTabGlobal.addEventListener("click", () => {
  setLeaderboardTabActive("global");
  loadGlobalLeaderboard();
});

lbTabDaily.addEventListener("click", () => {
  setLeaderboardTabActive("daily");
  loadDailyLeaderboard();
});

lbTabFriends.addEventListener("click", () => {
  setLeaderboardTabActive("friends");
  loadFriendsLeaderboard();
});

// Init
loadStateLocal();
render();
initFromBackend();

// Auto-refresh from backend (energy, rank, etc.)
setInterval(async () => {
  const res = await apiPost("/api/state", {});
  if (res && res.ok) {
    applyBackendState(res);
    render();
  }
}, 15000);
  </script>
</body>
</html>
