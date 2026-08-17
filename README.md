# routing-testbed

Two implementations of the same task-routing logic — one in Node/Express, one in .NET 10 — measured
side by side. It exists to answer one question with data rather than intuition:

> When routing decides *which* model to call, how much of the saving comes from picking a cheaper
> model, and how much from not calling one at all?

The answer on this workload: **most of it is model selection, not caching.** See below.

## Why two runtimes

Not to compare Node against .NET. The two exist so that every routing decision can be verified twice.
Both read the same `domain.json` and emit a canonical `decisionHash` over integers and strings only.
If the two independently written implementations produce identical hashes for the same input, the
decision logic is almost certainly right. `bench/crosscheck.mjs` asserts this across every task,
policy and constraint combination — currently 63 of 63.

## The problem being routed around

A request arrives: *draft an email to a supplier*. Several models could do it. Something has to
decide which one — or whether to call one at all. That decision is routing, and it happens before
any token is generated.

Routing here is a filter and a sort, not a score. Each candidate model passes or fails a set of
gates, and the survivors are ordered. Nothing is weighted, nothing is random, nothing reads a clock.

**The gates.** A model is eligible for a task only if it clears all of:

| Gate | Fails when |
| --- | --- |
| capability | the model cannot do this kind of work at all |
| health | the model is marked unavailable |
| quality floor | the model scores below what this task requires |
| deadline | its expected latency exceeds the request's budget |
| cost ceiling | its cost exceeds the request's budget |
| input capacity | the request is larger than its context window |

The quality floor is per-task, which is the important part. "Good enough" for a summary is not the
same bar as "good enough" for a legal draft, so a model that is unusable for one may be the obvious
choice for the other.

## The three policies

| Policy | Model choice | Reuses prior results | Exists to |
| --- | --- | --- | --- |
| `naive` | highest quality available | no | represent the reflex approach |
| `frugal` | cheapest that clears every gate | no | isolate the effect of model choice |
| `deterministic` | cheapest that clears every gate | yes | add reuse on top of that |

**`naive` always reaches for the strongest model.** It ignores cost, latency and every constraint
on the request. This is not a strawman — it is what most systems do first, because it is one line of
configuration and quality is never the thing that breaks. The bill is where it shows up: a "what is
our refund policy" lookup is charged at the same rate as a dense contract summary.

**`frugal` walks the candidates cheapest-first and takes the first one that clears every gate.**
The distinction that matters: this is not "use the cheap model". It is "use the cheapest model that
is still good enough for *this* task". When a task sets a high quality floor, frugal and naive
choose the same model — and frugal is not being frugal, it is being correct.

**`deterministic` does what frugal does, and first checks whether this exact work has already been
done.** If it has, the prior result is returned and no model is called at all.

## Why "deterministic" is the name

The property is that the same input always yields the same routing decision. No randomness, no
load balancing, no time-of-day behaviour. Given the request and the model registry, the decision is
a pure function.

That sounds like a nice-to-have and is actually the load-bearing part, because **determinism is what
makes reuse safe**. If routing varied — round-robin across providers, or shifting under load — then
a stored result could not be trusted to match what the system would produce now. Reuse is only sound
when the decision it came from is reproducible.

It buys three other things. A decision can be replayed, so a surprising route can be investigated
rather than guessed at. It can be audited, so you can say which model handled which request and
prove it. And it can be tested, which is what `bench/crosscheck.mjs` does across two independent
implementations.

## What the measurements showed

Splitting `frugal` out from `deterministic` is what makes the result legible, because the difference
between them is reuse and nothing else.

Most of the saving came from **choosing a cheaper model, not from skipping the call** — even on a
workload that was 59% repeats. Caching is the mechanism people reach for first, and it was the
smaller half by a wide margin.

The reason is that the two mechanisms have different reach. Reuse only helps on a repeat; a
first-time request cannot be served from a store that has never seen it. Model selection applies to
every request, including every first one. On this workload the repeats were frequent enough to
matter and still did not catch up.

Two caveats the numbers do not carry on their own. The no-model rate has a structural floor: five of
the seven task types have no model profile at all, so they can never produce a model call regardless
of policy. That share is task design, not routing. And routing overhead is single-digit microseconds
for all three policies, with trial-to-trial spread larger than the gaps between them — no policy here
is measurably slower to compute than another.

### Model profiles and provenance

Every profile in `domain.json` declares a `provider` and a `source`:

| `source` | Meaning |
| --- | --- |
| `synthetic` | Invented for this testbed. Internally consistent, tied to no real model. |
| `unverified` | Names a real product, but the numbers are placeholders that were typed in. |
| `measured` | Calibrated against a live deployment. Carries a `measurement` record. |

## Measuring a real provider

`bench/calibrate.mjs` replaces a profile's placeholder numbers with measurements from a real
endpoint. It is provider-agnostic: anything speaking OpenAI-compatible chat completions works —
a hosted API, a managed cloud endpoint, or a local Ollama or vLLM server.

```bash
cp .env.example .env      # url, auth style, key, model, prices
npm run calibrate
```

Four variables decide the provider:

| Variable | Meaning |
| --- | --- |
| `PROVIDER_URL` | The full chat completions URL, exactly as your provider documents it |
| `PROVIDER_AUTH` | `bearer` for most providers, `api-key` for some managed endpoints |
| `PROVIDER_API_KEY` | Your key |
| `PROVIDER_MODEL` | Sent in the body; leave empty when your provider puts the model in the URL path |

