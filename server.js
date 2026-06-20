import express from "express";
import { randomUUID } from "crypto";

// ---- config from env (set these in Railway) ----
const HF_TOKEN        = process.env.HF_TOKEN;            // required
const PROVIDER        = process.env.PROVIDER || ":novita";
const MAX_TOKENS      = parseInt(process.env.MAX_TOKENS || "512");
const PROMPT_DEFAULT  = process.env.PROMPT ||
  "Analyze this image. Be precise and literal — describe only what is actually present, no guessing. Cover: main subject, style, dominant colors, notable objects, and any visible text.";
const PORT            = process.env.PORT || 3000;

// ---- fixed endpoints ----
const WORKER_URL   = "https://model.avi-kay2019.workers.dev";
const HF_ENDPOINT  = "https://router.huggingface.co/v1/chat/completions";
const MODEL_BASE   = "Qwen/Qwen3-VL-235B-A22B-Instruct";
const ZOHO_WEBHOOK = process.env.ZOHO_WEBHOOK ||
  "https://flow.zoho.com/916614704/flow/webhook/incoming?zapikey=1001.f2d435dcfe245c053095ab6a9fad6e88.b6ff2f70899c4867174c3263036646df&isdebug=true";

if (!HF_TOKEN) { console.error("FATAL: HF_TOKEN env var is not set."); process.exit(1); }

const app = express();
// accept raw image bytes up to 25mb
app.use(express.raw({ type: ["image/*", "application/octet-stream"], limit: "25mb" }));
app.use(express.json({ limit: "1mb" }));

// in-memory job log (current run only) — nothing persisted, by design
const jobs = [];

app.get("/", (_req, res) => res.json({ ok: true, service: "tattty-analyzer", processed: jobs.length }));
app.get("/status", (_req, res) => res.json(jobs));

// ---- step 1: worker upload -> { url } ----
async function uploadToWorker(buffer, contentType) {
  const r = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "X-File-Type": "image", "Content-Type": contentType },
    body: buffer,
  });
  if (!r.ok) throw new Error(`Worker HTTP ${r.status}: ${(await r.text()).slice(0,200)}`);
  const d = await r.json();
  if (!d.url) throw new Error("Worker returned no url: " + JSON.stringify(d).slice(0,200));
  return d.url;
}

// ---- step 2: HF analyze ----
async function analyzeUrl(url, prompt) {
  const body = {
    model: MODEL_BASE + PROVIDER, stream: false, max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: [ { type: "text", text: prompt }, { type: "image_url", image_url: { url } } ] }],
  };
  const r = await fetch(HF_ENDPOINT, {
    method: "POST",
    headers: { Authorization: "Bearer " + HF_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`HF HTTP ${r.status}: ${(d.error?.message || d.error || JSON.stringify(d)).toString().slice(0,200)}`);
  return { text: d.choices?.[0]?.message?.content ?? "(empty)", tokens: d.usage?.total_tokens ?? null };
}

// ---- step 3: fire webhook to Zoho Flow (matches tested payload exactly) ----
async function writeZohoRow(imageUrl, analysisText) {
  const body = { image_url: imageUrl, prompt: analysisText, status: "COMPLETED" };
  const r = await fetch(ZOHO_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Zoho webhook HTTP ${r.status}: ${txt.slice(0,200)}`);
  return txt.slice(0, 400);
}

// ---- main endpoint: POST one image (raw bytes), runs the full chain ----
// headers: Content-Type: image/png|jpeg|webp ; optional X-Prompt to override
// Retries the full chain up to 3 times. Returns 200 on success,
// 422 if it failed all 3 (caller should SKIP this image and watch for a second consecutive skip),
// 400 for no body.
app.post("/analyze", async (req, res) => {
  const id = randomUUID();
  const job = { id, status: "uploading", url: "", result: "", tokens: null, error: "", at: new Date().toISOString() };
  jobs.push(job);

  if (!req.body || !req.body.length) {
    job.status = "error"; job.error = "No image bytes received.";
    return res.status(400).json({ ok: false, id, error: job.error });
  }
  const contentType = req.headers["content-type"] || "image/png";
  const prompt = req.headers["x-prompt"] || PROMPT_DEFAULT;

  const MAX_ATTEMPTS = 3;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      job.attempt = attempt;
      job.status = "uploading";
      job.url = await uploadToWorker(req.body, contentType);

      job.status = "analyzing";
      const a = await analyzeUrl(job.url, prompt);
      const text = (a.text || "").trim();
      if (!text || text === "(empty)") throw new Error("Model returned no prompt");
      job.result = text; job.tokens = a.tokens;

      job.status = "writing";
      job.zoho = await writeZohoRow(job.url, job.result);

      job.status = "completed";
      return res.json({ ok: true, id, IMAGE_URL: job.url, PROMPT: job.result, STATUS: "completed", tokens: job.tokens, attempts: attempt });
    } catch (e) {
      lastErr = e.message;
      job.error = `attempt ${attempt}/${MAX_ATTEMPTS} (${job.status}): ${e.message}`;
    }
  }
  // failed all 3 -> tell caller to SKIP. 422 = "this image is dead, move on."
  job.status = "skipped"; job.error = `skipped after 3 attempts: ${lastErr}`;
  return res.status(422).json({ ok: false, id, skipped: true, error: job.error, stage: job.status });
});

app.listen(PORT, () => console.log(`tattty-analyzer listening on ${PORT}`));
