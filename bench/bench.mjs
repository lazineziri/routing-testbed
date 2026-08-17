import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const domain = JSON.parse(readFileSync(join(root, "domain.json"), "utf8"));

const stacks = [
	{ name: "express", url: process.env.EXPRESS_URL ?? "http://localhost:3001" },
	{ name: "dotnet", url: process.env.DOTNET_URL ?? "http://localhost:3002" },
];

const REPEAT_RATE = Number(process.env.REPEAT_RATE ?? 0.6);
const WORKLOAD = Number(process.env.WORKLOAD ?? 2000);
const WARMUP = Number(process.env.WARMUP ?? 200);
const DETERMINISM_RUNS = Number(process.env.DETERMINISM_RUNS ?? 500);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const TRIALS = Number(process.env.TRIALS ?? 5);

// Deterministic PRNG so the workload is identical on every run and machine.
const mulberry32 = (seed) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const buildWorkload = (n, repeatRate) => {
	const rnd = mulberry32(42);
	const tasks = domain.tasks.map((t) => t.type);
	const seen = [];
	const out = [];
	for (let i = 0; i < n; i += 1) {
		const reuse = seen.length > 0 && rnd() < repeatRate;
		if (reuse) {
			out.push(seen[Math.floor(rnd() * seen.length)]);
		} else {
			const item = { task: tasks[Math.floor(rnd() * tasks.length)], input: { n: i } };
			seen.push(item);
			out.push(item);
		}
	}
	return out;
};

