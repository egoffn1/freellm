#!/usr/bin/env node
/**
 * FreeLLM cold-start and gateway-overhead benchmark.
 *
 * This script is designed to be reproducible and boring. It does two things:
 *
 *   1. Measures boot time as the wall-clock elapsed between spawning the
 *      server process and the first successful /healthz response.
 *   2. Starts a tiny in-process fake upstream that always returns 200 as
 *      fast as Node can push bytes, points the gateway at it via
 *      OLLAMA_BASE_URL, and hammers the chat endpoint to measure the
 *      per-request overhead FreeLLM adds on top of the upstream response.
 *
 * The output is a JSON file at docs/benchmarks.json so the website can
 * render the numbers from the repo's own data without cherry-picking.
 *
 * Usage:
 *
 *     node scripts/bench.mjs                # write docs/benchmarks.json
 *     node scripts/bench.mjs --print        # also print to stdout
 *
 * Methodology caveats live in the comments next to each measurement so
 * nobody can accuse us of running on a beefy desktop and publishing the
 * numbers. The website benchmarks page links to this file.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_SERVER = path.resolve(REPO_ROOT, "apps/gateway/dist/index.mjs");
const OUT_PATH = path.resolve(REPO_ROOT, "docs/benchmarks.json");

const WARMUP_REQUESTS = 20;
const MEASURED_REQUESTS = 200;
const BENCH_PORT = 4127;
const FAKE_UPSTREAM_PORT = 4128;

/** Tiny fake OpenAI-compatible upstream. Returns 200 as fast as possible. */
function startFakeUpstream() {
  const canned = JSON.stringify({
    id: "chatcmpl-bench",
    object: "chat.completion",
    created: 0,
    model: "llama3",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(canned);
    });
  });
  return new Promise((resolve) => {
    server.listen(FAKE_UPSTREAM_PORT, "127.0.0.1", () => resolve(server));
  });
}

/** Spawn the gateway and resolve when /healthz first returns 200. */
function startGatewayAndMeasureBoot() {
  const startedAt = performance.now();
  const child = spawn("node", ["--enable-source-maps", API_SERVER], {
    env: {
      ...process.env,
      PORT: String(BENCH_PORT),
      NODE_ENV: "development",
      OLLAMA_BASE_URL: `http://127.0.0.1:${FAKE_UPSTREAM_PORT}`,
      OLLAMA_MODELS: "llama3",
      // Strip any real provider keys so only the fake upstream matters.
      GROQ_API_KEY: "",
      GEMINI_API_KEY: "",
      MISTRAL_API_KEY: "",
      CEREBRAS_API_KEY: "",
      NIM_API_KEY: "",
      // Quieten logs during the benchmark so we don't measure pino.
      LOG_LEVEL: "error",
      // Disable the per-IP rate limiter -- all requests come from 127.0.0.1
      // during the benchmark and the default 60 RPM would throttle us.
      RATE_LIMIT_RPM: "100000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let resolved = false;
    const tryHealth = async () => {
      if (resolved) return;
      try {
        const r = await fetch(`http://127.0.0.1:${BENCH_PORT}/healthz`);
        if (r.ok) {
          const elapsed = performance.now() - startedAt;
          resolved = true;
          resolve({ child, bootMs: elapsed });
          return;
        }
      } catch {
        // Not up yet.
      }
      setTimeout(tryHealth, 20);
    };
    tryHealth();

    child.on("exit", (code) => {
      if (!resolved) reject(new Error(`gateway exited early with code ${code}`));
    });
  });
}

/**
 * Hit the chat endpoint `count` times and record each latency. By default
 * every request carries a unique prompt so the exact-match cache can't
 * absorb them, and we measure the full routing path. Pass `uniquePrompts: false`
 * to keep the body identical across iterations and measure the cache-hit path.
 */
async function measureOverhead(count, { uniquePrompts = true } = {}) {
  const latencies = [];
  for (let i = 0; i < count; i++) {
    const prompt = uniquePrompts ? `bench ${i}` : "bench";
    const body = JSON.stringify({
      model: "ollama/llama3",
      messages: [{ role: "user", content: prompt }],
    });
    const t0 = performance.now();
    const r = await fetch(`http://127.0.0.1:${BENCH_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!r.ok) throw new Error(`unexpected status ${r.status} on bench request ${i}`);
    await r.json();
    latencies.push(performance.now() - t0);
  }
  return latencies;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main() {
  const print = process.argv.includes("--print");

  console.log("Starting fake upstream ...");
  const upstream = await startFakeUpstream();

  console.log("Spawning gateway and measuring boot time ...");
  const { child, bootMs } = await startGatewayAndMeasureBoot();
  console.log(`Boot: ${bootMs.toFixed(0)}ms`);

  const summarise = (latencies) => {
    const sorted = [...latencies].sort((a, b) => a - b);
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    return {
      mean: Number(mean.toFixed(2)),
      p50: Number(percentile(sorted, 50).toFixed(2)),
      p90: Number(percentile(sorted, 90).toFixed(2)),
      p99: Number(percentile(sorted, 99).toFixed(2)),
      min: Number(sorted[0].toFixed(2)),
      max: Number(sorted[sorted.length - 1].toFixed(2)),
    };
  };

  try {
    console.log(`Warming up with ${WARMUP_REQUESTS} unique requests ...`);
    await measureOverhead(WARMUP_REQUESTS);

    console.log(`Measuring ${MEASURED_REQUESTS} cache-miss requests ...`);
    const cacheMiss = await measureOverhead(MEASURED_REQUESTS, { uniquePrompts: true });

    console.log(`Measuring ${MEASURED_REQUESTS} cache-hit requests ...`);
    const cacheHit = await measureOverhead(MEASURED_REQUESTS, { uniquePrompts: false });

    const report = {
      version: 1,
      measured_at: new Date().toISOString(),
      node_version: process.version,
      platform: `${process.platform} ${process.arch}`,
      methodology: {
        warmup_requests: WARMUP_REQUESTS,
        measured_requests: MEASURED_REQUESTS,
        upstream: "fake in-process HTTP server returning a canned 200 body",
        notes:
          "Boot time is wall-clock from spawn to first healthz 200. Cache-miss measures the full routing path with unique prompts per request. Cache-hit measures the same prompt repeated so the exact-match cache returns immediately. Run on the developer's machine, not a synthetic cloud host, so treat as ballpark and reproduce locally with scripts/bench.mjs.",
      },
      cold_start: {
        boot_ms: Math.round(bootMs),
      },
      overhead_ms: {
        cache_miss: summarise(cacheMiss),
        cache_hit: summarise(cacheHit),
      },
    };

    await mkdir(path.dirname(OUT_PATH), { recursive: true });
    await writeFile(OUT_PATH, JSON.stringify(report, null, 2) + "\n");
    console.log(`Wrote ${path.relative(REPO_ROOT, OUT_PATH)}`);
    if (print) console.log(JSON.stringify(report, null, 2));
  } finally {
    child.kill("SIGTERM");
    upstream.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
