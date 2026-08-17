// Replaces a profile's placeholder numbers in domain.json with measurements
// taken from a real endpoint.
//
// Provider-agnostic: anything that speaks OpenAI-compatible chat completions
// works. Configure the URL, auth style and model in .env; see .env.example.
//
// Cost is computed rather than measured, because responses do not carry a
// price. Quality is neither computed nor measured; this harness cannot judge
// output quality, so that value stays whatever the operator declared and the
// written record says so.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

try {
	for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
	}
} catch {
	/* no .env, fall back to the real environment */
}

const get = (name) => process.env[name]?.trim() ?? "";

const need = (name, hint) => {
	const v = get(name);
	if (!v) {
		console.error(`  missing ${name}${hint ? ` — ${hint}` : ""}`);
		console.error("  copy .env.example to .env and fill it in, then re-run");
		process.exit(1);
	}
	return v;
};

const providerName = get("PROVIDER_NAME") || "unknown";
const providerUrl = need("PROVIDER_URL", "the full chat completions URL");
const apiKey = need("PROVIDER_API_KEY");
const authStyle = (get("PROVIDER_AUTH") || "bearer").toLowerCase();
const model = get("PROVIDER_MODEL");
const profileId = need("CALIBRATE_PROFILE_ID", "which profile in domain.json to update");
const samples = Number(get("CALIBRATE_SAMPLES") || 20);
const warmup = Number(get("CALIBRATE_WARMUP") || 3);

if (!["bearer", "api-key"].includes(authStyle)) {
	console.error(`  PROVIDER_AUTH must be "bearer" or "api-key", got "${authStyle}"`);
	process.exit(1);
}

const priceIn = Number(need("PRICE_PER_1K_INPUT", "USD per 1K input tokens"));
const priceOut = Number(need("PRICE_PER_1K_OUTPUT", "USD per 1K output tokens"));
if (!Number.isFinite(priceIn) || !Number.isFinite(priceOut)) {
	console.error("  PRICE_PER_1K_INPUT and PRICE_PER_1K_OUTPUT must be numbers");
	process.exit(1);
}

const domainPath = join(root, "domain.json");
const domain = JSON.parse(readFileSync(domainPath, "utf8"));
const profile = domain.profiles.find((p) => p.id === profileId);
if (!profile) {
	console.error(`  no profile "${profileId}" in domain.json`);
	console.error(`  available: ${domain.profiles.map((p) => p.id).join(", ")}`);
	process.exit(1);
}

// One fixed prompt, so every sample measures the same unit of work.
const messages = [
	{ role: "system", content: "You draft short, plain business emails. No preamble." },
	{
		role: "user",
		content:
			"Draft a two sentence email telling a supplier that our delivery window moved from Tuesday to Thursday.",
	},
];

const headers = {
	"content-type": "application/json",
	...(authStyle === "bearer" ? { authorization: `Bearer ${apiKey}` } : { "api-key": apiKey }),
};

// Providers disagree about request parameters: some reject max_tokens and want
// max_completion_tokens, some reject a non-default temperature. Start strict
// and drop whatever the endpoint names as unsupported, then record the shape
// that was actually accepted.
let body = {
	messages,
	max_completion_tokens: 200,
	temperature: 0,
	...(model ? { model } : {}),
};
const adaptations = [];

const post = async () => {
	const started = process.hrtime.bigint();
	const res = await fetch(providerUrl, { method: "POST", headers, body: JSON.stringify(body) });
	return { res, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };
};

const adapt = (message) => {
	const named = message.match(/'([a-z_]+)' is not supported/i)?.[1];
	if (!named || !(named in body)) return false;
	if (named === "max_completion_tokens" && !("max_tokens" in body)) {
		delete body.max_completion_tokens;
		body.max_tokens = 200;
		adaptations.push("max_completion_tokens -> max_tokens");
		return true;
	}
	delete body[named];
	adaptations.push(`dropped ${named}`);
	return true;
};

const callOnce = async (allowAdapt = false) => {
	let { res, elapsedMs } = await post();

	if (!res.ok) {
		const text = await res.text();
		if (allowAdapt && res.status === 400 && adapt(text)) {
			({ res, elapsedMs } = await post());
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
		} else {
			throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
		}
	}

	const usage = (await res.json()).usage ?? {};
	return {
		elapsedMs,
		promptTokens: usage.prompt_tokens ?? 0,
		completionTokens: usage.completion_tokens ?? 0,
	};
};

