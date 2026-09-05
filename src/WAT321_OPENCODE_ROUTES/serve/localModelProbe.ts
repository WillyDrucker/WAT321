import { fetchWithTimeout } from "./fetchWithTimeout";

/**
 * What llama-server is actually running. The Local LLM catalog's
 * `contextWindow` is only a fallback: the loaded model decides the
 * real limit, and its alias is the name worth showing. Both come
 * from llama-server's `/props`.
 */

const PROBE_TIMEOUT_MS = 2_000;

export interface LocalProps {
  /** Runtime context window from llama-server. */
  nCtx: number | null;
  /** `model_alias` from llama-server, cleaned for display: `.gguf`
   * suffix and quantization tag stripped (`Qwen3-8B-Q5_K_M.gguf` ->
   * `Qwen3-8B`). Null when llama-server reports no alias. */
  modelDisplayName: string | null;
}

export const EMPTY_LOCAL_PROPS: LocalProps = { nCtx: null, modelDisplayName: null };

/** Strip the `.gguf` suffix and trailing quantization tag (`-Q5_K_M`,
 * `-Q4_0`, `-IQ3_XXS`, etc.) from a llama-server `model_alias` so the
 * tooltip reads as a clean model name instead of a filename. */
function cleanLocalModelName(raw: string): string {
  let name = raw.replace(/\.gguf$/i, "");
  // Quantization tags follow a -Q[0-9] / -IQ[0-9] / -F[0-9] pattern at
  // the very end of the filename. Strip a single trailing tag if
  // present - leave the model identifier intact otherwise.
  name = name.replace(/-(Q|IQ|F)\d+(_[A-Z0-9]+)*$/i, "");
  return name;
}

/** Probe llama-server's `/props` for the runtime context window AND
 * the loaded model alias. The caller caches the result, this just
 * performs the raw fetch. */
export async function probeLocalProps(endpoint: string): Promise<LocalProps> {
  if (!endpoint) return EMPTY_LOCAL_PROPS;
  const res = await fetchWithTimeout(
    `${endpoint.replace(/\/+$/, "")}/props`,
    PROBE_TIMEOUT_MS
  );
  if (!res?.ok) return EMPTY_LOCAL_PROPS;
  try {
    const j = (await res.json()) as {
      default_generation_settings?: { n_ctx?: number; n_ctx_train?: number };
      n_ctx?: number;
      model_alias?: string;
    };
    const n =
      j?.default_generation_settings?.n_ctx ??
      j?.default_generation_settings?.n_ctx_train ??
      j?.n_ctx ??
      null;
    const alias =
      typeof j?.model_alias === "string" && j.model_alias.length > 0
        ? cleanLocalModelName(j.model_alias)
        : null;
    return {
      nCtx: typeof n === "number" && n > 0 ? n : null,
      modelDisplayName: alias,
    };
  } catch {
    return EMPTY_LOCAL_PROPS;
  }
}
