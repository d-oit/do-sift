/**
 * #67: in-process counters rendered as Prometheus text exposition. Fed only
 * by the redacted operational events (method/route/status/outcome counts and
 * suspect-evidence counts). Labels come from fixed sets so unknown request
 * paths cannot grow cardinality without bound.
 */
import type { OperationalEvent } from "./server.js";

const KNOWN_ROUTES = new Set([
  "/",
  "/index.html",
  "/healthz",
  "/readyz",
  "/metrics",
  "/api/research",
  "/api/answer",
]);

export class MetricsRegistry {
  private readonly requests = new Map<string, number>();
  private readonly durationSumMs = new Map<string, number>();
  private readonly durationCount = new Map<string, number>();
  private suspectEvents = 0;
  private suspectPassages = 0;

  /** Record one operational event. Never throws into the request path. */
  observe(event: OperationalEvent): void {
    if (event.type === "answer.suspect") {
      this.suspectEvents += 1;
      this.suspectPassages += event.passages;
      return;
    }
    const route = KNOWN_ROUTES.has(event.path) ? event.path : "other";
    const key = `${event.method}\u0000${route}\u0000${event.outcome}\u0000${event.status}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    const routeKey = `${route}\u0000${event.outcome}`;
    this.durationSumMs.set(routeKey, (this.durationSumMs.get(routeKey) ?? 0) + event.durationMs);
    this.durationCount.set(routeKey, (this.durationCount.get(routeKey) ?? 0) + 1);
  }

  /** Prometheus text format (version 0.0.4). Values are counters only. */
  render(): string {
    const lines: string[] = [];
    lines.push(
      "# HELP do_sift_http_requests_total HTTP requests by method, route, outcome, and status.",
    );
    lines.push("# TYPE do_sift_http_requests_total counter");
    for (const [key, value] of [...this.requests.entries()].sort()) {
      const [method, route, outcome, status] = key.split("\u0000");
      lines.push(
        `do_sift_http_requests_total{method="${method}",route="${route}",outcome="${outcome}",status="${status}"} ${value}`,
      );
    }
    lines.push(
      "# HELP do_sift_http_request_duration_ms_sum Sum of request durations in milliseconds.",
    );
    lines.push("# TYPE do_sift_http_request_duration_ms_sum counter");
    for (const [key, value] of [...this.durationSumMs.entries()].sort()) {
      const [route, outcome] = key.split("\u0000");
      lines.push(
        `do_sift_http_request_duration_ms_sum{route="${route}",outcome="${outcome}"} ${value}`,
      );
    }
    lines.push(
      "# HELP do_sift_http_request_duration_ms_count Requests counted in the duration sum.",
    );
    lines.push("# TYPE do_sift_http_request_duration_ms_count counter");
    for (const [key, value] of [...this.durationCount.entries()].sort()) {
      const [route, outcome] = key.split("\u0000");
      lines.push(
        `do_sift_http_request_duration_ms_count{route="${route}",outcome="${outcome}"} ${value}`,
      );
    }
    lines.push(
      "# HELP do_sift_answer_suspect_total Answers whose evidence was flagged suspect (ANS-12).",
    );
    lines.push("# TYPE do_sift_answer_suspect_total counter");
    lines.push(`do_sift_answer_suspect_total ${this.suspectEvents}`);
    lines.push(
      "# HELP do_sift_answer_suspect_passages_total Passages flagged across suspect answers.",
    );
    lines.push("# TYPE do_sift_answer_suspect_passages_total counter");
    lines.push(`do_sift_answer_suspect_passages_total ${this.suspectPassages}`);
    return `${lines.join("\n")}\n`;
  }
}
