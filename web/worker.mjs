// Runs Python (Pyodide + numpy) off the main thread, so the page stays
// responsive while it loads and computes.
//
// Messages in:  {type: "load-test", name}
//               {type: "render", mode, count, phase, bits, quant}
// Messages out: {type: "status", text}
//               {type: "ready", total, sr, original: Float32Array}
//               {type: "rendered", y: Float32Array, spectrum: Float32Array, stats}
//               {type: "error", text}

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

function loadTest(name) {
  status("Analysing…");
  session?.destroy();
  const Session = py.pyimport("fourier.session").Session;
  session = Session.from_test_signal(name);
  Session.destroy();
  postMessage({
    type: "ready",
    total: session.total,
    sr: session.sr,
    original: toF32(session.x_f32()),
  });
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
  postMessage({ type: "rendered", y, spectrum, stats }, [y.buffer, spectrum.buffer]);
}

const booted = boot();

onmessage = async ({ data }) => {
  try {
    await booted;
    if (data.type === "load-test") loadTest(data.name);
    else if (data.type === "render") render(data);
  } catch (err) {
    postMessage({ type: "error", text: String(err?.message ?? err) });
  }
};
