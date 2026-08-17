using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RoutingTestbed;

public sealed record Profile(
	[property: JsonPropertyName("id")] string Id,
	[property: JsonPropertyName("capability")] string Capability,
	[property: JsonPropertyName("quality")] double Quality,
	[property: JsonPropertyName("cost")] double Cost,
	[property: JsonPropertyName("latencyMs")] int LatencyMs,
	[property: JsonPropertyName("maxInputTokens")] int MaxInputTokens,
	[property: JsonPropertyName("healthy")] bool Healthy,
	[property: JsonPropertyName("provider")] string Provider = "synthetic",
	[property: JsonPropertyName("source")] string Source = "synthetic");

public sealed record TaskDefinition(
	[property: JsonPropertyName("type")] string Type,
	[property: JsonPropertyName("capabilities")] string[] Capabilities,
	[property: JsonPropertyName("maxModelCalls")] int MaxModelCalls,
	[property: JsonPropertyName("qualityFloor")] double QualityFloor);

public sealed record Domain(
	[property: JsonPropertyName("domainVersion")] string DomainVersion,
	[property: JsonPropertyName("profiles")] Profile[] Profiles,
	[property: JsonPropertyName("tasks")] TaskDefinition[] Tasks);

public sealed record Constraints(
	int? DeadlineMs = null,
	double? CostCeiling = null,
	int? InputTokens = null);

public sealed record Step(string Capability, string Kind, string? Provider, string? Vendor, string? Source);

public sealed record Decision(
	string Policy,
	string Task,
	IReadOnlyList<Step> Steps,
	int ModelCalls,
	bool ResolvedFromState,
	long EstimatedCostMicros,
	int EstimatedLatencyMs);

public sealed record RouteResult(Decision Decision, string DecisionHash, string StateKey);

public sealed class CompiledDomain
{
	public required Dictionary<string, TaskDefinition> Tasks { get; init; }
	public required Dictionary<string, Profile[]> ByCapability { get; init; }
	public required Dictionary<string, Profile> Strongest { get; init; }

	public static CompiledDomain From(Domain domain)
	{
		var byCapability = domain.Profiles
			.GroupBy(p => p.Capability)
			.ToDictionary(
				g => g.Key,
				g => g.OrderBy(p => p.Cost)
					.ThenBy(p => p.LatencyMs)
					.ThenByDescending(p => p.Quality)
					.ThenBy(p => p.Id, StringComparer.Ordinal)
					.ToArray());

		return new CompiledDomain
		{
			Tasks = domain.Tasks.ToDictionary(t => t.Type),
			ByCapability = byCapability,
			Strongest = byCapability.ToDictionary(
				kv => kv.Key,
				kv => kv.Value.OrderByDescending(p => p.Quality)
					.ThenBy(p => p.Id, StringComparer.Ordinal)
					.First()),
		};
	}
}

public static class Router
{
	public static string Sha16(string value)
	{
		var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
		return Convert.ToHexStringLower(bytes)[..16];
	}

	public static string DomainFingerprint(string rawJson)
	{
		using var doc = JsonDocument.Parse(rawJson);
		return Sha16(Canonical(doc.RootElement));
	}

	private static string Canonical(JsonElement element) => element.ValueKind switch
	{
		JsonValueKind.Object => "{" + string.Join(",", element.EnumerateObject()
			.OrderBy(p => p.Name, StringComparer.Ordinal)
			.Select(p => JsonSerializer.Serialize(p.Name) + ":" + Canonical(p.Value))) + "}",
		JsonValueKind.Array => "[" + string.Join(",", element.EnumerateArray().Select(Canonical)) + "]",
		JsonValueKind.String => JsonSerializer.Serialize(element.GetString()),
		JsonValueKind.Number => FormatNumber(element.GetDouble()),
		JsonValueKind.True => "true",
		JsonValueKind.False => "false",
		_ => "null",
	};

	private static string FormatNumber(double value) =>
		value == Math.Floor(value) && Math.Abs(value) < 1e15
			? ((long)value).ToString(CultureInfo.InvariantCulture)
			: value.ToString("R", CultureInfo.InvariantCulture);

