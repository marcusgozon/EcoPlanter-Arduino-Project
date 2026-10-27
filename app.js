/* EcoPlanter website v1.0
 * Offline-friendly demo UI and optional ESP32 HTTP WebServer bridge.
 * Camera image is NOT a live feed; see README.md for firmware contract.
 */
(() => {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const KEY = "ecoplanter-site-v1";
  // Firmware command names for the arm rotation control. Change these to match your ESP32/Arduino code.
  const ARM_ROTATE_COMMAND = "rotate_arms",
    ARM_STOP_COMMAND = "stop_arms";
  const initial = {
    moisture: 34,
    seeds: 24,
    waterEvents: 3,
    battery: 82,
    waterLevel: 76,
    moistureHistory: [53, 51, 48, 50, 46, 45, 43, 42, 39, 42, 38, 34],
    settings: { threshold: 40, waterSeconds: 3, spacing: 15, seedsPerSpot: 1 },
    records: [
      {
        time: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
        event: "Demo initialized",
        detail: "Simulated planting system ready",
        source: "Demo",
      },
      {
        time: new Date(Date.now() - 1000 * 60 * 16).toISOString(),
        event: "Moisture reading",
        detail: "Soil moisture at 34% (simulated)",
        source: "Demo",
      },
      {
        time: new Date(Date.now() - 1000 * 60 * 33).toISOString(),
        event: "Seed dispensed",
        detail: "1 seed release recorded (simulated)",
        source: "Demo",
      },
      {
        time: new Date(Date.now() - 1000 * 60 * 51).toISOString(),
        event: "Watering complete",
        detail: "3-second demo watering event",
        source: "Demo",
      },
    ],
  };
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch (e) {}
  const state = {
    moisture: validNumber(stored.moisture, 34, 0, 100),
    seeds: validNumber(stored.seeds, 24, 0, 100000),
    waterEvents: validNumber(stored.waterEvents, 3, 0, 100000),
    battery: validNumber(stored.battery, 82, 0, 100),
    waterLevel: 76,
    moistureHistory: Array.isArray(stored.moistureHistory)
      ? stored.moistureHistory.slice(-16).map((v) => validNumber(v, 34, 0, 100))
      : initial.moistureHistory.slice(),
    settings: { ...initial.settings, ...(stored.settings || {}) },
    records: Array.isArray(stored.records)
      ? stored.records.slice(0, 200)
      : initial.records.slice(),
    mode: "demo",
    opmode: "automatic",
    running: false,
    step: 0,
    status: "Ready for planting",
    detail: "The robot is idle and waiting for a command.",
    pump: false,
    probe: "Raised",
    seedArm: "Home",
    waterArm: "Home",
    emergency: false,
    socket: null,
    connectionUrl: String(stored.connectionUrl || "http://192.168.4.1"),
    lastMove: null,
    armsRotating: false,
  };
  // ---------- Arm & digger controls (PCA9685 servos on the ESP32) ----------
  // Routes used (all GET, see the firmware): /s?a=&us=  /g?id=  /save?id=&us=  /dig?on=
  // /home  /reset  /stop  /hold?a=  /pump?on=  /v (status poll).
  const ARM_REPS = 8; // keep equal to DIG_REPS in the firmware
  const ARM_AXES = [
    { n: "Base", note: "Turns the tool head. Left faces the watering arm forward, right faces the seeder.", p: [[1, "Left"], [0, "Center"], [2, "Right"]] },
    { n: "Shoulder", note: "Lower joint of the watering arm.", p: [[3, "Home"], [4, "Water"]] },
    { n: "Elbow", note: "Upper joint of the watering arm.", p: [[5, "Up"], [6, "Water"]] },
    { n: "Lift", note: "Raises and lowers the seeder.", p: [[7, "Up"], [8, "Down"]] },
    { n: "Gate", note: "Covers and uncovers the seed hole.", p: [[9, "Closed"], [10, "Open"]] },
    { n: "Dig lower", note: "Lowers the digger a little into the soil.", p: [[11, "Up"], [12, "Down"]] },
    { n: "Dig", note: "Swings left and right to loosen the soil.", p: [[13, "Left"], [14, "Center"], [15, "Right"]], dig: true },
  ];
  // Same defaults as POS_DEFAULT in the firmware (used for Demo Mode and as a fallback).
  const ARM_POS_DEFAULT = [1500, 2300, 700, 1500, 1000, 1500, 1250, 450, 2300, 1500, 1100, 1500, 1200, 1300, 1500, 1700];
  const ARM_HOME = [0, 3, 5, 7, 9, 11, 14]; // preset id each axis returns to on "Home all"
  // Multi-step moves for the older "Aim at target" / "Drop seed" buttons.
  const ARM_SEQUENCES = {
    water_position: [{ path: "/g?id=1" }, { path: "/g?id=4" }, { path: "/g?id=6" }], // base left, shoulder water, elbow water
    seed_position: [{ path: "/g?id=2" }, { path: "/g?id=8" }], // base right, lift down
    seed_drop: [{ path: "/g?id=10" }, { path: "/g?id=9", delay: 900 }], // gate open, then closed
  };
  const arm = {
    vals: ARM_HOME.map((id) => ARM_POS_DEFAULT[id]),
    pos: ARM_POS_DEFAULT.slice(),
    saveMode: false,
    lastInput: 0,
    sent: [],
    digRep: 0,
    link: true,
    fails: 0,
    pollTimer: null,
    demoDig: null,
    waterHold: null,
    pumpUntil: 0,
  };
  let cycleTimer = null,
    pumpTimer = null,
    toastTimer = null;
  const stepNames = [
    "Align with planting location",
    "Measure soil moisture",
    "Position and release seed",
    "Water if dry",
    "Count and finish",
  ];
  const time = (iso) =>
    new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  function validNumber(v, backup, min, max) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : backup;
  }
  function save() {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          moisture: state.moisture,
          seeds: state.seeds,
          waterEvents: state.waterEvents,
          battery: state.battery,
          moistureHistory: state.moistureHistory,
          settings: state.settings,
          records: state.records,
          connectionUrl: state.connectionUrl,
        }),
      );
    } catch (e) {}
  }
  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3300);
  }
  function log(
    event,
    detail,
    source = state.mode === "hardware" ? "Hardware" : "Demo",
  ) {
    state.records.unshift({
      time: new Date().toISOString(),
      event,
      detail,
      source,
    });
    state.records = state.records.slice(0, 200);
    save();
    renderRecords();
    renderActivity();
  }
  function setStatus(title, detail) {
    state.status = title;
    state.detail = detail;
    renderStatus();
  }
  function renderStatus() {
    $("#robotCurrentStatus").textContent = state.status;
    $("#robotCurrentDetail").textContent = state.detail;
    $("#driveState").textContent =
      state.lastMove ||
      (state.armsRotating
        ? "ROTATING ARMS"
        : state.running
          ? "Automatic cycle running"
          : "Idle");
    $("#probePosition").textContent = state.probe;
    $("#seedPosition").textContent = state.seedArm;
    $("#waterPosition").textContent = state.pump
      ? "Pump active"
      : state.waterArm;
    $("#operatingModeText").textContent =
      state.opmode === "automatic"
        ? "Automatic mode enabled"
        : "Manual mode enabled";
    $("#operatingModeDetail").textContent =
      state.opmode === "automatic"
        ? "Ready to follow the planting sequence."
        : "Direct controls are enabled.";
    $$("#cycleSegments span").forEach((el, i) =>
      el.classList.toggle("done", i < state.step),
    );
    $("#cycleProgressLabel").textContent = `${state.step} / 5 stages`;
    $$(".mode-choice").forEach((el) =>
      el.classList.toggle("active", el.dataset.opmode === state.opmode),
    );
    $("#pumpState").textContent = state.pump ? "Watering" : "Standby";
    $("#waterFoot").textContent = state.pump
      ? "Water pump activated"
      : "Awaiting dry-soil check";
    $("#pumpPill").classList.toggle("on", state.pump);
    $("#pumpPill").innerHTML = `<i></i>${state.pump ? "On" : "Off"}`;
    $("#headStartButton").disabled = state.running || state.emergency;
    $("#quickStart").disabled = state.running || state.emergency;
    $("#controlStart").disabled = state.running || state.emergency;
    $$("[data-action], #rotateArms").forEach((b) => {
      b.disabled = state.emergency;
    });
    $("#joystick").classList.toggle("disabled", state.emergency);
    renderArm();
  }
  function renderSummary() {
    $("#moistureNum").textContent = Math.round(state.moisture);
    $("#seedCount").textContent = state.seeds;
    $("#batteryNum").textContent = Math.round(state.battery);
    $("#batteryBar").style.width = `${state.battery}%`;
    const label =
      state.moisture < state.settings.threshold
        ? "DRY SOIL"
        : state.moisture > 75
          ? "WET SOIL"
          : "GOOD MOISTURE";
    $("#moistureState").textContent = label;
    $("#moistureFoot").textContent =
      state.moisture < state.settings.threshold
        ? "Below threshold"
        : "No watering needed";
    $("#recordSeeds").textContent = state.seeds;
    $("#recordWater").textContent = state.waterEvents;
    $("#recordEvents").textContent = state.records.length;
    renderStatus();
    drawChart();
  }
  function drawChart() {
    const arr =
      state.moistureHistory.length > 1 ? state.moistureHistory : [50, 50];
    const points = arr.map(
      (n, i) =>
        `${((i / (arr.length - 1)) * 600).toFixed(1)},${(204 - n * 2.04).toFixed(1)}`,
    );
    $("#chartLine").setAttribute("points", points.join(" "));
    $("#chartArea").setAttribute(
      "d",
      `M0,204 L${points.join(" L")} L600,204 Z`,
    );
  }
  function renderActivity() {
    const target = $("#activityList");
    target.replaceChildren();
    const records = state.records.slice(0, 4);
    if (!records.length) {
      target.textContent = "No activity yet.";
      return;
    }
    records.forEach((item) => {
      const wrapper = document.createElement("div");
      wrapper.className = "activity-item";
      const ico = document.createElement("span");
      ico.className = "activity-icon";
      ico.innerHTML = '<svg class="icon"><use href="#i-clock"/></svg>';
      const content = document.createElement("div");
      content.className = "activity-copy";
      const title = document.createElement("strong");
      title.textContent = item.event;
      const detail = document.createElement("p");
      detail.textContent = item.detail;
      content.append(title, detail);
      const when = document.createElement("time");
      when.className = "activity-time";
      when.textContent = time(item.time);
      wrapper.append(ico, content, when);
      target.append(wrapper);
    });
  }
  function renderRecords() {
    const target = $("#recordsBody");
    target.replaceChildren();
    if (!state.records.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "empty-table";
      td.textContent = "No events recorded yet.";
      tr.append(td);
      target.append(tr);
    }
    state.records.forEach((item) => {
      const tr = document.createElement("tr");
      [
        new Date(item.time).toLocaleString(),
        item.event,
        item.detail,
        item.source,
      ].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        tr.append(cell);
      });
      target.append(tr);
    });
    $("#recordEvents").textContent = state.records.length;
  }
  function renderConnection() {
    const live = state.mode === "hardware";
    $("#hardwareStatus").textContent = live
      ? "Connected to ESP32 HTTP server"
      : "Demo only — no real device connected";
    $("#sidebar-connection").textContent = live
      ? "ESP32 connected"
      : "Demo environment";
    $("#sidebar-connection-detail").textContent = live
      ? arm.link
        ? "Hardware commands enabled"
        : "Not responding. Check the Wi-Fi connection"
      : "No physical robot connected";
    $("#modeTag").textContent = live ? "● HARDWARE CONNECTED" : "● DEMO MODE";
    $("#controlsModeTag").textContent = live
      ? "● HARDWARE CONNECTED"
      : "● DEMO MODE";
    $("#connectButton").disabled = live;
    renderArm();
  }
  function addMoisture(reading) {
    state.moisture = validNumber(reading, state.moisture, 0, 100);
    state.moistureHistory.push(state.moisture);
    state.moistureHistory = state.moistureHistory.slice(-16);
    save();
    renderSummary();
  }
  function setPump(active) {
    state.pump = active;
    renderStatus();
  }
  function canAct() {
    if (state.emergency) {
      toast("Emergency stop active. Reset Demo Mode in Settings.");
      return false;
    }
    return true;
  }
  function httpCommandFor(command, params = {}) {
    // Matches the existing ESP32 WebServer routes: /c?d=<letter>.
    const simple = {
      stop_motion: "s",
      stop: "s",
      emergency_stop: "s",
      move: ({ forward: "f", backward: "b", left: "l", right: "r", pivot_left: "l", pivot_right: "r" })[params.direction],
      water_now: "w",
    };
    if (command === "joystick") {
      const x = Number(params.x) || 0;
      const y = Number(params.y) || 0;
      if (Math.hypot(x, y) < 0.12) return "s";
      if (Math.abs(y) >= Math.abs(x)) return y > 0 ? "f" : "b";
      return x > 0 ? "r" : "l";
    }
    return Object.prototype.hasOwnProperty.call(simple, command) ? simple[command] : null;
  }
  function hwRequest(path, keepalive = false) {
    const sep = path.includes("?") ? "&" : "?";
    // GET requests intentionally use no custom headers. The ESP32 still must return
    // Access-Control-Allow-Origin so browsers can read the response.
    return fetch(`${state.connectionUrl.replace(/\/$/, "")}${path}${sep}_=${Date.now()}`, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      keepalive,
    });
  }
  function hardwareSteps(command, params = {}) {
    if (command === "stop" || command === "emergency_stop") return [{ path: "/stop" }];
    if (command === "stop_arms") return [{ path: "/hold?a=0" }];
    if (command === "rotate_arms") return [{ path: `/g?id=${arm.vals[0] >= 1500 ? 2 : 1}` }];
    if (ARM_SEQUENCES[command]) return ARM_SEQUENCES[command];
    const letter = httpCommandFor(command, params);
    return letter ? [{ path: `/c?d=${encodeURIComponent(letter)}` }] : null;
  }
  function sendHardware(command, params = {}) {
    if (state.mode !== "hardware" || !state.connectionUrl) {
      toast("No physical robot connected.");
      return false;
    }
    const steps = hardwareSteps(command, params);
    if (!steps) {
      toast(`This control (${command}) is not supported by the current HTTP firmware.`);
      return false;
    }
    const isStop = ["stop_motion", "stop", "emergency_stop", "stop_arms"].includes(command);
    const isMove = command === "move" || command === "joystick";
    steps.forEach((step) => {
      const run = () =>
        hwRequest(step.path, isStop)
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
          })
          .catch(() => {
            toast("ESP32 command failed. Check Wi-Fi, IP address and CORS headers.");
            // Best-effort stop request; the ESP32 also has its own movement watchdog.
            if (isMove) hwRequest("/c?d=s", true).catch(() => {});
          });
      if (step.delay) setTimeout(run, step.delay);
      else run();
    });
    return true;
  }
  function hardwareOrDemo(cmd, action) {
    if (!canAct()) return;
    if (state.mode === "hardware") {
      if (sendHardware(cmd)) {
        log("Command sent", cmd, "Hardware");
      }
    } else {
      action();
    }
  }
  function finishDemoCycle() {
    state.running = false;
    state.step = 5;
    state.seedArm = "Home";
    state.waterArm = "Home";
    state.probe = "Raised";
    setStatus("Cycle completed", "One simulated planting cycle finished.");
    log(
      "Cycle completed",
      `Soil: ${Math.round(state.moisture)}%; seeds total: ${state.seeds}`,
    );
    renderSummary();
    toast("Planting cycle completed");
  }
  function autoStep() {
    if (!state.running) return;
    const index = state.step;
    if (index >= 5) {
      clearInterval(cycleTimer);
      cycleTimer = null;
      finishDemoCycle();
      return;
    }
    switch (index) {
      case 0:
        setStatus(
          "Aligning to planting spot",
          "Positioning with calibrated reference markers.",
        );
        log(
          "Robot aligned",
          `Simulated ${state.settings.spacing} cm planting distance`,
        );
        break;
      case 1:
        state.probe = "Lowered";
        setStatus(
          "Checking soil moisture",
          `Soil reading: ${Math.round(state.moisture)}%`,
        );
        log(
          "Soil moisture checked",
          `${Math.round(state.moisture)}% (simulated)`,
        );
        break;
      case 2:
        state.probe = "Raised";
        state.seedArm = "Targeted";
        state.seeds += state.settings.seedsPerSpot;
        setStatus(
          "Dispensing seed",
          `${state.settings.seedsPerSpot} seed release command(s) simulated.`,
        );
        log(
          "Seed dispensed",
          `${state.settings.seedsPerSpot} release command(s); actual passage unverified`,
        );
        break;
      case 3:
        state.seedArm = "Home";
        state.waterArm = "Targeted";
        if (state.moisture < state.settings.threshold) {
          state.pump = true;
          state.waterEvents++;
          addMoisture(Math.min(100, state.moisture + 6));
          setStatus(
            "Watering the planting spot",
            `${state.settings.waterSeconds}-second simulated watering command.`,
          );
          log(
            "Watering activated",
            `${state.settings.waterSeconds} seconds (simulated)`,
          );
        } else {
          state.pump = false;
          setStatus(
            "Watering skipped",
            "The moisture is above the dry-soil threshold.",
          );
          log(
            "Watering skipped",
            "Soil moisture sufficient for configured threshold",
          );
        }
        break;
      case 4:
        state.pump = false;
        state.waterArm = "Home";
        state.battery = Math.max(0, state.battery - 1);
        setStatus(
          "Updating planting record",
          "Finalizing simulated counter and activity.",
        );
        log("Counter updated", `${state.seeds} total seed release commands`);
        break;
    }
    state.step++;
    save();
    renderSummary();
  }
  function startAuto() {
    if (!canAct() || state.running) return;
    if (state.opmode !== "automatic") {
      toast("Switch to Automatic Mode to start a cycle.");
      return;
    }
    if (state.mode === "hardware") {
      if (sendHardware("start_auto")) {
        state.running = true;
        state.step = 0;
        setStatus("Start command sent", "Waiting for ESP32 telemetry.");
        log(
          "Automatic start requested",
          "Command delivered to connected robot",
          "Hardware",
        );
      }
      return;
    }
    state.running = true;
    state.step = 0;
    log("Automatic cycle started", "Demo simulation sequence");
    autoStep();
    cycleTimer = setInterval(autoStep, 2200);
    toast("Simulated planting cycle started");
  }
  // ---------- Arm & digger controls: logic ----------
  function armLockReason() {
    if (state.emergency) return "Emergency stop active. Reset Demo Mode in Settings.";
    if (state.running) return "Stop the running cycle to use the arm controls.";
    if (state.opmode !== "manual") return "Select Manual Mode to move the arm.";
    return "";
  }
  function renderArm() {
    if (!$("#armAxes")) return;
    const reason = armLockReason();
    const locked = !!reason;
    const live = state.mode === "hardware";
    $("#armLock").hidden = !locked;
    $("#armLock").textContent = reason;
    $$("#armAxes button, #armAxes input, #armSaveMode, #armHome, #armReset, #armWater").forEach((el) => {
      el.disabled = locked;
    });
    const badge = $("#armLink");
    badge.textContent = !live ? "Demo" : arm.link ? "Live" : "No signal";
    badge.classList.toggle("live", live && arm.link);
    badge.classList.toggle("bad", live && !arm.link);
    $("#armPanel").classList.toggle("saving", arm.saveMode);
    $("#armSaveMode").textContent = arm.saveMode
      ? "Save mode is on. Tap a preset to store the slider position."
      : "Save mode is off";
    $("#armSaveMode").setAttribute("aria-pressed", String(arm.saveMode));
    const dig = $("#armDig");
    if (dig) {
      dig.classList.toggle("on", arm.digRep > 0);
      dig.textContent = arm.digRep > 0 ? `Digging ${arm.digRep} of ${ARM_REPS}. Tap to stop` : `Dig ${ARM_REPS} times`;
    }
    $("#armWater").classList.toggle("held", !!arm.waterHold);
    $("#armWaterLabel").textContent = arm.waterHold ? "Watering" : "Hold to water";
  }
  function armRenderPos() {
    arm.pos.forEach((v, id) => {
      const el = $(`#armP${id}`);
      if (el) el.textContent = v;
    });
  }
  function armSetValue(i, v) {
    v = Math.min(2400, Math.max(450, Number(v) || 1500));
    arm.vals[i] = v;
    const s = $(`#armS${i}`);
    if (s) s.value = v;
    const o = $(`#armV${i}`);
    if (o) o.textContent = v;
  }
  function armNoteLink(ok) {
    const was = arm.link;
    if (ok) arm.fails = 0;
    else arm.fails++;
    arm.link = ok || arm.fails < 3;
    if (was !== arm.link) {
      renderArm();
      renderConnection();
      if (!arm.link) toast("ESP32 is not responding. Check the Wi-Fi connection.");
    }
  }
  function armApi(path, keepalive = false) {
    if (state.mode !== "hardware") return Promise.resolve("");
    return hwRequest(path, keepalive)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        armNoteLink(true);
        return r.text();
      })
      .catch(() => {
        armNoteLink(false);
        return "";
      });
  }
  function armSend(i, v, force) {
    const now = Date.now();
    if (!force && now - (arm.sent[i] || 0) <= 70) return;
    arm.sent[i] = now;
    if (i === 6 && arm.demoDig) armDemoDigStop(false);
    if (state.mode === "hardware") armApi(`/s?a=${i}&us=${v}`);
  }
  function armPreset(i, id, label) {
    if (arm.saveMode) {
      const v = arm.vals[i];
      const done = () => {
        arm.pos[id] = v;
        armRenderPos();
        toast(`Saved ${ARM_AXES[i].n} ${label} = ${v}`);
      };
      if (state.mode === "hardware") armApi(`/save?id=${id}&us=${v}`).then((t) => t && done());
      else done();
      return;
    }
    arm.lastInput = Date.now();
    if (state.mode === "hardware") {
      armApi(`/g?id=${id}`).then((t) => t && armSetValue(i, t));
    } else {
      if (i === 6 && arm.demoDig) armDemoDigStop(false);
      armSetValue(i, arm.pos[id]);
    }
  }
  function armDemoDigStop(toCenter) {
    clearInterval(arm.demoDig);
    arm.demoDig = null;
    arm.digRep = 0;
    if (toCenter) armSetValue(6, arm.pos[14]);
    renderArm();
  }
  function armDemoDigStart() {
    let swings = 0;
    let left = true;
    arm.digRep = 1;
    armSetValue(6, arm.pos[13]);
    arm.demoDig = setInterval(() => {
      swings++;
      if (swings >= ARM_REPS * 2) {
        armDemoDigStop(true);
        toast("Demo dig finished");
        return;
      }
      left = !left;
      armSetValue(6, left ? arm.pos[13] : arm.pos[15]);
      arm.digRep = Math.floor(swings / 2) + 1;
      renderArm();
    }, 450);
    renderArm();
  }
  function armDig() {
    if (state.mode === "hardware") {
      const on = arm.digRep === 0;
      log("Arm command sent", on ? `dig ${ARM_REPS} times` : "dig stop", "Hardware");
      armApi(`/dig?on=${on ? 1 : 0}`).then(() => setTimeout(() => armPoll(), 150));
      return;
    }
    if (arm.demoDig) armDemoDigStop(true);
    else armDemoDigStart();
  }
  function armHome() {
    if (state.mode === "hardware") {
      armApi("/home").then((t) => {
        if (!t) return;
        log("Arm command sent", "home all", "Hardware");
        toast("Moving to home");
        armPoll(true);
      });
      return;
    }
    if (arm.demoDig) armDemoDigStop(false);
    ARM_HOME.forEach((id, i) => armSetValue(i, arm.pos[id]));
    toast("Demo: arm moved to home");
  }
  function armReset() {
    if (!confirm("Reset all saved arm positions to the defaults?")) return;
    if (state.mode === "hardware") {
      armApi("/reset").then((t) => {
        if (!t) return;
        toast("Saved positions reset");
        armPoll(true);
      });
      return;
    }
    arm.pos = ARM_POS_DEFAULT.slice();
    armRenderPos();
    toast("Saved positions reset");
  }
  function armPoll(force) {
    if (state.mode !== "hardware") return Promise.resolve();
    return armApi("/v").then((t) => {
      if (!t || state.mode !== "hardware") return;
      const p = t.split("|");
      if (p.length < 4) return;
      const targets = p[0].split(",").map(Number);
      const saved = p[1].split(",").map(Number);
      if (force === true || Date.now() - arm.lastInput > 1500) targets.forEach((v, i) => armSetValue(i, v));
      saved.forEach((v, id) => {
        arm.pos[id] = v;
      });
      armRenderPos();
      const pumpOn = p[2] === "1";
      if (pumpOn !== state.pump && Date.now() > arm.pumpUntil) setPump(pumpOn);
      arm.digRep = Number(p[3]) || 0;
      renderArm();
    });
  }
  function armPollLoop(first) {
    clearTimeout(arm.pollTimer);
    if (state.mode !== "hardware") return;
    armPoll(first === true).then(() => {
      if (state.mode === "hardware") arm.pollTimer = setTimeout(armPollLoop, arm.digRep > 0 ? 500 : 1500);
    });
  }
  function armWaterTick() {
    if (state.mode === "hardware") armApi("/pump?on=1");
  }
  function armWaterStart() {
    if (arm.waterHold || armLockReason()) return false;
    arm.waterHold = setInterval(armWaterTick, 400);
    armWaterTick();
    arm.pumpUntil = Date.now() + 1000;
    setPump(true);
    if (state.mode !== "hardware") state.waterEvents++;
    log("Manual watering", state.mode === "hardware" ? "Hold-to-water pump on" : "Simulated hold-to-water", state.mode === "hardware" ? "Hardware" : "Demo");
    renderSummary();
    renderArm();
    return true;
  }
  function armWaterStop() {
    if (!arm.waterHold) return;
    clearInterval(arm.waterHold);
    arm.waterHold = null;
    arm.pumpUntil = Date.now() + 1000;
    if (state.mode === "hardware") {
      armApi("/pump?on=0", true);
      setTimeout(() => armApi("/pump?on=0", true), 150);
    }
    setPump(false);
    renderArm();
  }
  function armOnStop() {
    armWaterStop();
    if (arm.demoDig) armDemoDigStop(false);
    if (state.mode === "hardware") {
      arm.digRep = 0;
      setTimeout(() => armPoll(true), 250);
    }
    renderArm();
  }
  function buildArm() {
    const host = $("#armAxes");
    ARM_AXES.forEach((a, i) => {
      const card = document.createElement("section");
      card.className = "arm-card";
      card.innerHTML =
        `<div class="arm-card-head"><div><h3>${a.n}</h3><p>${a.note}</p></div><output id="armV${i}">${arm.vals[i]}</output></div>` +
        `<div class="arm-slider-row"><button type="button" class="arm-step" aria-label="${a.n} lower">&minus;</button>` +
        `<input type="range" id="armS${i}" min="450" max="2400" step="10" value="${arm.vals[i]}" aria-label="${a.n} position"/>` +
        `<button type="button" class="arm-step" aria-label="${a.n} higher">+</button></div><div class="arm-presets"></div>`;
      host.appendChild(card);
      const slider = card.querySelector("input");
      const steps = card.querySelectorAll(".arm-step");
      slider.addEventListener("input", () => {
        arm.lastInput = Date.now();
        armSetValue(i, slider.value);
        armSend(i, arm.vals[i], false);
      });
      slider.addEventListener("change", () => armSend(i, arm.vals[i], true));
      [-10, 10].forEach((delta, k) => {
        steps[k].addEventListener("click", () => {
          arm.lastInput = Date.now();
          armSetValue(i, arm.vals[i] + delta);
          armSend(i, arm.vals[i], true);
        });
      });
      const presets = card.querySelector(".arm-presets");
      a.p.forEach(([id, label]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "arm-preset";
        b.innerHTML = `${label}<small id="armP${id}">${arm.pos[id]}</small>`;
        b.addEventListener("click", () => armPreset(i, id, label));
        presets.appendChild(b);
      });
      if (a.dig) {
        const g = document.createElement("button");
        g.type = "button";
        g.id = "armDig";
        g.className = "arm-dig";
        g.textContent = `Dig ${ARM_REPS} times`;
        g.addEventListener("click", armDig);
        card.appendChild(g);
      }
    });
  }
  function bindArm() {
    buildArm();
    $("#armSaveMode").addEventListener("click", () => {
      arm.saveMode = !arm.saveMode;
      renderArm();
    });
    $("#armHome").addEventListener("click", armHome);
    $("#armReset").addEventListener("click", armReset);
    $("#armStop").addEventListener("click", stopAction);
    const water = $("#armWater");
    water.addEventListener("pointerdown", (evt) => {
      evt.preventDefault();
      try {
        water.setPointerCapture(evt.pointerId);
      } catch (e) {}
      armWaterStart();
    });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((name) =>
      water.addEventListener(name, armWaterStop),
    );
    water.addEventListener("contextmenu", (evt) => evt.preventDefault());
    window.addEventListener("blur", armWaterStop);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) armWaterStop();
    });
    renderArm();
  }
  function stopMotion() {
    if (state.mode === "hardware" && state.lastMove)
      sendHardware("stop_motion");
    state.lastMove = null;
    renderStatus();
  }
  function startArmRotation() {
    if (!canAct()) return false;
    if (state.running) {
      toast("Stop the running cycle first.");
      return false;
    }
    if (state.opmode !== "manual") {
      toast("Select Manual Mode to rotate the arms.");
      return false;
    }
    if (state.armsRotating) return true;
    if (state.mode === "hardware") {
      if (!sendHardware(ARM_ROTATE_COMMAND)) return false;
      log("Arm command sent", ARM_ROTATE_COMMAND, "Hardware");
    } else {
      log("Arms rotating", "Simulated arm rotation (press and hold)");
      toast("Demo: rotating arms");
    }
    state.armsRotating = true;
    renderStatus();
    return true;
  }
  function stopArmRotation() {
    if (!state.armsRotating) return;
    state.armsRotating = false;
    if (state.mode === "hardware") {
      sendHardware(ARM_STOP_COMMAND);
      setTimeout(() => armPoll(true), 250);
    }
    renderStatus();
  }
  function stopAction() {
    if (state.mode === "hardware") {
      sendHardware("stop");
      log("Stop requested", "Stop command sent", "Hardware");
    }
    clearInterval(cycleTimer);
    cycleTimer = null;
    clearTimeout(pumpTimer);
    pumpTimer = null;
    state.running = false;
    state.pump = false;
    state.lastMove = null;
    state.armsRotating = false;
    state.seedArm = "Home";
    state.waterArm = "Home";
    state.probe = "Raised";
    armOnStop();
    setStatus("Stopped", "Waiting for the next command.");
    renderSummary();
    toast("Action stopped");
  }
  function emergencyStop() {
    if (state.mode === "hardware") sendHardware("emergency_stop");
    clearInterval(cycleTimer);
    cycleTimer = null;
    clearTimeout(pumpTimer);
    pumpTimer = null;
    state.running = false;
    state.pump = false;
    state.lastMove = null;
    state.armsRotating = false;
    state.emergency = true;
    state.step = 0;
    armOnStop();
    setStatus(
      "EMERGENCY STOP",
      "Controls locked. Physical hardware must implement its own safe shutdown.",
    );
    log("Emergency stop", "Local commands disabled; hardware stop requested");
    renderSummary();
    toast("Emergency stop activated");
  }
  function waterDemo() {
    if (!canAct() || state.running) return;
    if (state.mode === "hardware") {
      hardwareOrDemo("water_now", () => {});
      return;
    }
    clearTimeout(pumpTimer);
    state.waterArm = "Targeted";
    setPump(true);
    state.waterEvents++;
    log(
      "Manual watering",
      `Simulated watering for ${state.settings.waterSeconds} seconds`,
    );
    setStatus("Watering selected spot", "Pump active in demo simulation.");
    renderSummary();
    pumpTimer = setTimeout(() => {
      state.pump = false;
      state.waterArm = "Home";
      addMoisture(Math.min(100, state.moisture + 6));
      setStatus("Watering finished", "Watering simulation completed.");
      renderSummary();
    }, state.settings.waterSeconds * 1000);
  }
  function manualAction(name) {
    if (!canAct()) return;
    if (state.running) {
      toast("Stop the running cycle first.");
      return;
    }
    if (state.opmode !== "manual") {
      toast("Select Manual Mode to use arm controls.");
      return;
    }
    if (state.mode === "hardware") {
      if (sendHardware(name)) {
        log("Arm command sent", name, "Hardware");
        if (name === "seed_position") state.seedArm = "Targeted";
        if (name === "water_position") state.waterArm = "Targeted";
        if (name === "seed_drop") {
          state.seeds += state.settings.seedsPerSpot;
          save();
          renderSummary();
        }
        arm.lastInput = 0;
        setTimeout(() => armPoll(true), 300);
        renderStatus();
      }
      return;
    }
    if (name === "seed_position") {
      state.seedArm = "Targeted";
      log("Seed arm positioned", "Aiming at calibrated soil spot");
    } else if (name === "seed_drop") {
      state.seeds += state.settings.seedsPerSpot;
      log(
        "Seed dispensed",
        `${state.settings.seedsPerSpot} simulated release command(s)`,
      );
    } else if (name === "water_position") {
      state.waterArm = "Targeted";
      log("Water nozzle positioned", "Aiming at selected soil spot");
    } else if (name === "water_now") {
      waterDemo();
      return;
    } else if (name === "probe_raise") {
      state.probe = "Raised";
      log("Soil probe raised", "Sensor retracted");
    } else if (name === "probe_check") {
      state.probe = "Lowered";
      log("Soil probe checked", `Simulated moisture ${state.moisture}%`);
    }
    save();
    renderSummary();
    toast("Demo command completed");
  }
  function move(direction) {
    if (!canAct()) return;
    if (state.opmode !== "manual") {
      toast("Select Manual Mode to drive.");
      return;
    }
    if (state.running) {
      toast("Stop the running cycle first.");
      return;
    }
    state.lastMove = direction.toUpperCase();
    if (state.mode === "hardware") {
      sendHardware("move", { direction });
      return;
    }
    log("Drive control", `Simulated movement: ${direction}`);
    renderStatus();
    toast(`Demo movement: ${direction}`);
  }
  function updateTheme() {
    const dark = document.body.classList.toggle("dark");
    $("#themeButton").innerHTML = dark
      ? '<svg class="icon"><use href="#i-sun"/></svg>'
      : '<svg class="icon"><use href="#i-moon"/></svg>';
    try {
      localStorage.setItem("ecoplanter-theme", dark ? "dark" : "light");
    } catch (e) {}
  }
  function routeTo(name) {
    const names = [
      "home",
      "dashboard",
      "controls",
      "records",
      "settings",
      "about",
    ];
    if (!names.includes(name)) name = "dashboard";
    $$(".page").forEach((el) =>
      el.classList.toggle("active", el.dataset.page === name),
    );
    $$(".nav-link").forEach((el) =>
      el.classList.toggle("selected", el.dataset.route === name),
    );
    const labels = {
      home: "Home",
      dashboard: "Dashboard",
      controls: "Robot Controls",
      records: "Planting Records",
      settings: "Settings",
      about: "About EcoPlanter",
    };
    $("#breadcrumbName").textContent = labels[name];
    document.title = `${labels[name]} | EcoPlanter`;
    $("#sidebar").classList.remove("open");
    $("#mobileBackdrop").hidden = true;
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function renderSettings() {
    $("#thresholdRange").value = state.settings.threshold;
    $("#thresholdValue").textContent = state.settings.threshold + "%";
    $("#wateringRange").value = state.settings.waterSeconds;
    $("#wateringValue").textContent = state.settings.waterSeconds + "s";
    $("#spacingInput").value = String(state.settings.spacing);
    $("#seedsInput").value = String(state.settings.seedsPerSpot);
    $("#wsUrl").value = state.connectionUrl;
  }
  async function connectHardware() {
    if (state.mode === "hardware") return;
    const address = $("#wsUrl").value.trim().replace(/\/$/, "");
    if (!/^https?:\/\//i.test(address)) {
      toast("Enter the ESP32 HTTP address, e.g. http://192.168.4.1");
      return;
    }
    if (location.protocol === "https:" && address.startsWith("http://")) {
      toast("An HTTPS-hosted site cannot normally call the ESP32 over plain HTTP. Open the site locally over HTTP on the same Wi-Fi.");
      return;
    }
    state.connectionUrl = address;
    save();
    $("#hardwareStatus").textContent = "Checking ESP32 HTTP server…";
    try {
      // /p is the existing firmware heartbeat/ping endpoint.
      const response = await fetch(`${address}/p?_=${Date.now()}`, { method: "GET", mode: "cors", cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.mode = "hardware";
      state.emergency = false;
      state.running = false;
      clearInterval(cycleTimer);
      cycleTimer = null;
      setStatus("Hardware connected", "ESP32 HTTP server reachable. Only supported controls are enabled.");
      arm.fails = 0;
      arm.link = true;
      renderConnection();
      armPollLoop(true);
      log("ESP32 connected", address, "Hardware");
      toast("Connected to ESP32 HTTP server");
    } catch (e) {
      state.mode = "demo";
      renderConnection();
      $("#hardwareStatus").textContent = "Connection failed — check ESP32 Wi-Fi and CORS";
      toast("Could not reach ESP32. Join its Wi-Fi and enable CORS in the firmware.");
    }
  }
  function disconnect() {
    armWaterStop();
    clearTimeout(arm.pollTimer);
    arm.digRep = 0;
    if (state.mode === "hardware") {
      // Best-effort stop before returning to demo mode.
      sendHardware("stop_motion");
    }
    state.mode = "demo";
    state.running = false;
    state.pump = false;
    state.lastMove = null;
    state.armsRotating = false;
    state.emergency = false;
    setStatus(
      "Ready for planting",
      "Demo Mode active. No real robot connected.",
    );
    renderConnection();
    renderSummary();
    toast("Returned to Demo Mode");
  }
  function exportCsv() {
    const rows = [
      ["Timestamp", "Event", "Details", "Source"],
      ...state.records.map((i) => [i.time, i.event, i.detail, i.source]),
    ];
    const body = rows
      .map((row) =>
        row.map((x) => '"' + String(x).replace(/"/g, '""') + '"').join(","),
      )
      .join("\r\n");
    const blob = new Blob(["\ufeff" + body], {
        type: "text/csv;charset=utf-8",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "EcoPlanter_planting_records.csv";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("CSV records downloaded");
  }
  function resetDemo() {
    if (state.mode === "hardware") {
      toast("Disconnect hardware before resetting demo.");
      return;
    }
    clearInterval(cycleTimer);
    clearTimeout(pumpTimer);
    state.running = false;
    state.step = 0;
    state.pump = false;
    state.emergency = false;
    state.probe = "Raised";
    state.seedArm = "Home";
    state.waterArm = "Home";
    state.seeds = 24;
    state.waterEvents = 3;
    state.battery = 82;
    state.moisture = 34;
    state.moistureHistory = initial.moistureHistory.slice();
    state.records = initial.records.slice();
    setStatus("Ready for planting", "Demo reset to starting values.");
    save();
    renderAll();
    toast("Demo data reset");
  }
  function renderAll() {
    renderSettings();
    renderConnection();
    renderSummary();
    renderRecords();
    renderActivity();
  }
  function bind() {
    $$("[data-route]").forEach((el) =>
      el.addEventListener("click", (evt) => {
        evt.preventDefault();
        const name = el.dataset.route;
        if (location.hash !== `#${name}`) location.hash = name;
        else routeTo(name);
      }),
    );
    window.addEventListener("hashchange", () =>
      routeTo(location.hash.slice(1)),
    );
    $("#menuButton").addEventListener("click", () => {
      $("#sidebar").classList.add("open");
      $("#mobileBackdrop").hidden = false;
    });
    $("#mobileBackdrop").addEventListener("click", () => {
      $("#sidebar").classList.remove("open");
      $("#mobileBackdrop").hidden = true;
    });
    $("#themeButton").addEventListener("click", updateTheme);
    $("#headStartButton").addEventListener("click", startAuto);
    $("#quickStart").addEventListener("click", startAuto);
    $("#controlStart").addEventListener("click", startAuto);
    $("#controlStop").addEventListener("click", stopAction);
    $("#emergencyStop").addEventListener("click", emergencyStop);
    $("#quickWater").addEventListener("click", () =>
      hardwareOrDemo("water_now", waterDemo),
    );
    $$(".mode-choice").forEach((el) =>
      el.addEventListener("click", () => {
        if (state.running) {
          toast("Stop the current cycle before changing modes.");
          return;
        }
        state.opmode = el.dataset.opmode;
        // The current HTTP firmware has no set_mode endpoint; this only changes
        // which website controls are allowed locally.
        renderStatus();
        toast(
          `${state.opmode === "manual" ? "Manual" : "Automatic"} mode selected`,
        );
      }),
    );
    $$("[data-action]").forEach((el) =>
      el.addEventListener("click", () => manualAction(el.dataset.action)),
    );
    // Joystick: drag for proportional speed + steering. While held it sends
    // {x, y} (each -1..1, y up) about every 80 ms, which doubles as a heartbeat.
    const joy = $("#joystick");
    const joyKnob = $("#joystickKnob");
    const JOY_DEADZONE = 0.12;
    const JOY_SEND_MS = 80;
    const keysDown = new Set();
    let joyVec = { x: 0, y: 0 };
    let joyPointer = null;
    let joyTimer = null;
    let joyEngaged = false;
    const joyRadius = () => (joy.clientWidth - joyKnob.offsetWidth) / 2;
    function joyLabel(x, y) {
      if (Math.hypot(x, y) < JOY_DEADZONE) return null;
      const v = Math.abs(y) < 0.35 ? "" : y > 0 ? "FORWARD" : "BACKWARD";
      const h = Math.abs(x) < 0.35 ? "" : x > 0 ? "RIGHT" : "LEFT";
      if (v && h) return `${v}-${h}`;
      if (v || h) return v || h;
      return Math.abs(y) >= Math.abs(x)
        ? y > 0
          ? "FORWARD"
          : "BACKWARD"
        : x > 0
          ? "RIGHT"
          : "LEFT";
    }
    function setJoyVec(x, y) {
      const mag = Math.hypot(x, y);
      if (mag > 1) {
        x /= mag;
        y /= mag;
      }
      joyVec = { x, y };
      const r = joyRadius();
      joyKnob.style.setProperty("--jx", `${x * r}px`);
      joyKnob.style.setProperty("--jy", `${-y * r}px`);
    }
    function joyAllowed() {
      if (!canAct()) return false;
      if (state.opmode !== "manual") {
        toast("Select Manual Mode to drive.");
        return false;
      }
      if (state.running) {
        toast("Stop the running cycle first.");
        return false;
      }
      return true;
    }
    function joyTick() {
      if (state.emergency || state.running) {
        endJoystick();
        return;
      }
      const active = Math.hypot(joyVec.x, joyVec.y) >= JOY_DEADZONE;
      const x = active ? Math.round(joyVec.x * 100) / 100 : 0;
      const y = active ? Math.round(joyVec.y * 100) / 100 : 0;
      state.lastMove = joyLabel(joyVec.x, joyVec.y);
      renderStatus();
      if (state.mode === "hardware") sendHardware("joystick", { x, y });
    }
    function startJoystick() {
      if (joyEngaged) return true;
      if (!joyAllowed()) return false;
      joyEngaged = true;
      joy.classList.add("active");
      joyTimer = setInterval(joyTick, JOY_SEND_MS);
      return true;
    }
    function endJoystick() {
      if (!joyEngaged) return;
      joyEngaged = false;
      clearInterval(joyTimer);
      joyTimer = null;
      joyPointer = null;
      joy.classList.remove("active");
      setJoyVec(0, 0);
      if (state.mode === "hardware") sendHardware("stop_motion");
      state.lastMove = null;
      renderStatus();
    }
    function releaseJoystick() {
      keysDown.clear();
      endJoystick();
    }
    function dragJoystick(evt) {
      const rect = joy.getBoundingClientRect();
      const r = joyRadius() || 1;
      const dx = evt.clientX - (rect.left + rect.width / 2);
      const dy = evt.clientY - (rect.top + rect.height / 2);
      setJoyVec(dx / r, -dy / r);
    }
    joy.addEventListener("pointerdown", (evt) => {
      evt.preventDefault();
      if (joyPointer !== null || keysDown.size) return;
      if (!startJoystick()) return;
      joyPointer = evt.pointerId;
      joy.setPointerCapture(evt.pointerId);
      dragJoystick(evt);
      joyTick();
    });
    joy.addEventListener("pointermove", (evt) => {
      if (evt.pointerId === joyPointer) dragJoystick(evt);
    });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((name) =>
      joy.addEventListener(name, (evt) => {
        if (evt.pointerId === joyPointer) endJoystick();
      }),
    );
    $("#pivotLeft").addEventListener("click", () => {
      move("pivot_left");
      stopMotion();
    });
    $("#pivotRight").addEventListener("click", () => {
      move("pivot_right");
      stopMotion();
    });
    const rotateBtn = $("#rotateArms");
    rotateBtn.addEventListener("pointerdown", (evt) => {
      evt.preventDefault();
      rotateBtn.setPointerCapture(evt.pointerId);
      if (startArmRotation()) rotateBtn.classList.add("held");
    });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((name) =>
      rotateBtn.addEventListener(name, () => {
        rotateBtn.classList.remove("held");
        stopArmRotation();
      }),
    );

    // Desktop keyboard mapping: arrow keys push the joystick (hold to move, release to stop).
    const KEY_AXES = {
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    function keysToStick() {
      let x = 0;
      let y = 0;
      keysDown.forEach((k) => {
        x += KEY_AXES[k][0];
        y += KEY_AXES[k][1];
      });
      if (x && y) {
        x *= Math.SQRT1_2;
        y *= Math.SQRT1_2;
      }
      setJoyVec(x, y);
      joyTick();
    }
    document.addEventListener("keydown", (evt) => {
      if (
        !KEY_AXES[evt.key] ||
        evt.ctrlKey ||
        evt.metaKey ||
        evt.altKey ||
        evt.shiftKey
      )
        return;
      if (!$("#page-controls").classList.contains("active")) return;
      if (
        evt.target instanceof Element &&
        evt.target.closest('input,select,textarea,[contenteditable="true"]')
      )
        return;
      evt.preventDefault();
      if (evt.repeat || joyPointer !== null) return;
      if (!startJoystick()) return;
      keysDown.add(evt.key);
      keysToStick();
    });
    document.addEventListener("keyup", (evt) => {
      if (!keysDown.delete(evt.key)) return;
      if (keysDown.size) keysToStick();
      else endJoystick();
    });
    window.addEventListener("blur", releaseJoystick);
    window.addEventListener("hashchange", releaseJoystick);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        releaseJoystick();
        rotateBtn.classList.remove("held");
        stopArmRotation();
      }
    });
    $("#exportCsv").addEventListener("click", exportCsv);
    $("#clearRecords").addEventListener("click", () => {
      if (!confirm("Clear the saved activity history in this browser?")) return;
      state.records = [];
      save();
      renderRecords();
      renderActivity();
      toast("Activity history cleared");
    });
    $("#thresholdRange").addEventListener(
      "input",
      (e) => ($("#thresholdValue").textContent = e.target.value + "%"),
    );
    $("#wateringRange").addEventListener(
      "input",
      (e) => ($("#wateringValue").textContent = e.target.value + "s"),
    );
    $("#saveSettings").addEventListener("click", () => {
      state.settings.threshold = validNumber(
        $("#thresholdRange").value,
        40,
        15,
        75,
      );
      state.settings.waterSeconds = validNumber(
        $("#wateringRange").value,
        3,
        1,
        10,
      );
      state.settings.spacing = Number($("#spacingInput").value);
      state.settings.seedsPerSpot = Number($("#seedsInput").value);
      save();
      renderSummary();
      log("Settings updated", "Planting preferences saved in browser");
      toast("Settings saved");
    });
    $("#connectButton").addEventListener("click", connectHardware);
    $("#disconnectButton").addEventListener("click", disconnect);
    $("#applyMoisture").addEventListener("click", () => {
      if (state.mode === "hardware") {
        toast("Demo readings unavailable while hardware is connected.");
        return;
      }
      addMoisture(Number($("#demoMoisture").value));
      log("Demo soil changed", `Reading set to ${state.moisture}%`);
      toast(`Simulated soil moisture: ${state.moisture}%`);
    });
    $("#resetDemo").addEventListener("click", resetDemo);
  }
  function clocks() {
    const now = new Date();
    $("#currentTime").textContent = now.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    $("#cameraClock").textContent = now.toLocaleTimeString([]);
    $("#greeting").textContent =
      now.getHours() < 12
        ? "morning"
        : now.getHours() < 17
          ? "afternoon"
          : "evening";
  }
  function init() {
    let savedTheme = "light";
    try {
      savedTheme = localStorage.getItem("ecoplanter-theme") || "light";
    } catch (e) {}
    if (savedTheme === "dark") {
      document.body.classList.add("dark");
      $("#themeButton").innerHTML =
        '<svg class="icon"><use href="#i-sun"/></svg>';
    }
    $("#year").textContent = new Date().getFullYear();
    bind();
    bindArm();
    window.addEventListener("pagehide", () => {
      if (state.mode === "hardware") sendHardware("stop_motion");
    });
    renderAll();
    routeTo(location.hash.slice(1) || "dashboard");
    clocks();
    setInterval(clocks, 1000);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
