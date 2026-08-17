using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using RoutingTestbed;

var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(options =>
{
	options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
	options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.Never;
});

var app = builder.Build();

var publicDir = Path.GetDirectoryName(FindRepoFile("domain.json")) is string repoRoot ? Path.Combine(repoRoot, "public") : "";
if (Directory.Exists(publicDir))
{
	app.UseDefaultFiles(new DefaultFilesOptions
	{
		FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(publicDir),
	});
	app.UseStaticFiles(new StaticFileOptions
	{
		FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(publicDir),
	});
}

static string FindRepoFile(string name)
{
	var dir = new DirectoryInfo(AppContext.BaseDirectory);
	while (dir is not null)
	{
		var candidate = Path.Combine(dir.FullName, name);
		if (File.Exists(candidate)) return candidate;
		dir = dir.Parent;
	}
	throw new FileNotFoundException($"{name} not found above {AppContext.BaseDirectory}");
}

var domainPath = FindRepoFile("domain.json");
var rawDomain = File.ReadAllText(domainPath);
var domain = JsonSerializer.Deserialize<Domain>(rawDomain)
	?? throw new InvalidOperationException("domain.json could not be parsed");
var fingerprint = Router.DomainFingerprint(rawDomain);
var compiled = CompiledDomain.From(domain);

var stateLimit = int.TryParse(Environment.GetEnvironmentVariable("STATE_LIMIT"), out var sl) ? sl : 100_000;
var state = new HashSet<string>();
var gate = new Lock();

app.MapGet("/health", () => Results.Json(new
{
	ok = true,
	stack = "dotnet-aspnetcore",
	runtime = Environment.Version.ToString(),
	domainVersion = domain.DomainVersion,
	domainFingerprint = fingerprint,
	stateEntries = state.Count,
}));

app.MapPost("/state/reset", () =>
{
	lock (gate) state.Clear();
	return Results.Json(new { ok = true, stateEntries = 0 });
});

app.MapPost("/route", (RouteRequest request) =>
{
	if (string.IsNullOrWhiteSpace(request.Task))
		return Results.Json(new { error = "task is required" }, statusCode: 400);

	var policy = string.IsNullOrWhiteSpace(request.Policy) ? "deterministic" : request.Policy;
	if (policy is not ("deterministic" or "frugal" or "naive"))
		return Results.Json(new { error = "policy must be deterministic, frugal or naive" }, statusCode: 400);

	var input = request.Input.ValueKind == JsonValueKind.Undefined
		? JsonDocument.Parse("{}").RootElement
		: request.Input;

	var constraints = request.Constraints ?? new Constraints();

	var started = Stopwatch.GetTimestamp();
	RouteResult result;
	try
	{
		lock (gate)
		{
			result = Router.Decide(compiled, request.Task, policy, input, constraints, state);
			if (policy == "deterministic" && result.Decision.ModelCalls > 0)
			{
				if (state.Count >= stateLimit) state.Clear();
				state.Add(result.StateKey);
			}
		}
	}
	catch (ArgumentException ex)
	{
		return Results.Json(new { error = ex.Message }, statusCode: 400);
	}
	var micros = Stopwatch.GetElapsedTime(started).TotalMicroseconds;

	return Results.Json(new
	{
		decision = result.Decision,
		decisionHash = result.DecisionHash,
		routingMicros = Math.Round(micros, 3),
	});
});

app.Run($"http://localhost:{Environment.GetEnvironmentVariable("PORT") ?? "3002"}");

public sealed record RouteRequest(string Task, string? Policy, JsonElement Input, Constraints? Constraints);
