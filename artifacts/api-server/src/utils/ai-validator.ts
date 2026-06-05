import { logger } from "../lib/logger";

export interface AIValidationResult {
  is_valid: boolean;
  type: string;
  confidence: number;
  reason?: string;
}

const DUMMY_KEYWORDS = [
  "test", "example", "dummy", "your_", "replace", "changeme",
  "placeholder", "xxxxxxxx", "00000000", "fake", "mock", "sample",
  "enter_here", "your_key_here", "add_your", "insert_your",
];

/**
 * Quick local pre-check — skip AI call if value looks like a dummy.
 */
function looksLikeDummy(value: string): boolean {
  const lower = value.toLowerCase();
  return DUMMY_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Validate a credential snippet using Google Gemini.
 * Falls back gracefully when GEMINI_API_KEY is not configured.
 *
 * @param snippet  - The raw code/text snippet containing the potential credential
 * @param credType - Optional hint (e.g. "ETH private key", "seed phrase")
 */
export async function validateWithAI(
  snippet: string,
  credType?: string,
): Promise<AIValidationResult> {
  const apiKey = process.env["GEMINI_API_KEY"];

  if (!apiKey) {
    logger.debug("GEMINI_API_KEY not set — skipping AI validation");
    return {
      is_valid: false,
      type: credType ?? "unknown",
      confidence: 0,
      reason: "AI validation skipped: GEMINI_API_KEY not configured",
    };
  }

  if (looksLikeDummy(snippet)) {
    return {
      is_valid: false,
      type: credType ?? "placeholder",
      confidence: 5,
      reason: "Local pre-check: value contains dummy/placeholder keywords",
    };
  }

  const prompt = [
    "You are a blockchain/crypto security expert.",
    "Analyze the following code snippet and determine if it contains a real crypto credential (private key, seed phrase, API secret, etc.).",
    "",
    "Respond ONLY with valid JSON in this exact format:",
    '{"is_valid": boolean, "type": "string", "confidence": 0-100}',
    "",
    "Fields:",
    '- is_valid: true if this appears to be a real, non-placeholder credential',
    '- type: credential type (e.g. "ETH private key", "seed phrase 12-word", "Binance API secret", "unknown")',
    "- confidence: 0-100 integer, your confidence that this is a real exposed credential",
    "",
    "Snippet:",
    snippet.slice(0, 800),
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 128 },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logger.warn({ status: res.status, attempt, body: body.slice(0, 200) }, "Gemini API non-OK");
        if (res.status === 429) {
          // Free-tier rate limit — do NOT retry, return a graceful skip so callers
          // don't pile up and worsen the quota situation.
          return { is_valid: false, type: credType ?? "unknown", confidence: 0, reason: "Gemini rate-limited (429) — skipped" };
        }
        throw new Error(`Gemini API error: ${res.status}`);
      }

      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };

      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON in Gemini response");

      const parsed = JSON.parse(jsonMatch[0]) as Partial<AIValidationResult>;
      return {
        is_valid: Boolean(parsed.is_valid),
        type: String(parsed.type ?? credType ?? "unknown"),
        confidence: Math.max(0, Math.min(100, Number(parsed.confidence ?? 0))),
        reason: "Gemini AI validation",
      };
    } catch (err) {
      lastErr = err;
      logger.warn({ err, attempt }, "Gemini validation attempt failed");
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }

  logger.error({ err: lastErr }, "Gemini validation failed after 3 attempts");
  return {
    is_valid: false,
    type: credType ?? "unknown",
    confidence: 0,
    reason: `AI validation failed after 3 attempts: ${String(lastErr)}`,
  };
}

/**
 * Batch validate multiple snippets, respecting a concurrency limit.
 */
export async function batchValidateWithAI(
  items: Array<{ snippet: string; credType?: string }>,
  concurrency = 3,
): Promise<AIValidationResult[]> {
  const results: AIValidationResult[] = new Array(items.length);
  let idx = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      const item = items[i]!;
      results[i] = await validateWithAI(item.snippet, item.credType);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
