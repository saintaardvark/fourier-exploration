// Runs Python (Pyodide + numpy) off the main thread, so the page stays
// responsive while it loads and computes.
//
// Messages in:  {type: "load-test", clipId, name}
//               {type: "load-samples", clipId, samples: Float32Array, sr}
//               {type: "render", mode, count, phase, bits, quant}
// Messages out: {type: "status", text}
//               {type: "ready", clipId, total, sr, original: Float32Array}
//               {type: "rendered", clipId, y: Float32Array, spectrum: Float32Array, stats}
//               {type: "error", text}
//
// clipId lets the page ignore results for a clip it has since replaced
// (e.g. while the timespan is being dragged).

const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const PY_FILES = ["__init__.py", "series.py", "signals.py", "session.py"];

// Tests can point at a local copy of Pyodide with ?pyodide=/path/. Only
// same-origin paths are accepted, so a crafted link can't load foreign code.
function pyodideBase() {
  const given = new URL(self.location.href).searchParams.get("pyodide");
  return given && given.startsWith("/") && !given.startsWith("//") ? given : PYODIDE_CDN;
}

let py = null;
let session = null; // PyProxy of fourier.session.Session
let clipId = null; // the page's id for the clip `session` holds

const status = (text) => postMessage({ type: "status", text });

async function boot() {
  status("Loading Python in your browser (about 15 MB the first time; cached after)…");
  const { loadPyodide } = await import(pyodideBase() + "pyodide.mjs");
  py = await loadPyodide({ indexURL: pyodideBase() });
  status("Loading numpy…");
  await py.loadPackage("numpy");

  // Our modules, copied next to the page by tools/build_site.py.
  py.FS.mkdirTree("/home/pyodide/fourier");
  for (const name of PY_FILES) {
    const res = await fetch(new URL(`py/fourier/${name}`, self.location.href));
    if (!res.ok) throw new Error(`couldn't fetch ${name}: HTTP ${res.status}`);
    py.FS.writeFile(`/home/pyodide/fourier/${name}`, await res.text());
  }
  py.runPython("import fourier.session");
}

// Copy a numpy float32 array out of wasm memory into a JS Float32Array.
function toF32(proxy) {
  const buf = proxy.getBuffer("f32");
  try {
    return buf.data.slice();
  } finally {
    buf.release();
    proxy.destroy();
  }
}

function setSession(newSession, id) {
  session?.destroy();
  session = newSession;
  clipId = id;
  postMessage({
    type: "ready",
    clipId,
    total: session.total,
    sr: session.sr,
    original: toF32(session.x_f32()),
  });
}

function loadTest(id, name) {
  status("Analysing…");
  const Session = py.pyimport("fourier.session").Session;
  setSession(Session.from_test_signal(name), id);
  Session.destroy();
}

function loadSamples(id, samples, sr) {
  status(`Analysing ${(samples.length / sr).toFixed(1)} s…`);
  py.globals.set("_samples", samples);
  py.globals.set("_sr", sr);
  const newSession = py.runPython(`
import numpy as np
from fourier.session import Session
Session(np.asarray(_samples.to_py(), dtype=np.float64), int(_sr))
`);
  py.globals.delete("_samples");
  setSession(newSession, id);
}

function render({ mode, count, phase, bits, quant }) {
  // JS null arrives in Python as JsNull, not None, so leave bits out when
  // unquantised and let Python's default (None) apply.
  const kwargs = { mode, count, phase, quant };
  if (bits != null) kwargs.bits = bits;
  session.render.callKwargs(kwargs);
  const y = toF32(session.y_f32());
  const spectrum = toF32(session.spectrum_f32());
  const stats = JSON.parse(session.stats_json());
  postMessage({ type: "rendered", clipId, y, spectrum, stats }, [y.buffer, spectrum.buffer]);
}

const booted = boot();

onmessage = async ({ data }) => {
  try {
    await booted;
    if (data.type === "load-test") loadTest(data.clipId, data.name);
    else if (data.type === "load-samples") loadSamples(data.clipId, data.samples, data.sr);
    else if (data.type === "render") render(data);
  } catch (err) {
    postMessage({ type: "error", text: String(err?.message ?? err) });
  }
};