	public static string StateKey(string task, JsonElement input) =>
		Sha16("{\"input\":" + Canonical(input) + ",\"task\":" + JsonSerializer.Serialize(task) + "}");

	private static List<string> Rejections(Profile p, string capability, TaskDefinition task, Constraints c)
	{
		var reasons = new List<string>();
		if (p.Capability != capability) reasons.Add("capability");
		if (!p.Healthy) reasons.Add("unhealthy");
		if (p.Quality < task.QualityFloor) reasons.Add("quality-floor");
		if (c.DeadlineMs is int d && p.LatencyMs > d) reasons.Add("deadline");
		if (c.CostCeiling is double cc && p.Cost > cc) reasons.Add("cost-ceiling");
		if (c.InputTokens is int it && it > p.MaxInputTokens) reasons.Add("input-capacity");
		return reasons;
	}

	private static bool IsEligible(Profile p, TaskDefinition task, Constraints c)
	{
		if (!p.Healthy) return false;
		if (p.Quality < task.QualityFloor) return false;
		if (c.DeadlineMs is int d && p.LatencyMs > d) return false;
		if (c.CostCeiling is double cc && p.Cost > cc) return false;
		if (c.InputTokens is int it && it > p.MaxInputTokens) return false;
		return true;
	}

	public static RouteResult Decide(
		CompiledDomain domain, string taskType, string policy, JsonElement input, Constraints constraints, HashSet<string> state)
	{
		if (!domain.Tasks.TryGetValue(taskType, out var task))
			throw new ArgumentException($"unknown task: {taskType}");

		var key = StateKey(taskType, input);
		var steps = new List<Step>(task.Capabilities.Length);
		var modelCalls = 0;
		var cost = 0d;
		var latencyMs = 0;
		var resolvedFromState = false;

		var usesState = policy == "deterministic";
		var picksCheapest = policy is "deterministic" or "frugal";

		if (usesState && state.Contains(key))
		{
			resolvedFromState = true;
			steps.Add(new Step(task.Capabilities[0], "state", null, null, null));
		}
		else
		{
			foreach (var capability in task.Capabilities)
			{
				if (picksCheapest && task.MaxModelCalls == 0)
				{
					steps.Add(new Step(capability, "tool", null, null, null));
					continue;
				}
				if (!domain.ByCapability.TryGetValue(capability, out var available) || available.Length == 0)
				{
					steps.Add(new Step(capability, "tool", null, null, null));
					continue;
				}

				Profile? chosen = null;
				if (picksCheapest)
				{
					// Pre-sorted cost, latency, quality desc - first eligible wins.
					foreach (var profile in available)
					{
						if (IsEligible(profile, task, constraints)) { chosen = profile; break; }
					}
				}
				else
				{
					chosen = domain.Strongest[capability];
				}

				if (chosen is null)
				{
					steps.Add(new Step(capability, "unresolved", null, null, null));
					continue;
				}

				steps.Add(new Step(capability, "model", chosen.Id, chosen.Provider, chosen.Source));
				modelCalls += 1;
				cost += chosen.Cost;
				latencyMs += chosen.LatencyMs;
			}
		}

		var costMicros = (long)Math.Round(cost * 1_000_000d, MidpointRounding.AwayFromZero);

		var decision = new Decision(policy, taskType, steps, modelCalls, resolvedFromState, costMicros, latencyMs);

		var sb = new StringBuilder(128);
		sb.Append(policy).Append('~').Append(taskType).Append('~');
		for (var i = 0; i < steps.Count; i++)
		{
			if (i > 0) sb.Append(';');
			sb.Append(steps[i].Capability).Append('|').Append(steps[i].Kind).Append('|').Append(steps[i].Provider ?? string.Empty).Append('|').Append(steps[i].Vendor ?? string.Empty);
		}
		sb.Append('~').Append(modelCalls.ToString(CultureInfo.InvariantCulture))
		  .Append('~').Append(resolvedFromState ? "true" : "false")
		  .Append('~').Append(costMicros.ToString(CultureInfo.InvariantCulture))
		  .Append('~').Append(latencyMs.ToString(CultureInfo.InvariantCulture));
		var fingerprint = sb.ToString();

		return new RouteResult(decision, Sha16(fingerprint), key);
	}
}
