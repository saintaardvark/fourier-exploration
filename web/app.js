// Page logic: controls, playback and charts. All the maths happens in
// worker.mjs (Python via Pyodide); this file only moves arrays around.

const $ = (id) => document.getElementById(id);

// Pass ?pyodide=/path/ through to the worker (used for offline testing).
const params = new URLSearchParams(location.search);
const workerUrl = new URL("worker.mjs", location.href);
if (params.get("pyodide")) workerUrl.searchParams.set("pyodide", params.get("pyodide"));
const worker = new Worker(workerUrl, { type: "module" });

const state = {
  total: 0,
  sr: 44100,
  original: null, // Float32Array
  rebuilt: null, // Float32Array
  spectrum: null, // {edges, original, kept}
  stats: null,
  busy: false, // a render is in flight
  pending: false, // controls changed while busy
  countOverride: null, // exact N from a preset, until the slider moves
};

// --- N slider: logarithmic, 0 .. total ---------------------------------------

const SLIDER_MAX = 1000;
const sliderToCount = (v) => Math.round(Math.pow(state.total + 1, v / SLIDER_MAX) - 1);
const countToSlider = (n) => Math.round((SLIDER_MAX * Math.log(n + 1)) / Math.log(state.total + 1));

const currentCount = () => state.countOverride ?? sliderToCount(Number($("count").value));

function controls() {
  const bits = $("bits").value;
  return {
    mode: document.querySelector('input[name="mode"]:checked').value,
    count: currentCount(),
    phase: document.querySelector('input[name="phase"]:checked').value,
    bits: bits === "" ? null : Number(bits),
    quant: "log",
  };
}

// --- Talking to the worker ---------------------------------------------------

let debounceTimer = null;
function requestRender() {
  $("count-readout").textContent = formatCount(currentCount());
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (state.busy) {
      state.pending = true; // render again once the current one lands
      return;
    }
    state.busy = true;
    worker.postMessage({ type: "render", ...controls() });
  }, 60);
}

worker.onmessage = ({ data }) => {
  if (data.type === "status") {
    setStatus(data.text);
  } else if (data.type === "error") {
    setStatus(`Something went wrong: ${data.text}`, true);
    state.busy = false;
  } else if (data.type === "ready") {
    state.total = data.total;
    state.sr = data.sr;
    state.original = data.original;
    setStatus("");
    $("controls").hidden = false;
    for (const btn of document.querySelectorAll("#presets button")) btn.disabled = false;
    state.countOverride = 100; // start somewhere telling: the 100 largest
    $("count").value = countToSlider(state.countOverride);
    requestRender();
  } else if (data.type === "rendered") {
    state.rebuilt = data.y;
    state.stats = data.stats;
    const b = (data.spectrum.length - 1) / 3;
    state.spectrum = {
      edges: data.spectrum.subarray(0, b + 1),
      original: data.spectrum.subarray(b + 1, 2 * b + 1),
      kept: data.spectrum.subarray(2 * b + 1),
    };
    state.busy = false;
    if (state.pending) {
      state.pending = false;
      requestRender();
    }
    showStats();
    drawAll();
    if (playing === "rebuilt") play("rebuilt"); // keep listening to the latest version
  }
};
worker.onerror = (e) => setStatus(`The worker failed to start: ${e.message}`, true);

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
  $("status").hidden = text === "";
}

// --- Stats -------------------------------------------------------------------

const formatCount = (n) =>
  `${n.toLocaleString()} (${((100 * n) / Math.max(state.total, 1)).toFixed(n && n < state.total / 100 ? 2 : 1)}%)`;

function showStats() {
  const s = state.stats;
  const tiles = [
    ["Kept", `${s.count.toLocaleString()} of ${s.total.toLocaleString()}`],
    ["Knobs", (2 * s.count).toLocaleString()],
    ["Highest kept", `${Math.round(s.highest_hz).toLocaleString()} Hz`],
    ["Energy", `${Math.round(100 * s.energy)}%`],
    ["SNR", s.snr_db === null ? "exact" : `${s.snr_db.toFixed(1)} dB`],
    ["Bitrate", `${Math.round(s.kbps).toLocaleString()} kbps`],
  ];
  $("stats").innerHTML = tiles
    .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join("");
  $("clipnote").textContent =
    s.peak > 1
      ? `Peak ${s.peak.toFixed(2)} would clip (the original peaks at ${s.original_peak.toFixed(2)}), so playback is scaled down to fit.`
      : "";
}