It sends one fixed prompt `CALIBRATE_SAMPLES` times, discards `CALIBRATE_WARMUP` cold-start calls,
then writes into `domain.json`:

- `latencyMs` — observed p50, with p95/min/max in the `measurement` record
- `cost` — computed from observed token counts and your per-1K prices, because responses carry no price
- `source: "measured"` plus provider, model, timestamp, sample count and the request shape used

Providers disagree about request parameters — some reject `max_tokens` and want
`max_completion_tokens`, some reject a non-default `temperature`. The client starts strict, drops
whatever the endpoint names as unsupported, and records the adaptation.

**`quality` is never written.** This harness cannot judge output quality, so that value stays as
declared and the record flags `qualityIsDeclaredNotMeasured`. It is also the factor that decides
whether routing to a cheaper model is acceptable at all.

Nothing is written if every call fails, so a bad URL or key leaves `domain.json` untouched. After
calibrating, restart both services — they read the file at startup.

Without any of this configured the testbed still runs end to end on the synthetic profiles, and the
report states that no figure came from a live provider.

### A warning from calibrating

Measured numbers change routing. If a measured cost lands below one of the synthetic profiles,
every policy that sorts by cost — `frugal` and `deterministic` both — will start routing through it.
Nothing about the router changes; only the numbers do. That is the whole argument for measuring
rather than guessing, and the reason a profile records where its numbers came from.

## Placeholder profiles

Every profile shipped in `domain.json` is `synthetic`: invented for this testbed, internally
consistent, and tied to no real model. They exist so the routing behaviour can be exercised and
compared without anyone needing an account.

That means the cost figures in the committed report describe the policies' *choices*, priced with
made-up constants. The ratios between policies are meaningful; the absolute numbers are not a bill.
Calibrate a profile against your own provider to replace them.

## Running it

```bash
cd express && npm install && PORT=3001 npm start   # terminal 1
cd dotnet  && PORT=3002 dotnet run                 # terminal 2

node bench/crosscheck.mjs   # 63/63 decisions must match
node bench/bench.mjs        # writes results/<run>.json
node bench/report.mjs       # regenerates public/index.html
```

Then open <http://localhost:3001/> or <http://localhost:3002/> — both serve the generated report at `/`.

Requires Node 20+ and the .NET 10 SDK.

### Knobs

All read from the environment by `bench/bench.mjs`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKLOAD` | 2000 | requests per policy per trial |
| `WARMUP` | 200 | discarded before measuring |
| `TRIALS` | 5 | repetitions of each timing measurement |
| `REPEAT_RATE` | 0.6 | share of requests that repeat an earlier input |
| `CONCURRENCY` | 32 | workers for the throughput and race tests |
| `DETERMINISM_RUNS` | 500 | sequential determinism repetitions |

`STATE_LIMIT` (default 100000) bounds the in-memory state store in both services.

## What it measures, and what it does not

Being precise about this is the point of the project.

**Measured directly**

- Routing overhead — wall-clock inside the decision function, p50/p95/p99
- Throughput — decisions per second under concurrency
- Determinism — distinct decision hashes over N runs, sequential and concurrent
- Cross-runtime agreement — identical hashes from two independent implementations
- Model calls avoided — a count, not an estimate

**Not measured**

- **Real money.** No provider is called. "Cost units" are the policy's choices multiplied by fixed
  constants in `domain.json`. The *ratio* between policies is meaningful; the absolute figure is not a bill.
- **Provider latency.** Same reasoning. A real deployment adds network variance, rate limits and retries.
- **Output quality.** The cheaper model is assumed to clear the task's quality floor because the
  profile table says so. Whether its output is actually good enough is the question this testbed
  cannot answer — and it is the one that decides whether frugal routing is a good idea at all.

One more caveat worth stating plainly: the no-model rate has a structural floor. Five of the seven task
types have no model profile at all, so they can never produce a model call. That share is a property of
the task registry, not an achievement of the router.

## On measurement noise

An earlier single run of this benchmark appeared to show deterministic routing costing about 4µs more
per decision than naive. Five trials showed that was scheduler noise — the spread between trials is
larger than the gap between policies. The harness now runs every timing measurement `TRIALS` times and
reports the median with its spread, and the report refuses to claim a difference smaller than the noise.

Counts behave differently. Model calls, cost units and no-model rates were identical across every trial
and both runtimes, so those are reported as exact figures.

## Layout

```
domain.json          task types and model profiles, read by both services
express/             Node 20+ / Express 5 implementation
dotnet/              .NET 10 / ASP.NET Core implementation
bench/
  crosscheck.mjs     asserts both runtimes agree, decision for decision
  bench.mjs          runs the workload, writes results/<run>.json
  calibrate.mjs      replaces a profile's placeholders with real measurements
  report.mjs         renders public/index.html from the newest run
public/index.html    generated report, served at / by both services
results/             one archived JSON per run, named by start time
```

Both services expose the same HTTP contract:

- `GET /health` — runtime, domain version and fingerprint, state size
- `POST /route` — `{ task, policy, input, constraints }` → decision, `decisionHash`, `routingMicros`
- `POST /state/reset` — clears the state store, used between benchmark phases

## Adding a task or model

Edit `domain.json` only. Both services read it at startup and print its fingerprint on `/health`;
if the two fingerprints disagree, the comparison is invalid and `crosscheck.mjs` will say so.

## License

MIT.
