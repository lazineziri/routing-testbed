import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const domain = JSON.parse(readFileSync(join(here, "..", "domain.json"), "utf8"));

const stacks = [
	{ name: "express", url: process.env.EXPRESS_URL ?? "http://localhost:3001" },
	{ name: "dotnet", url: process.env.DOTNET_URL ?? "http://localhost:3002" },
];

const route = async (stack, body) => {
	const res = await fetch(`${stack.url}/route`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${stack.name} ${res.status}: ${await res.text()}`);
	return res.json();
};

const reset = (stack) => fetch(`${stack.url}/state/reset`, { method: "POST" });

const cases = [];
for (const task of domain.tasks) {
	for (const policy of ["deterministic", "frugal", "naive"]) {
		cases.push({ label: `${task.type} / ${policy}`, body: { task: task.type, policy, input: { seed: 1 } } });
		cases.push({
			label: `${task.type} / ${policy} / tight deadline`,
			body: { task: task.type, policy, input: { seed: 2 }, constraints: { deadlineMs: 1000 } },
		});
		cases.push({
			label: `${task.type} / ${policy} / cost ceiling`,
			body: { task: task.type, policy, input: { seed: 3 }, constraints: { costCeiling: 0.005 } },
		});
	}
}

await Promise.all(stacks.map(reset));

let agree = 0;
const mismatches = [];

for (const c of cases) {
	const [a, b] = await Promise.all(stacks.map((s) => route(s, c.body)));
	if (a.decisionHash === b.decisionHash) {
		agree += 1;
	} else {
		mismatches.push({
			label: c.label,
			express: { hash: a.decisionHash, decision: a.decision },
			dotnet: { hash: b.decisionHash, decision: b.decision },
		});
	}
}

console.log(`  cases: ${cases.length}   agree: ${agree}   mismatch: ${mismatches.length}`);
for (const m of mismatches) {
	console.log(`\n  MISMATCH  ${m.label}`);
	console.log(`    express ${m.express.hash}  ${JSON.stringify(m.express.decision)}`);
	console.log(`    dotnet  ${m.dotnet.hash}  ${JSON.stringify(m.dotnet.decision)}`);
}

process.exit(mismatches.length === 0 ? 0 : 1);
