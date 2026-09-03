/**
 * Model resolution for the refine pipeline: custom OpenAI-compatible
 * providers (bifrost, vLLM, …) + builtin catalogs.
 */

import { createProvider, envApiKeyAuth, type Api, type Model, type createModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

/** The models registry returned by createModels(). */
export type Models = ReturnType<typeof createModels>;
/** Any model from any provider. */
export type AnyModel = Model<Api>;

export interface ModelSpec {
	providerId: string;
	modelId: string;
}

export function parseModelSpec(spec: string): ModelSpec {
	const slash = spec.indexOf("/");
	const providerId = slash === -1 ? "anthropic" : spec.slice(0, slash);
	const modelId = slash === -1 ? spec : spec.slice(slash + 1);
	return { providerId, modelId };
}

export function resolveModel(
	spec: string,
	models: ReturnType<typeof createModels>,
): { model: Model<Api> } & ModelSpec {
	const wanted = parseModelSpec(spec);
	const model = models.getModel(wanted.providerId, wanted.modelId);
	if (model === undefined) {
		const available = models
			.getModels(wanted.providerId)
			.slice(0, 20)
			.map((m) => m.id)
			.join(", ");
		throw new Error(
			`unknown model "${spec}"; available for ${wanted.providerId}: ${available || "(none — set --base-url for a custom OpenAI-compatible endpoint, or check API keys)"}`,
		);
	}
	return { ...wanted, model };
}

/**
 * Register one OpenAI-compatible provider per provider id, holding every
 * model id requested by the run (fast + smart often share a gateway).
 */
export function registerCustomModels(
	models: ReturnType<typeof createModels>,
	baseUrl: string,
	specs: ModelSpec[],
): void {
	const byProvider = new Map<string, string[]>();
	for (const spec of specs) {
		const bucket = byProvider.get(spec.providerId) ?? [];
		bucket.push(spec.modelId);
		byProvider.set(spec.providerId, bucket);
	}
	for (const [providerId, ids] of byProvider) {
		const providerModels = ids.map(
			(id): Model<"openai-completions"> => ({
				id,
				name: id,
				api: "openai-completions",
				provider: providerId,
				baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 16_384,
			}),
		);
		models.setProvider(
			createProvider<"openai-completions">({
				id: providerId,
				name: providerId,
				baseUrl,
				auth: { apiKey: envApiKeyAuth("SD_API_KEY", ["SD_API_KEY"]) },
				models: providerModels,
				api: openAICompletionsApi(),
			}),
		);
	}
}
