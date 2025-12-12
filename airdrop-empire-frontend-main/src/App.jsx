// src/App.jsx
import React, { useEffect, useState } from "react";
import "./App.css";

import MissionsPanel from "./components/MissionsPanel";
import { apiFetchState } from "./api/missions";

/**
 * Merge whatever the backend returns into UI state shape.
 */
function mergeUserState(prev, payload) {
  if (!payload) return prev;

  // backend may send { state: {...} } or just {...}
  const src = payload.state || payload;

  const next = {
    ...prev,
    ...src,
  };

  // Map backend field names → UI field names
  if (typeof src.balance !== "undefined") {
    next.points = Number(src.balance || 0);
  }
  if (typeof src.max_energy !== "undefined") {
    next.energy_max = Number(src.max_energy || 0);
  }
  if (typeof src.global_rank !== "undefined") {
    next.rank_global = src.global_rank;
  }

  // streak_days will plug straight in once we add it on backend
  if (typeof src.streak_days !== "undefined") {
    next.streak_days = src.streak_days;
  }

  return next;
}


export default function App() {
  const [user, setUser] = useState({
    username: null,
    points: 0,
    energy: 0,
    energy_max: 100,
    rank_global: null,
    streak_days: 0,
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  /**
   * ⭐ NEW STEP: Telegram WebApp init & readiness check
   */
  useEffect(() => {
    if (window.Telegram && window.Telegram.WebApp) {
      const tg = window.Telegram.WebApp;

      // Expand to full screen
      tg.expand();

      // Wait explicitly for Telegram to be ready
      tg.ready();
    }
  }, []);

  /**
   * Load initial user state — now WAIT until Telegram init data exists.
   */
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);

        /**
         * ⭐ Wait until Telegram injects initData
         */
        if (window.Telegram?.WebApp) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }

        const res = await apiFetchState();

        if (!res?.ok) {
          if (!cancelled) setError("Could not load player data.");
          return;
        }

        if (!cancelled) {
          setUser((prev) => mergeUserState(prev, res));
        }
      } catch (e) {
        console.error("Error loading state", e);
        if (!cancelled) setError("Error loading player data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true };
  }, []);

  function handleUserStateChange(payload) {
    setUser((prev) => mergeUserState(prev, payload));
  }

  const energy =
    typeof user.energy === "number" ? user.energy : Number(user.energy || 0);
  const energyMax =
    typeof user.energy_max === "number"
      ? user.energy_max
      : Number(user.energy_max || 100);
  const energyPct = Math.max(
    0,
    Math.min(100, energyMax ? (energy / energyMax) * 100 : 0)
  );

  return (
    <div className="app-root">
      {/* Header */}
      <header className="app-header">
        <div className="app-title-block">
          <h1 className="app-title">AirDrop Empire</h1>
          <p className="app-subtitle">
            Tap, climb, and farm smarter than Hamster, Notcoin &amp; friends 🐹⚡
          </p>
        </div>

        <div className="app-header-stats">
          <div className="stat-chip stat-chip-points">
            <div className="stat-label">Points</div>
            <div className="stat-value">
              {user.points?.toLocaleString?.() ?? user.points ?? 0}
            </div>
          </div>

          <div className="stat-chip stat-chip-energy">
            <div className="stat-label">Energy</div>
            <div className="stat-energy-bar">
              <div
                className="stat-energy-fill"
                style={{ width: `${energyPct}%` }}
              />
            </div>
            <div className="stat-energy-text">
              {energy}/{energyMax}
            </div>
          </div>

          <div className="stat-chip stat-chip-rank">
            <div className="stat-label">Global rank</div>
            <div className="stat-value">
              {user.rank_global
                ? `#${user.rank_global.toLocaleString?.() ?? user.rank_global}`
                : "--"}
            </div>
            {user.streak_days ? (
              <div className="stat-subtext">
                🔥 {user.streak_days}-day streak
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {error && <div className="app-error-banner">{error}</div>}

      <main className="app-main">
        {loading ? (
          <div className="app-loading">Loading your empire…</div>
        ) : (
          <MissionsPanel onUserStateChange={handleUserStateChange} />
        )}
      </main>
    </div>
  );
}
