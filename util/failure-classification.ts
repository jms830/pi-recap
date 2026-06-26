/**
 * Classify provider/API failures into durable blacklist reasons.
 *
 * Returns undefined for transient failures that should be retried next turn:
 * rate limits, provider outages, network failures, aborts, and timeouts.
 */
export function classifyFailure(err: unknown): string | undefined {
	const raw = err instanceof Error ? (err.message ?? "") : String(err ?? "");
	const lower = raw.toLowerCase();

	if (hasAny(lower, TRANSIENT_MARKERS)) {
		return undefined;
	}

	const statusMatch = raw.match(/\b(4\d\d|5\d\d)\b/);
	if (statusMatch) {
		const status = statusMatch[1]!;
		if (hasAny(lower, BILLING_MARKERS)) return `${status} insufficient credits`;
		if (status === "401" || status === "403" || hasAny(lower, AUTH_MARKERS)) return `${status} auth failed`;
		if (status === "404" || status === "410" || hasAny(lower, RETIRED_MARKERS)) return `${status} endpoint retired`;
		if (status.startsWith("5") || status === "408") return undefined;
		return `${status} ${truncateReason(raw)}`;
	}

	if (hasAny(lower, BILLING_MARKERS)) return `provider error: ${truncateReason(raw)}`;
	if (hasAny(lower, RETIRED_MARKERS)) return `provider error: ${truncateReason(raw)}`;
	if (hasAny(lower, AUTH_MARKERS)) return `provider error: ${truncateReason(raw)}`;
	return undefined;
}

const TRANSIENT_MARKERS = [
	"429",
	"rate limit",
	"rate_limit",
	"too many requests",
	"timeout",
	"timed out",
	"aborted",
	"aborterror",
	"cancelled",
	"network",
	"fetch failed",
	"failed to fetch",
	"socket",
	"connection",
	"connect",
	"econn",
	"etimedout",
	"enotfound",
	"eai_again",
	"temporarily unavailable",
	"service unavailable",
	"overloaded",
	"try again",
] as const;

const BILLING_MARKERS = ["insufficient", "credits", "payment", "quota"] as const;
const AUTH_MARKERS = ["unauthorized", "forbidden", "invalid api key"] as const;
const RETIRED_MARKERS = ["not found", "retired", "deprecated", "unsupported", "not supported"] as const;

function hasAny(s: string, needles: readonly string[]): boolean {
	return needles.some((needle) => s.includes(needle));
}

function truncateReason(s: string): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > 60 ? oneLine.slice(0, 57) + "..." : oneLine;
}
