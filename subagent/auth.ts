/**
 * Cross-runtime model-auth resolver.
 *
 * pi-recap targets two coding-agent runtimes that expose model credentials
 * through different ModelRegistry methods:
 *
 *   - pi (upstream, @earendil-works/pi-coding-agent):
 *       registry.getApiKeyAndHeaders(model) -> { ok, apiKey, headers }
 *   - oh-my-pi (@oh-my-pi/pi-coding-agent):
 *       registry.getApiKey(model) -> string | undefined
 *     (oh-my-pi resolves provider auth headers/metadata internally inside
 *      stream(), so the caller only needs the bare key — we pass {} headers.)
 *
 * Feature-detect the available method so a single build runs on both runtimes.
 * The upstream method is preferred when present; otherwise the bare key from
 * getApiKey() is wrapped into the same { ok, apiKey, headers } shape callers
 * already consume. Falls back to a closed { ok: false } result when neither
 * method exists, so callers keep their existing "auth not ready, skip" path.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

export interface ResolvedAuth {
	ok: boolean;
	apiKey?: string;
	headers?: Record<string, string>;
}

interface AuthCapableRegistry {
	getApiKeyAndHeaders?: (model: Model<Api>) => Promise<ResolvedAuth>;
	getApiKey?: (model: Model<Api>, sessionId?: string) => Promise<string | undefined>;
}

export async function resolveModelAuth(registry: unknown, model: Model<Api>): Promise<ResolvedAuth> {
	const reg = registry as AuthCapableRegistry;
	if (typeof reg.getApiKeyAndHeaders === "function") {
		return reg.getApiKeyAndHeaders(model);
	}
	if (typeof reg.getApiKey === "function") {
		const apiKey = await reg.getApiKey(model);
		return { ok: Boolean(apiKey), apiKey: apiKey ?? undefined, headers: {} };
	}
	return { ok: false, apiKey: undefined, headers: {} };
}
