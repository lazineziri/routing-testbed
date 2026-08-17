import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { compile, decide, domainFingerprint } from "./routing.js";

const here = dirname(fileURLToPath(import.meta.url));
const domain = JSON.parse(readFileSync(join(here, "..", "..", "domain.json"), "utf8"));
const fingerprint = domainFingerprint(domain);
const compiled = compile(domain);

const STATE_LIMIT = Number(process.env.STATE_LIMIT ?? 100000);
const state = new Set();
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(here, "..", "..", "public"), { extensions: ["html"] }));

app.get("/health", (_req, res) => {
	res.json({
		ok: true,
		stack: "node-express",
		node: process.version,
		domainVersion: domain.domainVersion,
		domainFingerprint: fingerprint,
		stateEntries: state.size,
	});
});

app.post("/state/reset", (_req, res) => {
	state.clear();
	res.json({ ok: true, stateEntries: 0 });
});

app.post("/route", (req, res) => {
	const { task, policy = "deterministic", input = {}, constraints = {} } = req.body ?? {};
	if (!task) return res.status(400).json({ error: "task is required" });
	if (!["deterministic", "frugal", "naive"].includes(policy))
		return res.status(400).json({ error: "policy must be deterministic, frugal or naive" });

	const started = process.hrtime.bigint();
	let result;
	try {
		result = decide({ compiled, task, policy, input, constraints, state });
	} catch (error) {
		return res.status(400).json({ error: error.message });
	}
	const routingNanos = Number(process.hrtime.bigint() - started);

	if (policy === "deterministic" && result.decision.modelCalls > 0) {
		if (state.size >= STATE_LIMIT) state.clear();
		state.add(result.stateKey);
	}

	res.json({
		decision: result.decision,
		decisionHash: result.decisionHash,
		routingMicros: Number((routingNanos / 1000).toFixed(3)),
	});
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
	console.log(`routing-testbed-express on :${port} domain=${fingerprint}`);
});
