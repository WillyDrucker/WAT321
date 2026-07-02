import {
  ZEN_MODEL_OUTPUT_FLOOR,
  ZEN_VERIFIED_MODELS,
} from "./configBuilder";

/**
 * Post-spawn check that OpenCode merged our `.opencode.json` `limit`
 * block into its running provider catalog. The limit pins OpenCode's
 * max_tokens + auto-compact budgeting per route - if the merge silently
 * fails the running process falls back to a 32K default and breaks
 * auto-compact predictability.
 *
 * Best-effort: a probe failure does not break activation. The warning
 * is the actionable signal - tool-call regressions or unpredictable
 * auto-compact behavior trace to a "config write did not propagate"
 * line in the output channel.
 */

interface ProviderCatalog {
  all?: Array<{
    id?: string;
    models?: Record<string, { limit?: { context?: number; output?: number } }>;
  }>;
}

interface VerifierLogger {
  info(message: string): void;
  warn(message: string): void;
}

export async function verifyOutputLimits(
  url: string,
  logger: VerifierLogger
): Promise<void> {
  let catalog: ProviderCatalog;
  try {
    const res = await fetch(`${url}/provider`);
    if (!res.ok) {
      logger.info(
        `output-limit verifier: /provider returned ${res.status}; skipping check`
      );
      return;
    }
    catalog = (await res.json()) as ProviderCatalog;
  } catch (err) {
    logger.info(
      `output-limit verifier: /provider probe failed (${err instanceof Error ? err.message : String(err)}); skipping check`
    );
    return;
  }

  const missing: string[] = [];
  for (const modelId of ZEN_VERIFIED_MODELS) {
    const provider = (catalog.all ?? []).find((p) => p.id === "zen");
    const model = provider?.models?.[modelId];
    const output = model?.limit?.output ?? 0;
    if (output < ZEN_MODEL_OUTPUT_FLOOR) {
      missing.push(`zen/${modelId} output=${output} (expected >= ${ZEN_MODEL_OUTPUT_FLOOR})`);
    }
  }

  if (missing.length === 0) {
    logger.info(
      `output-limit verifier: all model entries report sufficient output budget for tool-using turns`
    );
    return;
  }

  logger.warn(
    `output-limit verifier: ${missing.length} model entries missing the expected explicit output ceiling. OpenCode falls back to its 32K default when limit is unset, which breaks auto-compact predictability and may interact with tool-call sampling on reasoning models. Affected: ${missing.join(", ")}`
  );
}
