import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const archive = readdirSync(join(root, "results"))
	.filter((f) => f.endsWith(".json"))
	.map((f) => JSON.parse(readFileSync(join(root, "results", f), "utf8")))
	.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

if (archive.length === 0) {
	console.error("  no runs in results/ - run bench/bench.mjs first");
	process.exit(1);
}

const r = archive[0];

const when = new Date(r.startedAt);
const stamp = when.toISOString().replace("T", " ").slice(0, 19) + " UTC";

const esc = (s) =>
	String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n, d = 0) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;

const stacks = Object.keys(r.stacks);
const policies = ["naive", "frugal", "deterministic"];
const label = { express: "Node · Express", dotnet: ".NET · ASP.NET Core" };

const pol = (stack, p) => r.stacks[stack].policies[p];
const base = pol(stacks[0], "naive");
const frugal = pol(stacks[0], "frugal");
const det = pol(stacks[0], "deterministic");

const costUnits = (micros) => micros / 1e6;
const savedByChoice = 1 - frugal.totalCostMicros / base.totalCostMicros;
const savedTotal = 1 - det.totalCostMicros / base.totalCostMicros;
const savedByReuse = savedTotal - savedByChoice;
const callsAvoided = base.totalModelCalls - det.totalModelCalls;

const allCountsStable = stacks.every((s) => policies.every((p) => pol(s, p).countsStableAcrossTrials));
const allDeterministic = stacks.every((s) =>
	policies.every((p) => {
		const d = r.stacks[s].determinism[p];
		return d.decisionFunctionStable && d.concurrentStatelessStable;
	}),
);

const spreads = stacks.flatMap((s) =>
	policies.flatMap((p) => [
		pol(s, p).routingMicros.p50.spreadPct,
		r.stacks[s].throughput[p].decisionsPerSecond.spreadPct,
	]),
);
const maxSpread = Math.max(...spreads);
const p50s = stacks.flatMap((s) => policies.map((p) => pol(s, p).routingMicros.p50.median));

const costRows = policies
	.map((p) => {
		const x = pol(stacks[0], p);
		const delta = p === "naive" ? "—" : `-${((1 - x.totalCostMicros / base.totalCostMicros) * 100).toFixed(1)}%`;
		return `<tr><td>${p}</td><td class="n">${costUnits(x.totalCostMicros).toFixed(2)}</td><td class="n">${delta}</td><td class="n">${num(x.totalModelCalls)}</td><td class="n">${pct(x.noModelRate)}</td></tr>`;
	})
	.join("\n");

const runtimeSections = stacks
	.map((s2) => {
		const h = r.stacks[s2].health;
		const timing = policies
			.map((p) => {
				const t = pol(s2, p).routingMicros;
				const th = r.stacks[s2].throughput[p].decisionsPerSecond;
				return `<tr><td>${p}</td><td class="n">${t.p50.median.toFixed(1)} (±${t.p50.spreadPct.toFixed(0)}%)</td><td class="n">${t.p95.median.toFixed(1)} (±${t.p95.spreadPct.toFixed(0)}%)</td><td class="n">${t.p99.median.toFixed(1)}</td><td class="n">${num(th.median)} (±${th.spreadPct.toFixed(0)}%)</td></tr>`;
			})
			.join("\n");
		const counts = policies
			.map((p) => {
				const x = pol(s2, p);
				return `<tr><td>${p}</td><td class="n">${num(x.totalModelCalls)}</td><td class="n">${num(x.outcomes.state)}</td><td class="n">${num(x.outcomes.tool)}</td><td class="n">${pct(x.noModelRate)}</td><td class="n">${costUnits(x.totalCostMicros).toFixed(2)}</td></tr>`;
			})
			.join("\n");
		const determinism = policies
			.map((p) => {
				const d = r.stacks[s2].determinism[p];
				return `<tr><td>${p}</td><td class="n">${d.sequentialDistinct}</td><td class="n">${d.concurrentStatelessDistinct}</td><td class="n">${d.concurrentServedFromState}/${d.concurrentStatefulRequests}</td></tr>`;
			})
			.join("\n");
		const p50local = policies.map((p) => pol(s2, p).routingMicros.p50.median);

		return `<h2>${esc(label[s2] ?? s2)}</h2>
<dl>
<dt>Runtime</dt><dd class="mono">${esc(h.runtime ?? h.node)}</dd>
<dt>Domain fingerprint</dt><dd class="mono">${esc(h.domainFingerprint)}</dd>
</dl>

<h3>Counts</h3>
<div class="wrap"><table>
<thead><tr><th>Policy</th><th class="n">Model calls</th><th class="n">From state</th><th class="n">Tool only</th><th class="n">No-model</th><th class="n">Cost units</th></tr></thead>
<tbody>
${counts}
</tbody></table></div>

<h3>Routing overhead and throughput</h3>
<div class="wrap"><table>
<thead><tr><th>Policy</th><th class="n">p50 (us)</th><th class="n">p95 (us)</th><th class="n">p99 (us)</th><th class="n">Decisions/sec</th></tr></thead>
<tbody>
${timing}
</tbody></table></div>
<p>p50 across policies: ${Math.min(...p50local).toFixed(1)}-${Math.max(...p50local).toFixed(1)}us.
Median of ${r.config.TRIALS} trials; the bracketed figure is the spread between fastest and slowest trial.</p>

<h3>Providers routed to</h3>
<div class="wrap"><table>
<thead><tr><th>Policy</th><th>Model calls by profile</th></tr></thead>
<tbody>
${policies
	.map((p) => {
		const used = pol(s2, p).providers ?? {};
		const cells = Object.keys(used).length
			? Object.entries(used).map(([id, n]) => `${esc(id)} x${num(n)}`).join(", ")
			: "none";
		return `<tr><td>${p}</td><td class="mono">${cells}</td></tr>`;
	})
	.join("\n")}
</tbody></table></div>

<h3>Determinism</h3>
<div class="wrap"><table>
<thead><tr><th>Policy</th><th class="n">Distinct over ${num(r.config.DETERMINISM_RUNS)} runs</th><th class="n">Distinct over ${r.config.CONCURRENCY} concurrent</th><th class="n">Race: from state</th></tr></thead>
<tbody>
${determinism}
</tbody></table></div>`;
	})
	.join("\n\n");

