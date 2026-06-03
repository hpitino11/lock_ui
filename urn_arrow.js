"use strict";

(function () {

	// ─── Constants ────────────────────────────────────────────────────────────
	var URN_FIRST_SPAWN_SEC  = 720;   // 12:00 – first urn
	var URN_INTERVAL_SEC     = 360;   // 6-min cycle
	var UPDATE_RATE          = 1.0;   // seconds between ticks
	var BOOT_DELAY           = 6.0;   // wait for HUD load
	// How long after IdolCashInMeter goes invisible to confirm delivery.
	// Keeps a brief flicker or cancelled-then-retried deposit from false-firing.
	var DELIVERY_CONFIRM_MS  = 1500;

	// ─── State ────────────────────────────────────────────────────────────────
	var s = {
		indicatorPanel:   null,
		indicatorLabel:   null,
		currentCycleIdx:  -2,
		cycleDelivered:   false,
		// Delivery detection via IdolCashInMeter.visible
		meterWasShown:    false,   // meter turned visible at least once this cycle
		deliverConfirmMs: 0,       // >0 while waiting to confirm delivery
		prevMeterVis:     null,    // last observed visibility (for edge detection)
	};

	// ─── Helpers ─────────────────────────────────────────────────────────────

	function now() {
		return Date.now ? Date.now() : (new Date()).getTime();
	}

	function isPanelValid(p) {
		try { return !!(p && p.IsValid && p.IsValid()); }
		catch (e) { return false; }
	}

	function parseClock(text) {
		if (!text) return -1;
		var parts = String(text).split(":");
		if (parts.length === 2) {
			var m   = parseInt(parts[0], 10);
			var sec = parseInt(parts[1], 10);
			if (isFinite(m) && isFinite(sec)) return m * 60 + sec;
		}
		var v = parseFloat(text);
		return isFinite(v) ? Math.max(0, v) : -1;
	}

	function getGameSec(root) {
		try {
			if (typeof Game !== "undefined") {
				if (typeof Game.GetGameTime === "function") {
					var t = Game.GetGameTime();
					if (isFinite(t)) return Math.max(0, t);
				}
				if (isFinite(Game.Time))     return Math.max(0, Game.Time);
				if (isFinite(Game.GameTime)) return Math.max(0, Game.GameTime);
			}
			if (typeof GameUI !== "undefined" && typeof GameUI.GetGameTime === "function") {
				var t2 = GameUI.GetGameTime();
				if (isFinite(t2)) return Math.max(0, t2);
			}
		} catch (e) {}
		if (!root) return -1;
		var clockPanel = root.FindChildTraverse("HudGameTime") || root.FindChildTraverse("GameTime");
		if (clockPanel && clockPanel.text) return Math.max(0, parseClock(clockPanel.text));
		return -1;
	}

	// ─── Delivery detection ───────────────────────────────────────────────────
	//
	// IdolCashInMeter.visible is false at rest.  When a player begins depositing
	// the urn it becomes true (the fill-bar is shown).  It returns to false once
	// the deposit completes (or is cancelled).
	//
	// State machine:
	//   1. meter visible  → set meterWasShown, cancel any pending confirm
	//   2. meter invisible after having been shown → start DELIVERY_CONFIRM_MS timer
	//   3. timer expires with meter still invisible → delivery confirmed
	//   4. meter becomes visible again while cycleDelivered=true → was a false
	//      positive (e.g. carrier died mid-deposit, another player retried).  Reset.

	function tickDelivery(root, nowMs) {
		var meter    = root.FindChildTraverse("IdolCashInMeter");
		var meterVis = isPanelValid(meter) ? meter.visible : false;

		if (!s.cycleDelivered) {

			if (meterVis) {
				s.meterWasShown    = true;
				s.deliverConfirmMs = 0;   // cancel timer while deposit is active
			} else if (s.meterWasShown && s.prevMeterVis === true && s.deliverConfirmMs === 0) {
				// Rising→falling edge: meter just went invisible → start confirm window
				s.deliverConfirmMs = nowMs + DELIVERY_CONFIRM_MS;
			}

			if (s.meterWasShown && s.deliverConfirmMs > 0 && nowMs >= s.deliverConfirmMs) {
				s.cycleDelivered   = true;
				s.meterWasShown    = false;
				s.deliverConfirmMs = 0;
			}

		} else {
			// Already marked delivered.  If the meter reappears this cycle it means
			// the previous "delivery" was actually a cancelled deposit – reset so we
			// can catch the real delivery.
			if (meterVis) {
				s.cycleDelivered   = false;
				s.meterWasShown    = true;
				s.deliverConfirmMs = 0;
			}
		}

		s.prevMeterVis = meterVis;
	}

	// ─── Phase logic ──────────────────────────────────────────────────────────

	function currentPhase(root, gameSec, nowMs) {
		if (gameSec < 0) return null;

		if (gameSec < URN_FIRST_SPAWN_SEC) {
			if (s.currentCycleIdx !== -1) {
				s.currentCycleIdx  = -1;
				s.cycleDelivered   = false;
				s.meterWasShown    = false;
				s.deliverConfirmMs = 0;
				s.prevMeterVis     = null;
			}
			return "yellow";
		}

		var idx       = Math.floor((gameSec - URN_FIRST_SPAWN_SEC) / URN_INTERVAL_SEC);
		var basePhase = (idx % 2 === 0) ? "green" : "yellow";
		var nextPhase = (basePhase === "green") ? "yellow" : "green";

		if (idx !== s.currentCycleIdx) {
			s.currentCycleIdx  = idx;
			s.cycleDelivered   = false;
			s.meterWasShown    = false;
			s.deliverConfirmMs = 0;
			s.prevMeterVis     = null;
		}

		tickDelivery(root, nowMs);

		return s.cycleDelivered ? nextPhase : basePhase;
	}

	// ─── Panel management ─────────────────────────────────────────────────────

	function ensurePanel(root) {
		if (isPanelValid(s.indicatorPanel) && isPanelValid(s.indicatorLabel)) return true;

		var existing = null;
		try { existing = root.FindChildTraverse("UrnArrowIndicator"); } catch (e) {}
		if (isPanelValid(existing)) {
			s.indicatorPanel = existing;
			try { s.indicatorLabel = existing.FindChildTraverse("UrnArrowLabel"); } catch (e) {}
			if (isPanelValid(s.indicatorPanel) && isPanelValid(s.indicatorLabel)) return true;
		}

		var parent = null;
		try {
			var buffHUD = root.FindChildTraverse("BuffHUD");
			if (isPanelValid(buffHUD)) parent = buffHUD.GetParent();
		} catch (e) {}
		if (!isPanelValid(parent)) {
			try { parent = root.FindChildTraverse("CitadelHudTopBar"); } catch (e) {}
		}
		if (!isPanelValid(parent)) return false;

		try { s.indicatorPanel = $.CreatePanel("Panel", parent, "UrnArrowIndicator"); }
		catch (e) { return false; }
		if (!isPanelValid(s.indicatorPanel)) return false;
		s.indicatorPanel.hittest         = false;
		s.indicatorPanel.hittestchildren = false;

		try { s.indicatorLabel = $.CreatePanel("Label", s.indicatorPanel, "UrnArrowLabel"); }
		catch (e) { return false; }
		if (!isPanelValid(s.indicatorLabel)) return false;
		s.indicatorLabel.text = "";

		return true;
	}

	// ─── Main update ──────────────────────────────────────────────────────────

	function update() {
		try {
			var root = $.GetContextPanel();
			if (!root) { $.Schedule(UPDATE_RATE, update); return; }

			var nowMs   = now();
			var gameSec = getGameSec(root);

			if (gameSec < 0) {
				if (isPanelValid(s.indicatorPanel)) s.indicatorPanel.visible = false;
				$.Schedule(UPDATE_RATE, update);
				return;
			}

			if (!ensurePanel(root)) {
				$.Schedule(UPDATE_RATE, update);
				return;
			}

			var phase = currentPhase(root, gameSec, nowMs);
			if (!phase) {
				s.indicatorPanel.visible = false;
				$.Schedule(UPDATE_RATE, update);
				return;
			}

			if (isPanelValid(s.indicatorLabel)) {
				s.indicatorLabel.text        = "●";
				s.indicatorLabel.style.color = (phase === "green") ? "#00e676" : "#ffee00";
			}
			s.indicatorPanel.visible = true;

		} catch (e) {
			$.Msg("[UrnArrow] update error: " + String(e));
		}
		$.Schedule(UPDATE_RATE, update);
	}

	// ─── Boot ─────────────────────────────────────────────────────────────────
	$.Schedule(BOOT_DELAY, update);

})();