const route = async (stack, body) => {
	const res = await fetch(`${stack.url}/route`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${stack.name} ${res.status}`);
	return res.json();
};

const reset = (stack) => fetch(`${stack.url}/state/reset`, { method: "POST" });

const quantile = (sorted, q) => {
	if (sorted.length === 0) return 0;
	const pos = (sorted.length - 1) * q;
	const base = Math.floor(pos);
	const rest = pos - base;
	const next = sorted[base + 1];
	return next !== undefined ? sorted[base] + rest * (next - sorted[base]) : sorted[base];
};

const stats = (values) => {
	const s = [...values].sort((a, b) => a - b);
	return {
		n: s.length,
		p50: Number(quantile(s, 0.5).toFixed(3)),
		p95: Number(quantile(s, 0.95).toFixed(3)),
		p99: Number(quantile(s, 0.99).toFixed(3)),
		max: Number((s.at(-1) ?? 0).toFixed(3)),
	};
};

const runPolicy = async (stack, policy, workload) => {
	await reset(stack);
	for (let i = 0; i < WARMUP; i += 1) {
		await route(stack, { ...workload[i % workload.length], policy });
	}
	await reset(stack);

	const micros = [];
	const outcomes = { state: 0, tool: 0, model: 0, unresolved: 0 };
	const providers = {};
	const sources = {};
	let modelCalls = 0;
	let costMicros = 0;
	let simulatedLatencyMs = 0;

	const started = process.hrtime.bigint();
	for (const item of workload) {
		const r = await route(stack, { ...item, policy });
		micros.push(r.routingMicros);
		const d = r.decision;
		modelCalls += d.modelCalls;
		costMicros += d.estimatedCostMicros;
		simulatedLatencyMs += d.estimatedLatencyMs;
		for (const st of d.steps) {
			if (st.kind !== "model") continue;
			providers[st.provider] = (providers[st.provider] ?? 0) + 1;
			sources[st.source] = (sources[st.source] ?? 0) + 1;
		}
		if (d.resolvedFromState) outcomes.state += 1;
		else if (d.modelCalls > 0) outcomes.model += 1;
		else if (d.steps.some((s) => s.kind === "unresolved")) outcomes.unresolved += 1;
		else outcomes.tool += 1;
	}
	const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

	return {
		policy,
		requests: workload.length,
		routingMicros: stats(micros),
		outcomes,
		providers,
		sources,
		noModelRate: Number(((outcomes.state + outcomes.tool) / workload.length).toFixed(4)),
		totalModelCalls: modelCalls,
		totalCostMicros: costMicros,
		totalSimulatedProviderMs: simulatedLatencyMs,
		sequentialWallMs: Number(wallMs.toFixed(1)),
	};
};

const runThroughput = async (stack, policy, workload) => {
	await reset(stack);
	let index = 0;
	const started = process.hrtime.bigint();
	const worker = async () => {
		while (true) {
			const i = index++;
			if (i >= workload.length) return;
			await route(stack, { ...workload[i], policy });
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	const seconds = Number(process.hrtime.bigint() - started) / 1e9;
	return {
		concurrency: CONCURRENCY,
		requests: workload.length,
		seconds: Number(seconds.toFixed(3)),
		decisionsPerSecond: Math.round(workload.length / seconds),
	};
};

const runDeterminism = async (stack, policy) => {
	// 1. Pure decision function: identical input and identical state must yield
	//    the same decision. State is reset before every run so the stateful path
	//    cannot masquerade as instability.
	const probe = { task: "email.draft", input: { determinism: true }, policy };
	const sequential = new Set();
	for (let i = 0; i < DETERMINISM_RUNS; i += 1) {
		await reset(stack);
		sequential.add((await route(stack, probe)).decisionHash);
	}

	// 2. Concurrency on a task that touches no state at all. Any variation here
	//    would be genuine nondeterminism in routing.
	await reset(stack);
	const statelessProbe = { task: "project.fact.get", input: { determinism: "concurrent" }, policy };
	const stateless = await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => (await route(stack, statelessProbe)).decisionHash),
	);

	// 3. Concurrency on a stateful task. Identical requests race: whoever wins
	//    writes state, the rest read it. Split outcomes are expected here and are
	//    reported rather than hidden.
	await reset(stack);
	const statefulProbe = { task: "email.draft", input: { determinism: "race" }, policy };
	const stateful = await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => (await route(stack, statefulProbe)).decision),
	);
	const servedFromState = stateful.filter((d) => d.resolvedFromState).length;

	return {
		sequentialRuns: DETERMINISM_RUNS,
		sequentialDistinct: sequential.size,
		decisionFunctionStable: sequential.size === 1,
		concurrentStatelessDistinct: new Set(stateless).size,
		concurrentStatelessStable: new Set(stateless).size === 1,
		concurrentStatefulRequests: CONCURRENCY,
		concurrentServedFromState: servedFromState,
		concurrentCalledModel: CONCURRENCY - servedFromState,
	};
};

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Repeated trials, reporting median and spread. A single timing run cannot
// distinguish a real change from scheduler noise, so nothing here reports one.
const repeat = async (fn) => {
	const runs = [];
	for (let i = 0; i < TRIALS; i += 1) runs.push(await fn());
	return runs;
};

const summarise = (runs, pick) => {
	const values = runs.map(pick);
	return {
		median: Number(median(values).toFixed(3)),
		min: Number(Math.min(...values).toFixed(3)),
		max: Number(Math.max(...values).toFixed(3)),
		spreadPct: Number((((Math.max(...values) - Math.min(...values)) / median(values)) * 100).toFixed(1)),
		trials: values.length,
	};
};

const workload = buildWorkload(WORKLOAD, REPEAT_RATE);
const uniqueInputs = new Set(workload.map((w) => `${w.task}:${JSON.stringify(w.input)}`)).size;

const startedAt = new Date();
const runId = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";

const report = {
	runId,
	startedAt: startedAt.toISOString(),
	finishedAt: null,
	durationSeconds: null,
	machine: {
		platform: platform(),
		arch: arch(),
		cpuModel: cpus()[0]?.model ?? "unknown",
		cpuCount: cpus().length,
		totalMemoryGB: Number((totalmem() / 1024 ** 3).toFixed(1)),
		node: process.version,
	},
	generatedFrom: "bench/bench.mjs",
	domainVersion: domain.domainVersion,
	config: { WORKLOAD, WARMUP, REPEAT_RATE, DETERMINISM_RUNS, CONCURRENCY, TRIALS },
	workload: { requests: workload.length, uniqueInputs, repeatShare: Number((1 - uniqueInputs / workload.length).toFixed(4)) },
	stacks: {},
};

for (const stack of stacks) {
	const health = await (await fetch(`${stack.url}/health`)).json();
	const entry = { health, policies: {}, determinism: {}, throughput: {} };
	for (const policy of ["deterministic", "frugal", "naive"]) {
		const policyRuns = await repeat(() => runPolicy(stack, policy, workload));
		const throughputRuns = await repeat(() => runThroughput(stack, policy, workload));

		const first = policyRuns[0];
		entry.policies[policy] = {
			...first,
			routingMicros: {
				p50: summarise(policyRuns, (r) => r.routingMicros.p50),
				p95: summarise(policyRuns, (r) => r.routingMicros.p95),
				p99: summarise(policyRuns, (r) => r.routingMicros.p99),
			},
			countsStableAcrossTrials: policyRuns.every(
				(r) => r.totalModelCalls === first.totalModelCalls && r.totalCostMicros === first.totalCostMicros,
			),
		};
		entry.determinism[policy] = await runDeterminism(stack, policy);
		entry.throughput[policy] = {
			concurrency: CONCURRENCY,
			requests: workload.length,
			decisionsPerSecond: summarise(throughputRuns, (r) => r.decisionsPerSecond),
		};
	}
	report.stacks[stack.name] = entry;
	console.log(`  ${stack.name} done`);
}

const finishedAt = new Date();
report.finishedAt = finishedAt.toISOString();
report.durationSeconds = Number(((finishedAt - startedAt) / 1000).toFixed(1));

mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(`  run ${runId} took ${report.durationSeconds}s`);
console.log(`  wrote results/${runId}.json`);