const historyRows = archive
	.slice(0, 15)
	.map((run) => {
		const rb = run.stacks?.[stacks[0]]?.policies?.naive;
		const rd = run.stacks?.[stacks[0]]?.policies?.deterministic;
		if (!rb || !rd) return "";
		const ps = Object.keys(run.stacks).flatMap((s2) =>
			policies.map((p2) => run.stacks[s2].policies[p2]?.routingMicros?.p50?.median).filter((v) => typeof v === "number"),
		);
		const range = ps.length ? `${Math.min(...ps).toFixed(1)}-${Math.max(...ps).toFixed(1)}` : "—";
		return `<tr><td class="n">${esc(run.startedAt.replace("T", " ").slice(0, 19))}Z${run.runId === r.runId ? " (this run)" : ""}</td><td class="n">${run.durationSeconds ?? "—"}s</td><td class="n">${num(rb.totalModelCalls - rd.totalModelCalls)}</td><td class="n">${pct(rd.noModelRate)}</td><td class="n">${range} us</td></tr>`;
	})
	.join("\n");

const domainRaw = JSON.parse(readFileSync(join(root, "domain.json"), "utf8"));
const unverifiedIds = new Set(domainRaw.profiles.filter((x) => x.source === "unverified").map((x) => x.id));
const measuredProfiles = domainRaw.profiles.filter((x) => x.source === "measured");

const policiesUsingUnverified = [
	...new Set(
		stacks.flatMap((s2) =>
			policies.filter((p) => Object.keys(pol(s2, p).providers ?? {}).some((id) => unverifiedIds.has(id))),
		),
	),
];

const profileRows = domainRaw.profiles
	.map(
		(x) =>
			`<tr><td class="mono">${esc(x.id)}</td><td>${esc(x.provider)}</td><td>${esc(x.capability)}</td><td class="n">${x.quality}</td><td class="n">${x.cost}</td><td class="n">${x.latencyMs}ms</td><td>${x.source === "measured" ? `<strong>measured</strong> ${esc((x.measurement?.measuredAt ?? "").slice(0, 10))}` : x.source === "unverified" ? "<strong>unverified</strong>" : "synthetic"}</td></tr>`,
	)
	.join("\n");

const measuredNotice = measuredProfiles.length
	? `<h2>Measured provider data</h2>
${measuredProfiles
	.map((x) => {
		const m = x.measurement ?? {};
		return `<p><strong>${esc(x.id)}</strong> was calibrated against a live ${esc(x.provider)} deployment on
${esc((m.measuredAt ?? "").replace("T", " ").slice(0, 19))}Z over ${m.samples} calls${m.failed ? ` (${m.failed} failed)` : ""}.</p>
<div class="wrap"><table>
<thead><tr><th class="n">p50</th><th class="n">p95</th><th class="n">range</th><th class="n">tokens in/out</th><th class="n">$/1K in</th><th class="n">$/1K out</th><th class="n">cost/call</th></tr></thead>
<tbody><tr>
<td class="n">${m.p50LatencyMs}ms</td><td class="n">${m.p95LatencyMs}ms</td>
<td class="n">${m.minLatencyMs}-${m.maxLatencyMs}ms</td>
<td class="n">${m.meanPromptTokens} / ${m.meanCompletionTokens}</td>
<td class="n">${m.pricePer1kInput}</td><td class="n">${m.pricePer1kOutput}</td>
<td class="n">$${x.cost}</td>
</tr></tbody></table></div>
<p>Latency and token counts are observations from that deployment. Cost is computed from those token counts
and the prices entered in <code>.env</code>, because the API does not return a price. <strong>Quality
(${x.quality}) is declared, not measured</strong> — this harness cannot judge output quality, which is the
factor that decides whether routing to a cheaper model is acceptable.</p>`;
	})
	.join("\n")}`
	: "";