// --- Playback ----------------------------------------------------------------

let audioCtx = null;
let source = null;
let playing = null; // "original" | "rebuilt" | null

function play(which) {
  audioCtx ??= new AudioContext();
  stop();
  const samples = which === "original" ? state.original : state.rebuilt;
  const buffer = audioCtx.createBuffer(1, samples.length, state.sr);
  buffer.copyToChannel(samples, 0);
  source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.onended = () => {
    if (source?.buffer === buffer) playing = null;
  };
  source.start();
  playing = which;
}

function stop() {
  if (source) {
    source.onended = null;
    source.stop();
    source = null;
  }
  playing = null;
}

// --- Charts ------------------------------------------------------------------

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

// Per-pixel-column min/max, so a 44,100-sample clip fits ~800 pixels.
function columns(samples, width) {
  const mins = new Float32Array(width);
  const maxs = new Float32Array(width);
  const per = samples.length / width;
  for (let c = 0; c < width; c++) {
    let lo = Infinity;
    let hi = -Infinity;
    const end = Math.min(samples.length, Math.floor((c + 1) * per));
    for (let i = Math.floor(c * per); i < end; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    mins[c] = lo === Infinity ? 0 : lo;
    maxs[c] = hi === -Infinity ? 0 : hi;
  }
  return { mins, maxs };
}

function drawWave() {
  const { ctx, width, height } = setupCanvas($("wave"));
  const w = Math.floor(width);
  const orig = columns(state.original, w);
  const rebuilt = columns(state.rebuilt, w);
  let range = 0;
  for (let c = 0; c < w; c++) {
    range = Math.max(range, -orig.mins[c], orig.maxs[c], -rebuilt.mins[c], rebuilt.maxs[c]);
  }
  range = (range || 1) * 1.08;
  const y = (v) => height / 2 - (v / range) * (height / 2);

  ctx.strokeStyle = css("--grid");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  for (const [cols, color] of [
    [orig, css("--series-1")],
    [rebuilt, css("--series-2")],
  ]) {
    ctx.fillStyle = color;
    for (let c = 0; c < w; c++) {
      const top = y(cols.maxs[c]);
      ctx.fillRect(c, top, 1, Math.max(1, y(cols.mins[c]) - top));
    }
  }
  drawWave.cols = { orig, rebuilt, w };
}

const DB_FLOOR = -100;
function drawSpectrum() {
  const { ctx, width, height } = setupCanvas($("spectrum"));
  const { edges, original, kept } = state.spectrum;
  const lo = Math.log(edges[0]);
  const hi = Math.log(edges[edges.length - 1]);
  const x = (hz) => ((Math.log(hz) - lo) / (hi - lo)) * width;
  const y = (db) => (Math.max(db, DB_FLOOR) / DB_FLOOR) * (height - 16) + 2;

  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = css("--text-2");
  ctx.strokeStyle = css("--grid");
  ctx.lineWidth = 1;
  for (const hz of [100, 1000, 10000]) {
    ctx.beginPath();
    ctx.moveTo(x(hz), 0);
    ctx.lineTo(x(hz), height);
    ctx.stroke();
    const label = hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`;
    const lx = Math.min(x(hz) + 4, width - ctx.measureText(label).width - 4);
    ctx.fillText(label, lx, height - 4);
  }
  for (const db of [-20, -40, -60, -80]) {
    ctx.beginPath();
    ctx.moveTo(0, y(db));
    ctx.lineTo(width, y(db));
    ctx.stroke();
    ctx.fillText(`${db} dB`, 4, y(db) - 3);
  }

  // All coefficients: a line. Gaps where a band holds no coefficient.
  ctx.strokeStyle = css("--series-1");
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  let drawing = false;
  for (let i = 0; i < original.length; i++) {
    if (original[i] <= DB_FLOOR) {
      drawing = false;
      continue;
    }
    const px = x(Math.sqrt(edges[i] * edges[i + 1]));
    drawing ? ctx.lineTo(px, y(original[i])) : ctx.moveTo(px, y(original[i]));
    drawing = true;
  }
  ctx.stroke();

  // Kept bands: a stem up to each band's loudest kept coefficient, so even a
  // single isolated kept band is visible.
  ctx.fillStyle = css("--series-2");
  for (let i = 0; i < kept.length; i++) {
    if (kept[i] <= DB_FLOOR) continue;
    const left = x(edges[i]);
    const w = Math.max(2, x(edges[i + 1]) - left - 1);
    const top = y(kept[i]);
    ctx.fillRect(left, top, w, y(DB_FLOOR) - top);
  }
}

function drawAll() {
  if (!state.rebuilt) return;
  drawWave();
  drawSpectrum();
}

// --- Hover readouts ----------------------------------------------------------

function showTip(tip, canvas, event, html) {
  const rect = canvas.getBoundingClientRect();
  const px = event.clientX - rect.left;
  tip.innerHTML = html;
  tip.style.display = "block";
  const left = Math.min(Math.max(px + 12, 0), rect.width - tip.offsetWidth);
  tip.style.left = `${left}px`;
  tip.style.top = `${canvas.offsetTop + 8}px`;
}

const fmtDb = (db) => (db <= DB_FLOOR ? "—" : `${db.toFixed(1)} dB`);

$("wave").addEventListener("pointermove", (e) => {
  const cols = drawWave.cols;
  if (!cols) return;
  const rect = $("wave").getBoundingClientRect();
  const c = Math.min(cols.w - 1, Math.max(0, Math.floor(e.clientX - rect.left)));
  const ms = ((c + 0.5) / cols.w) * (state.original.length / state.sr) * 1000;
  const peak = (m, i) => Math.max(-m.mins[i], m.maxs[i]).toFixed(3);
  showTip($("wave-tip"), $("wave"), e,
    `${ms.toFixed(0)} ms · original ±${peak(cols.orig, c)} · rebuilt ±${peak(cols.rebuilt, c)}`);
});

$("spectrum").addEventListener("pointermove", (e) => {
  if (!state.spectrum) return;
  const { edges, original, kept } = state.spectrum;
  const rect = $("spectrum").getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  const hz = Math.exp(Math.log(edges[0]) + frac * (Math.log(edges[edges.length - 1]) - Math.log(edges[0])));
  let i = 0;
  while (i < original.length - 1 && edges[i + 1] < hz) i++;
  showTip($("spectrum-tip"), $("spectrum"), e,
    `${Math.round(edges[i])}–${Math.round(edges[i + 1])} Hz · all ${fmtDb(original[i])} · kept ${fmtDb(kept[i])}`);
});

for (const id of ["wave", "spectrum"]) {
  $(id).addEventListener("pointerleave", () => ($(`${id}-tip`).style.display = "none"));
}

// --- Wiring ------------------------------------------------------------------

for (const el of document.querySelectorAll('input[name="mode"], input[name="phase"], #bits')) {
  el.addEventListener("change", requestRender);
}
$("count").addEventListener("input", () => {
  state.countOverride = null;
  requestRender();
});
$("play-rebuilt").addEventListener("click", () => play("rebuilt"));
$("play-original").addEventListener("click", () => play("original"));
$("stop").addEventListener("click", stop);

for (const btn of document.querySelectorAll("#presets button")) {
  btn.disabled = true; // enabled once the clip is analysed
  btn.addEventListener("click", () => {
    const d = btn.dataset;
    $(`mode-${d.mode}`).checked = true;
    $(`phase-${d.phase}`).checked = true;
    $("bits").value = d.bits;
    state.countOverride = Math.min(Number(d.n), state.total);
    $("count").value = countToSlider(state.countOverride);
    requestRender();
    $("controls").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawAll, 100);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);

worker.postMessage({ type: "load-test", name: "notes" });