const quantile = (sorted, q) => {
	if (sorted.length === 0) return 0;
	const pos = (sorted.length - 1) * q;
	const base = Math.floor(pos);
	const next = sorted[base + 1];
	return next !== undefined ? sorted[base] + (pos - base) * (next - sorted[base]) : sorted[base];
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const redactedUrl = providerUrl.replace(/(\?|&)([^=]*key[^=]*)=[^&]*/gi, "$1$2=***");
console.log(`  provider   ${providerName}`);
console.log(`  url        ${redactedUrl}`);
console.log(`  model      ${model || "(in the URL)"}`);
console.log(`  auth       ${authStyle}`);
console.log(`  profile    ${profileId}`);
console.log(`  samples    ${samples} (+${warmup} warmup, discarded)\n`);

try {
	await callOnce(true);
	for (let i = 1; i < Math.max(warmup, 1); i += 1) {
		await callOnce();
		process.stdout.write(`\r  warmup ${i + 1}/${warmup}`);
	}
} catch (error) {
	console.error(`\n  first call failed: ${error.message}`);
	console.error("  check PROVIDER_URL, PROVIDER_AUTH, PROVIDER_API_KEY and PROVIDER_MODEL");
	process.exit(1);
}

const runs = [];
for (let i = 0; i < samples; i += 1) {
	try {
		runs.push(await callOnce());
	} catch (error) {
		console.error(`\n  sample ${i + 1} failed: ${error.message}`);
	}
	process.stdout.write(`\r  measuring ${runs.length}/${samples}   `);
}
console.log("");

if (runs.length === 0) {
	console.error("  every call failed, nothing measured");
	process.exit(1);
}

const latencies = runs.map((r) => r.elapsedMs).sort((a, b) => a - b);
const meanPrompt = mean(runs.map((r) => r.promptTokens));
const meanCompletion = mean(runs.map((r) => r.completionTokens));

const measurement = {
	measuredAt: new Date().toISOString(),
	provider: providerName,
	model: model || "(in the URL)",
	samples: runs.length,
	failed: samples - runs.length,
	p50LatencyMs: Math.round(quantile(latencies, 0.5)),
	p95LatencyMs: Math.round(quantile(latencies, 0.95)),
	minLatencyMs: Math.round(latencies[0]),
	maxLatencyMs: Math.round(latencies.at(-1)),
	meanPromptTokens: Number(meanPrompt.toFixed(1)),
	meanCompletionTokens: Number(meanCompletion.toFixed(1)),
	pricePer1kInput: priceIn,
	pricePer1kOutput: priceOut,
	requestShape: Object.keys(body).filter((k) => k !== "messages"),
	adaptations,
	qualityIsDeclaredNotMeasured: true,
};

profile.cost = Number(((meanPrompt / 1000) * priceIn + (meanCompletion / 1000) * priceOut).toFixed(6));
profile.latencyMs = measurement.p50LatencyMs;
profile.provider = providerName;
profile.source = "measured";
profile.measurement = measurement;

writeFileSync(domainPath, `${JSON.stringify(domain, null, 2)}\n`);

console.log(
	`  latency    p50 ${measurement.p50LatencyMs}ms  p95 ${measurement.p95LatencyMs}ms  (${measurement.minLatencyMs}-${measurement.maxLatencyMs}ms)`,
);
console.log(`  tokens     ${measurement.meanPromptTokens} in / ${measurement.meanCompletionTokens} out per call`);
if (adaptations.length) console.log(`  adapted    ${adaptations.join(", ")}`);
console.log(`  cost       $${profile.cost} per call at $${priceIn}/1K in, $${priceOut}/1K out`);
if (measurement.failed > 0) console.log(`  failed     ${measurement.failed} of ${samples} calls`);
console.log(`\n  wrote domain.json — ${profileId} is now source: measured`);
console.log("  quality was left as declared; this harness cannot measure output quality");
console.log("  restart both services so they pick up the new domain, then re-run bench");
