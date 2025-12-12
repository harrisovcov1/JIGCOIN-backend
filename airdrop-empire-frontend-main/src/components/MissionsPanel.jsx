// src/components/MissionsPanel.jsx
import React, { useEffect, useState } from "react";
import {
  apiListMissions,
  apiStartMission,
  apiCompleteMission,
  apiRequestAd,
  apiCompleteAd,
} from "../api/missions";

// -------------------- LABELS --------------------
const KIND_LABELS = {
  ad: "Sponsored boosts",
  social: "Social missions",
  offerwall: "Big payout offers",
  pro: "Pro quests",
};

const PAYOUT_LABELS = {
  points: (amt) => `+${amt.toLocaleString()} pts`,
  energy_refill: () => "Full energy refill",
  double_10m: (amt) => `x2 points for ${amt || 10} minutes`,
};

// Convert backend reward into human text
function humanPayout(mission) {
  const fn = PAYOUT_LABELS[mission.payout_type] || (() => "Reward");
  return fn(Number(mission.payout_amount || 0));
}

// UI helper for mission status
function statusBadge(status, rewardApplied) {
  if (rewardApplied) return "✅ Reward claimed";
  if (status === "completed") return "✔ Completed – tap to claim";
  if (status === "started") return "⏳ In progress";
  return null;
}

// -------------------- MAIN COMPONENT --------------------
export default function MissionsPanel({ onUserStateChange }) {
  const [missions, setMissions] = useState([]);
  const [activeKind, setActiveKind] = useState("ad");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [busyCode, setBusyCode] = useState(null);
  const [adBusy, setAdBusy] = useState(false);

  useEffect(() => {
    loadMissions();
  }, [activeKind]);

  // Load missions from backend
  async function loadMissions() {
    try {
      setLoading(true);
      const res = await apiListMissions(activeKind === "all" ? null : activeKind);
      if (res.ok) {
        setMissions(res.missions || []);
      } else {
        setMessage("Could not load missions.");
      }
    } catch (e) {
      console.error(e);
      setMessage("Error loading missions.");
    } finally {
      setLoading(false);
    }
  }

  // Open external links correctly within Telegram
  function openMissionUrl(url) {
    if (!url) return;

    try {
      if (window.Telegram?.WebApp) {
        window.Telegram.WebApp.openLink(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  // START mission
  async function handleStartMission(m) {
    if (!m.code) return;
    setBusyCode(m.code);
    setMessage(null);

    try {
      const res = await apiStartMission(m.code);
      if (!res.ok) {
        setMessage("Could not start mission.");
        return;
      }

      if (res.redirect_url) openMissionUrl(res.redirect_url);

      await loadMissions();
    } catch (e) {
      console.error(e);
      setMessage("Error starting mission.");
    } finally {
      setBusyCode(null);
    }
  }

  // COMPLETE mission
  async function handleCompleteMission(m) {
    if (!m.code) return;
    setBusyCode(m.code);
    setMessage(null);

    try {
      const res = await apiCompleteMission(m.code);
      if (!res.ok) {
        setMessage("Mission not ready to complete.");
        return;
      }

      if (onUserStateChange) onUserStateChange(res);
      setMessage(`🎁 Mission completed! Reward: ${humanPayout(m)}`);

      await loadMissions();
    } catch (e) {
      console.error(e);
      setMessage("Error completing mission.");
    } finally {
      setBusyCode(null);
    }
  }

  // AD BOOST mission
  async function handleWatchAd() {
    setAdBusy(true);
    setMessage(null);

    try {
      const req = await apiRequestAd("energy_refill", 0, "unity-ads");
      if (!req.ok) {
        setMessage("Could not begin ad.");
        setAdBusy(false);
        return;
      }

      const adSessionId = req.ad_session_id;

      // ⚠️ IN REAL VERSION → show Unity or Applovin ad here

      const done = await apiCompleteAd(adSessionId);
      if (!done.ok) {
        setMessage("Ad reward failed.");
        setAdBusy(false);
        return;
      }

      if (onUserStateChange) onUserStateChange(done);
      setMessage("⚡ Energy refilled!");
    } catch (e) {
      console.error(e);
      setMessage("Ad error.");
    } finally {
      setAdBusy(false);
    }
  }

  // Group missions by type
  const grouped = missions.reduce((acc, m) => {
    const kind = m.kind || "other";
    if (!acc[kind]) acc[kind] = [];
    acc[kind].push(m);
    return acc;
  }, {});

  const visibleKinds = activeKind === "all" ? Object.keys(grouped) : [activeKind];

  return (
    <div className="missions-panel">

      {/* 🔵 Tabs */}
      <div className="missions-tabs">
        {["ad", "social", "offerwall", "pro", "all"].map((kind) => (
          <button
            key={kind}
            className={`missions-tab ${activeKind === kind ? "missions-tab-active" : ""}`}
            onClick={() => setActiveKind(kind)}
          >
            {kind === "all" ? "All" : KIND_LABELS[kind]}
          </button>
        ))}
      </div>

      {/* Ad Bonus Button */}
      <div className="missions-ad-test">
        <button className="btn-primary" disabled={adBusy} onClick={handleWatchAd}>
          {adBusy ? "Processing ad…" : "🎥 Watch sponsored ad for boost"}
        </button>
      </div>

      {message && <div className="missions-message">{message}</div>}
      {loading && <div className="missions-loading">Loading missions…</div>}

      {!loading && missions.length === 0 && (
        <div className="missions-empty">No missions available yet.</div>
      )}

      {!loading &&
        visibleKinds.map((kind) => {
          const list = grouped[kind] || [];
          if (!list.length) return null;

          return (
            <div key={kind} className="missions-section">
              <h3 className="missions-section-title">
                {KIND_LABELS[kind] || "Other missions"}
              </h3>

              {list.map((m) => {
                const busy = busyCode === m.code;
                const badge = statusBadge(m.status, m.reward_applied);

                const canStart = m.status === "not_started" || m.status === "started";
                const canComplete =
                  (m.status === "started" || m.status === "completed") &&
                  !m.reward_applied;

                return (
                  <div key={m.code} className="mission-card">

                    <div className="mission-main">
                      <div className="mission-title">{m.title}</div>
                      {m.description && (
                        <div className="mission-desc">{m.description}</div>
                      )}
                    </div>

                    <div className="mission-meta">
                      <div className="mission-reward">{humanPayout(m)}</div>
                      {badge && <div className="mission-status">{badge}</div>}
                    </div>

                    <div className="mission-actions">
                      {canStart && (
                        <button
                          className="btn-secondary"
                          disabled={busy}
                          onClick={() => handleStartMission(m)}
                        >
                          {busy ? "Starting…" : "Start"}
                        </button>
                      )}
                      {canComplete && (
                        <button
                          className="btn-primary"
                          disabled={busy}
                          onClick={() => handleCompleteMission(m)}
                        >
                          {busy ? "Claiming…" : "I’ve completed this"}
                        </button>
                      )}
                      {!canStart && !canComplete && (
                        <button className="btn-disabled" disabled>
                          Done
                        </button>
                      )}
                    </div>

                  </div>
                );
              })}
            </div>
          );
        })}
    </div>
  );
}
