import { createHash } from "node:crypto";

export const canonical = (value) => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
};

export const sha16 = (text) =>
	createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

export const hash = (value) => sha16(canonical(value));

export const domainFingerprint = (domain) => hash(domain);

// Everything below is derived once at startup. The request path only reads it.
export const compile = (domain) => {
	const tasks = new Map(domain.tasks.map((t) => [t.type, t]));

	const byCapability = new Map();
	for (const profile of domain.profiles) {
		if (!byCapability.has(profile.capability)) byCapability.set(profile.capability, []);
		byCapability.get(profile.capability).push(profile);
	}
	for (const list of byCapability.values()) {
		list.sort(
			(a, b) =>
				a.cost - b.cost ||
				a.latencyMs - b.latencyMs ||
				b.quality - a.quality ||
				a.id.localeCompare(b.id),
		);
	}

	const strongest = new Map();
	for (const [capability, list] of byCapability) {
		strongest.set(
			capability,
			[...list].sort((a, b) => b.quality - a.quality || a.id.localeCompare(b.id))[0],
		);
	}

	return { tasks, byCapability, strongest };
};

const isEligible = (profile, task, c) => {
	if (!profile.healthy) return false;
	if (profile.quality < task.qualityFloor) return false;
	if (c.deadlineMs != null && profile.latencyMs > c.deadlineMs) return false;
	if (c.costCeiling != null && profile.cost > c.costCeiling) return false;
	if (c.inputTokens != null && c.inputTokens > profile.maxInputTokens) return false;
	return true;
};

export const stateKey = (task, input) => hash({ task, input });

export const decide = ({ compiled, task: taskType, policy, input = {}, constraints = {}, state }) => {
	const task = compiled.tasks.get(taskType);
	if (!task) throw new Error(`unknown task: ${taskType}`);

	const key = stateKey(taskType, input);
	const steps = [];
	let modelCalls = 0;
	let cost = 0;
	let latencyMs = 0;
	let resolvedFromState = false;

	const usesState = policy === "deterministic";
	const picksCheapest = policy === "deterministic" || policy === "frugal";

	if (usesState && state?.has(key)) {
		resolvedFromState = true;
		steps.push({ capability: task.capabilities[0], kind: "state", provider: null, vendor: null, source: null });
	} else {
		for (const capability of task.capabilities) {
			const available = compiled.byCapability.get(capability);

			if (picksCheapest && task.maxModelCalls === 0) {
				steps.push({ capability, kind: "tool", provider: null, vendor: null, source: null });
				continue;
			}
			if (available === undefined || available.length === 0) {
				steps.push({ capability, kind: "tool", provider: null, vendor: null, source: null });
				continue;
			}

			let chosen = null;
			if (picksCheapest) {
				// Pre-sorted cost, latency, quality desc — first eligible wins.
				for (const profile of available) {
					if (isEligible(profile, task, constraints)) {
						chosen = profile;
						break;
					}
				}
			} else {
				chosen = compiled.strongest.get(capability);
			}

			if (chosen === null || chosen === undefined) {
				steps.push({ capability, kind: "unresolved", provider: null, vendor: null, source: null });
				continue;
			}

			steps.push({ capability, kind: "model", provider: chosen.id, vendor: chosen.provider, source: chosen.source });
			modelCalls += 1;
			cost += chosen.cost;
			latencyMs += chosen.latencyMs;
		}
	}

	const costMicros = Math.round(cost * 1e6);

	const decision = {
		policy,
		task: taskType,
		steps,
		modelCalls,
		resolvedFromState,
		estimatedCostMicros: costMicros,
		estimatedLatencyMs: latencyMs,
	};

	// Integers and strings only, so Node and .NET cannot disagree through
	// floating point formatting.
	let stepPart = "";
	for (let i = 0; i < steps.length; i += 1) {
		if (i > 0) stepPart += ";";
		stepPart += `${steps[i].capability}|${steps[i].kind}|${steps[i].provider ?? ""}|${steps[i].vendor ?? ""}`;
	}
	const fingerprint = `${policy}~${taskType}~${stepPart}~${modelCalls}~${resolvedFromState}~${costMicros}~${latencyMs}`;

	return { decision, decisionHash: sha16(fingerprint), stateKey: key };
};
