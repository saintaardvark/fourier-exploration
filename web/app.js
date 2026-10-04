// Page logic: controls, playback and charts. All the maths happens in
// worker.mjs (Python via Pyodide); this file only moves arrays around.

const $ = (id) => document.getElementById(id);

// Pass ?pyodide=/path/ through to the worker (used for offline testing).
const params = new URLSearchParams(location.search);
const workerUrl = new URL("worker.mjs", location.href);
if (params.get("pyodide")) workerUrl.searchParams.set("pyodide", params.get("pyodide"));
const worker = new Worker(workerUrl, { type: "module" });

const SR = 44100; // decode everything at the CLI's rate
const MAX_SECONDS = 30; // longest clip analysed at once
const DEFAULT_SECONDS = 5;
const MAX_FILE_MB = 150;
const SONG = { url: "audio/switch-me-on.mp3", name: "\u201cSwitch Me On\u201d by Shane Ivers", mb: 10.7 };

const state = {
  clipId: 0, // bumped for every clip sent to the worker
  loaded: false, // a clip has been analysed at least once
  source: "notes", // "notes" | "song" | "file"
  // The decoded song or file in use: {name, samples (mono Float32Array), sr,
  // duration, start, length}, where start/length (seconds) is the selection.
  audio: null,
  decoded: { song: null, file: null }, // cached, so switching back is instant
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
    if (data.clipId !== state.clipId) return; // superseded by a newer clip
    if (playing) stop();
    state.total = data.total;
    state.sr = data.sr;
    state.original = data.original;
    setStatus("");
    $("controls").hidden = false;
    for (const btn of document.querySelectorAll("#presets button")) btn.disabled = false;
    if (!state.loaded) {
      state.countOverride = 100; // start somewhere telling: the 100 largest
      state.loaded = true;
    }
    // Otherwise keep the slider's position; a preset's exact N may now be too big.
    if (state.countOverride !== null) state.countOverride = Math.min(state.countOverride, state.total);
    if (state.countOverride !== null) $("count").value = countToSlider(state.countOverride);
    requestRender();
  } else if (data.type === "rendered") {
    if (data.clipId !== state.clipId) {
      // A render of a clip that's since been replaced: drop it.
      state.busy = false;
      if (state.pending) {
        state.pending = false;
        requestRender();
      }
      return;
    }
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
    ["Bitrate", `${s.kbps < 10 ? s.kbps.toFixed(1) : Math.round(s.kbps).toLocaleString()} kbps`],
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
// One context for decoding and playback. Fixing its rate at 44.1 kHz makes
// decodeAudioData resample every file to the rate the CLI uses.
const getAudioCtx = () => (audioCtx ??= new AudioContext({ sampleRate: SR }));
let source = null;
let playing = null; // "original" | "rebuilt" | null
let startedAt = 0; // context time at which the buffer's sample 0 played

// Seconds into the clip the current playback has reached.
function position() {
  if (!playing) return 0;
  const elapsed = audioCtx.currentTime - startedAt;
  const duration = source.buffer.duration;
  return source.loop ? elapsed % duration : Math.min(elapsed, duration);
}

// Play the original or rebuilt clip. If something is already playing, carry
// on from the same point, so switching between the two (or hearing a new
// rebuild after moving a control) is a direct A/B comparison.
function play(which) {
  const ctx = getAudioCtx();
  ctx.resume();
  const offset = playing ? position() : 0;
  stop();
  const samples = which === "original" ? state.original : state.rebuilt;
  const buffer = ctx.createBuffer(1, samples.length, state.sr);
  buffer.copyToChannel(samples, 0);
  source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = $("loop").checked;
  source.connect(ctx.destination);
  source.onended = () => {
    if (source?.buffer === buffer) {
      playing = null;
      source = null;
    }
  };
  const at = Math.min(offset, buffer.duration - 0.01);
  source.start(0, Math.max(at, 0));
  startedAt = ctx.currentTime - at;
  playing = which;
  requestAnimationFrame(movePlayhead);
}

function stop() {
  if (source) {
    source.onended = null;
    source.stop();
    source = null;
  }
  playing = null;
  $("playhead").hidden = true;
}

function movePlayhead() {
  const head = $("playhead");
  if (!playing || !source) {
    head.hidden = true;
    return;
  }
  const canvas = $("wave");
  head.hidden = false;
  head.style.left = `${canvas.offsetLeft + (position() / source.buffer.duration) * canvas.clientWidth}px`;
  head.style.top = `${canvas.offsetTop}px`;
  head.style.height = `${canvas.offsetHeight}px`;
  requestAnimationFrame(movePlayhead);
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

// --- Sources -----------------------------------------------------------------

function loadNotes() {
  state.audio = null;
  $("timespan").hidden = true;
  $("clip-desc").textContent =
    "Three plucked notes (A, C\u266f, E) after a quarter-second of silence: 1 s, 44.1 kHz.";
  worker.postMessage({ type: "load-test", clipId: ++state.clipId, name: "notes" });
}

async function loadSong() {
  try {
    setStatus(`Downloading the song (${SONG.mb} MB)…`);
    const res = await fetch(SONG.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await useAudio(await res.arrayBuffer(), SONG.name, "song");
  } catch (err) {
    setStatus(`Couldn't load the song: ${err.message}`, true);
  }
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_MB * 1e6) {
    setStatus(`That file is ${(file.size / 1e6).toFixed(0)} MB; the limit is ${MAX_FILE_MB} MB.`, true);
    return;
  }
  try {
    await useAudio(await file.arrayBuffer(), file.name, "file");
  } catch (err) {
    setStatus(
      `Couldn't decode ${file.name} in this browser (${err.message || err}). ` +
        "MP3 and WAV work everywhere; Ogg may not work in Safari.",
      true,
    );
  }
}

// Decode, mix to mono, select the first few seconds and analyse them.
async function useAudio(arrayBuffer, name, source) {
  setStatus(`Decoding ${name}…`);
  const decoded = await getAudioCtx().decodeAudioData(arrayBuffer);
  const mono = new Float32Array(decoded.length);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < mono.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
  }
  state.decoded[source] = {
    name,
    samples: mono,
    sr: decoded.sampleRate,
    duration: decoded.duration,
    start: 0,
    length: Math.min(DEFAULT_SECONDS, decoded.duration),
  };
  setStatus("");
  // The visitor may have switched source while this was downloading/decoding.
  if (state.source === source) showAudio(state.decoded[source]);
}

function showAudio(audio) {
  state.audio = audio;
  overviewCache = null;
  $("timespan").hidden = false;
  $("start").max = audio.duration.toFixed(1);
  $("length").max = Math.min(MAX_SECONDS, audio.duration).toFixed(1);
  syncSelection();
  sendSelection();
}

function sendSelection() {
  const { samples, sr } = state.audio;
  const from = Math.round(state.audio.start * sr);
  const to = Math.min(samples.length, from + Math.round(state.audio.length * sr));
  const clip = samples.slice(from, to); // a copy, so it can be transferred
  worker.postMessage({ type: "load-samples", clipId: ++state.clipId, samples: clip, sr }, [clip.buffer]);
}

let selectionTimer = null;
const sendSelectionSoon = () => {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(sendSelection, 250);
};

const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

// Clamp the selection, then update the inputs, description and overview.
function syncSelection() {
  const { duration, name } = state.audio;
  state.audio.length = Math.min(Math.max(state.audio.length, 0.1), MAX_SECONDS, duration);
  state.audio.start = Math.min(Math.max(state.audio.start, 0), duration - state.audio.length);
  $("start").value = state.audio.start.toFixed(1);
  $("length").value = state.audio.length.toFixed(1);
  $("clip-desc").textContent =
    `${name}: ${fmtTime(state.audio.start)}\u2013${fmtTime(state.audio.start + state.audio.length)} ` +
    `of ${fmtTime(duration)} (${state.audio.length.toFixed(1)} s), mixed to mono at ${state.audio.sr / 1000} kHz.`;
  drawOverview();
}

function selectSource(which) {
  state.source = which;
  $("file-row").hidden = which !== "file";
  if (which === "notes") loadNotes();
  else if (state.decoded[which]) showAudio(state.decoded[which]);
  else if (which === "song") loadSong();
  else {
    state.audio = null;
    $("timespan").hidden = true;
    $("clip-desc").textContent = "Choose an MP3, Ogg, WAV or FLAC file.";
  }
}

// --- Timespan overview: drag the selection, or its edges ----------------------

let overviewCache = null; // {width, cols} for the whole file

function drawOverview() {
  if (!state.audio || $("timespan").hidden) return;
  const { ctx, width, height } = setupCanvas($("overview"));
  const w = Math.floor(width);
  if (overviewCache?.width !== w) overviewCache = { width: w, cols: columns(state.audio.samples, w) };
  const { mins, maxs } = overviewCache.cols;
  let range = 1e-9;
  for (let c = 0; c < w; c++) range = Math.max(range, -mins[c], maxs[c]);

  const x0 = (state.audio.start / state.audio.duration) * width;
  const x1 = ((state.audio.start + state.audio.length) / state.audio.duration) * width;
  ctx.fillStyle = css("--grid");
  ctx.fillRect(x0, 0, Math.max(x1 - x0, 2), height);

  for (let c = 0; c < w; c++) {
    const inside = c >= x0 && c <= x1;
    ctx.fillStyle = inside ? css("--series-1") : css("--text-2");
    ctx.globalAlpha = inside ? 1 : 0.45;
    const top = height / 2 - (maxs[c] / range) * (height / 2 - 2);
    const bottom = height / 2 - (mins[c] / range) * (height / 2 - 2);
    ctx.fillRect(c, top, 1, Math.max(1, bottom - top));
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = css("--accent");
  ctx.fillRect(x0 - 1, 0, 3, height);
  ctx.fillRect(x1 - 1, 0, 3, height);
}

let drag = null; // {mode: "move" | "start" | "end", offset}

function overviewTime(e) {
  const rect = $("overview").getBoundingClientRect();
  return ((e.clientX - rect.left) / rect.width) * state.audio.duration;
}

function hitTest(e) {
  const rect = $("overview").getBoundingClientRect();
  const px = e.clientX - rect.left;
  const x0 = (state.audio.start / state.audio.duration) * rect.width;
  const x1 = ((state.audio.start + state.audio.length) / state.audio.duration) * rect.width;
  // A narrow selection (a few seconds of a long song) is all "move";
  // its edges are grabbed just outside it instead.
  const narrow = x1 - x0 < 24;
  if (px >= x0 && px <= x1 && (narrow || (px - x0 > 8 && x1 - px > 8))) return "move";
  if (Math.abs(px - x0) <= 8) return "start";
  if (Math.abs(px - x1) <= 8) return "end";
  return "outside";
}

$("overview").addEventListener("pointerdown", (e) => {
  if (!state.audio) return;
  const t = overviewTime(e);
  let mode = hitTest(e);
  if (mode === "outside") {
    state.audio.start = t - state.audio.length / 2; // jump the selection here
    syncSelection();
    mode = "move";
  }
  drag = { mode, offset: t - state.audio.start };
  $("overview").setPointerCapture(e.pointerId);
});

$("overview").addEventListener("pointermove", (e) => {
  if (!state.audio) return;
  if (!drag) {
    const mode = hitTest(e);
    $("overview").style.cursor = mode === "start" || mode === "end" ? "ew-resize" : mode === "move" ? "grab" : "pointer";
    return;
  }
  const t = overviewTime(e);
  const end = state.audio.start + state.audio.length;
  if (drag.mode === "move") {
    state.audio.start = t - drag.offset;
  } else if (drag.mode === "start") {
    const start = Math.min(Math.max(t, end - MAX_SECONDS, 0), end - 0.1);
    state.audio.length = end - start;
    state.audio.start = start;
  } else {
    state.audio.length = Math.min(Math.max(t - state.audio.start, 0.1), MAX_SECONDS);
  }
  syncSelection();
});

for (const type of ["pointerup", "pointercancel"]) {
  $("overview").addEventListener(type, () => {
    if (!drag) return;
    drag = null;
    sendSelectionSoon();
  });
}

for (const id of ["start", "length"]) {
  $(id).addEventListener("change", () => {
    if (!state.audio) return;
    state.audio[id] = Number($(id).value) || 0;
    syncSelection();
    sendSelectionSoon();
  });
}

// --- Wiring ------------------------------------------------------------------

for (const el of document.querySelectorAll('input[name="source"]')) {
  el.addEventListener("change", () => selectSource(el.value));
}
$("file").addEventListener("change", () => loadFile($("file").files[0]));

// Drop a file anywhere on the panel.
const panel = $("panel");
panel.addEventListener("dragover", (e) => {
  e.preventDefault();
  panel.classList.add("dragover");
});
panel.addEventListener("dragleave", () => panel.classList.remove("dragover"));
panel.addEventListener("drop", async (e) => {
  e.preventDefault();
  panel.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (!file) return;
  $("source-file").checked = true;
  state.source = "file";
  $("file-row").hidden = false;
  await loadFile(file);
});


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
$("loop").addEventListener("change", () => {
  if (!source) return;
  // Takes effect mid-play. Re-anchor so position() stays right once the
  // modulo (looping) or clamp (not looping) changes over.
  const pos = position();
  source.loop = $("loop").checked;
  startedAt = audioCtx.currentTime - pos;
});

// Preset N: a count, a percentage of all coefficients, or "all".
function presetCount(spec) {
  if (spec === "all") return state.total;
  if (spec.endsWith("%")) return Math.round((state.total * Number(spec.slice(0, -1))) / 100);
  return Math.min(Number(spec), state.total);
}

for (const btn of document.querySelectorAll("#presets button")) {
  btn.disabled = true; // enabled once the clip is analysed
  btn.addEventListener("click", () => {
    const d = btn.dataset;
    $(`mode-${d.mode}`).checked = true;
    $(`phase-${d.phase}`).checked = true;
    $("bits").value = d.bits;
    state.countOverride = presetCount(d.n);
    $("count").value = countToSlider(state.countOverride);
    requestRender();
    $("controls").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    drawAll();
    drawOverview();
  }, 100);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  drawAll();
  drawOverview();
});

$("max-seconds").textContent = MAX_SECONDS;
loadNotes();