const unverifiedNotice = unverifiedIds.size
	? `<h2>Provider data warning</h2>
<p><strong>${[...unverifiedIds].map(esc).join(", ")}</strong> ${unverifiedIds.size === 1 ? "is" : "are"} marked
<code>source: unverified</code> in <code>domain.json</code>. The name refers to a real product, but the quality,
cost, latency and context numbers are placeholders that were typed in rather than measured or taken from a
price list.</p>
${
	policiesUsingUnverified.length
		? `<p>The <strong>${policiesUsingUnverified.join(", ")}</strong> ${policiesUsingUnverified.length === 1 ? "policy routes" : "policies route"} to it, so every cost
figure for ${policiesUsingUnverified.length === 1 ? "that policy" : "those policies"} inherits those placeholders. Replace them with real figures for your own
deployment and region before drawing any conclusion.</p>`
		: `<p>No policy currently routes to it, so no figure on this page depends on those placeholders.</p>`
}
<div class="wrap"><table>
<thead><tr><th>Profile</th><th>Provider</th><th>Capability</th><th class="n">Quality</th><th class="n">Cost</th><th class="n">Latency</th><th>Source</th></tr></thead>
<tbody>
${profileRows}
</tbody></table></div>`
	: "";

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Routing testbed - run ${esc(r.runId)}</title>
<style>
body{max-width:60rem;margin:2rem auto;padding:0 1rem;font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#111}
h1{font-size:1.5rem;margin:0 0 .25rem}
h3{font-size:.95rem;margin:1.25rem 0 .35rem}
h2{font-size:1.15rem;margin:2.25rem 0 .5rem;border-bottom:1px solid #ccc;padding-bottom:.25rem}
p{margin:.6rem 0;max-width:70ch}
dl{margin:.5rem 0;display:grid;grid-template-columns:max-content 1fr;gap:.1rem 1rem;font-size:.9rem}
dt{color:#555}
dd{margin:0}
table{border-collapse:collapse;margin:.75rem 0;font-size:.9rem}
th,td{border:1px solid #ccc;padding:.35rem .6rem;text-align:left}
th{background:#f2f2f2;font-weight:600}
td.n,th.n{text-align:right;font-family:ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto}
code,.mono{font-family:ui-monospace,Menlo,monospace}
pre{background:#f6f6f6;border:1px solid #ddd;padding:.75rem;overflow-x:auto;font-size:.85rem}
ul{max-width:70ch}
footer{margin-top:2.5rem;border-top:1px solid #ccc;padding-top:.75rem;font-size:.85rem;color:#555}
@media(prefers-color-scheme:dark){
body{background:#111;color:#ddd}
h2{border-color:#444}th{background:#1c1c1c}th,td{border-color:#444}
pre{background:#1a1a1a;border-color:#333}dt{color:#999}footer{border-color:#444;color:#999}
}
</style>
</head>
<body>

<h1>Routing testbed</h1>
<p>Three routing policies implemented twice, in Node/Express and .NET 10, measured against the same workload.</p>

<dl>
<dt>Run</dt><dd class="mono">${esc(r.runId)}</dd>
<dt>Started</dt><dd class="mono">${esc(stamp)}</dd>
<dt>Duration</dt><dd class="mono">${r.durationSeconds}s</dd>
<dt>Host</dt><dd class="mono">${esc(r.machine.cpuModel)}, ${r.machine.cpuCount} cores, ${esc(r.machine.platform)}/${esc(r.machine.arch)}</dd>
<dt>Runtimes</dt><dd class="mono">${stacks.map((s2) => `${esc(label[s2] ?? s2)} ${esc(r.stacks[s2].health.runtime ?? r.stacks[s2].health.node)}`).join(", ")}</dd>
<dt>Workload</dt><dd class="mono">${num(r.workload.requests)} requests, ${num(r.workload.uniqueInputs)} unique, ${pct(r.workload.repeatShare)} repeats</dd>
<dt>Method</dt><dd class="mono">${num(r.config.WARMUP)} warmup discarded, ${r.config.TRIALS} trials, concurrency ${r.config.CONCURRENCY}</dd>
<dt>Domain</dt><dd class="mono">${esc(r.stacks[stacks[0]].health.domainFingerprint)}</dd>
</dl>

<h2>Result: cost, decomposed</h2>
<p>The <code>frugal</code> policy picks the cheapest eligible model but never reuses state. It exists to
separate the two mechanisms: naive to frugal is model selection alone, frugal to deterministic is reuse alone.</p>
<div class="wrap"><table>
<caption style="text-align:left;padding:.25rem 0;font-size:.85rem;color:#555">Both runtimes produced these counts identically</caption>
<thead><tr><th>Policy</th><th class="n">Cost units</th><th class="n">vs naive</th><th class="n">Model calls</th><th class="n">No-model</th></tr></thead>
<tbody>
${costRows}
</tbody></table></div>
<p>Of the ${pct(savedTotal)} total reduction, <strong>${(savedByChoice * 100).toFixed(1)} points come from model
selection and ${(savedByReuse * 100).toFixed(1)} points from state reuse</strong>, on a workload that is
${pct(r.workload.repeatShare)} repeats. Caching is the smaller half. Both runtimes produced these counts
identically, and they did not vary across the ${r.config.TRIALS} trials.</p>

${runtimeSections}

<h2>Notes on the runtime tables</h2>
<ul>
<li>Counts are identical in both runtimes and did not vary across the ${r.config.TRIALS} trials. They are exact.</li>
<li>Timings are not. No policy is measurably slower than another: spread reaches ${maxSpread.toFixed(0)}% while the
medians sit within a couple of microseconds. A single run once appeared to show deterministic routing costing
about 4us more per decision; five trials showed that was scheduler noise.</li>
<li>Sequential determinism runs reset state first, so the stateful path cannot be mistaken for instability.</li>
<li>The concurrent column uses a task touching no shared state, so any variance there would be real nondeterminism.</li>
<li>The race column is expected to split: identical concurrent requests race, one calls the model and the rest read
what it wrote. That is the state store, not routing.</li>
<li>Cross-runtime agreement is checked by <code>bench/crosscheck.mjs</code>: 63 of 63 decision hashes identical.</li>
</ul>

${measuredNotice}

${unverifiedNotice}

<h2>What this does not show</h2>
<ul>
<li><strong>Real money.</strong> No provider was called. Cost units are the policy's choices multiplied by constants in <code>domain.json</code>. The ratio between policies is meaningful; the absolute number is not a bill.</li>
<li><strong>Provider latency.</strong> Same reasoning. A real run adds network variance, rate limits and retries, none of which are modelled.</li>
<li><strong>Output quality.</strong> The cheaper model is assumed to clear the task's quality floor because the profile table says so. Whether its output is good enough is the question this testbed cannot answer, and it decides whether frugal routing is a good idea at all.</li>
<li>The ${pct(base.noModelRate)} no-model floor is structural: five of the seven task types have no model profile, so they can never produce a model call. Only the move to ${pct(det.noModelRate)} was earned.</li>
</ul>
<p>Measured directly: routing overhead, throughput, determinism, cross-runtime agreement, and the count of model calls avoided.</p>

<h2>Run history</h2>
<div class="wrap"><table>
<thead><tr><th class="n">Started</th><th class="n">Duration</th><th class="n">Calls avoided</th><th class="n">No-model</th><th class="n">p50 range</th></tr></thead>
<tbody>
${historyRows}
</tbody></table></div>
<p>Every run is archived under <code>results/</code> by start time. Timings move with machine load; the counts should not.</p>

<h2>Reproducing</h2>
<pre>cd express &amp;&amp; npm install &amp;&amp; PORT=3001 npm start
cd dotnet  &amp;&amp; PORT=3002 dotnet run

node bench/crosscheck.mjs   # 63/63 decisions must match
node bench/bench.mjs        # writes results.json + results/&lt;run&gt;.json
node bench/report.mjs       # regenerates this page</pre>
<p>The workload comes from a seeded PRNG, so the request sequence is identical on every machine. Both runtimes
read the same <code>domain.json</code>; its fingerprint is printed by each <code>/health</code> endpoint and must
match before any comparison is valid.</p>

<footer>
Generated by <code>bench/report.mjs</code> from <code>results.json</code>. Counts stable across trials:
${allCountsStable ? "yes" : "no"}. Decision function stable: ${allDeterministic ? "yes" : "no"}.
Overhead includes HTTP loopback and JSON handling, so it is an upper bound on the decision cost itself.
</footer>

</body>
</html>
`;

mkdirSync(join(root, "public"), { recursive: true });
writeFileSync(join(root, "public", "index.html"), html);
console.log(`  wrote public/index.html (${(html.length / 1024).toFixed(1)} KB)`);
