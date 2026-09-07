/**
 * Shorted — optional model polish over the deterministic dispute draft.
 *
 * The draft itself is built in core/claim.ts, without a model. This file only
 * ever REPHRASES it, and it proves afterwards that no amount moved:
 * `extractAmountsCents` over the rewritten text must equal the draft's own
 * amounts, as a multiset. A mismatch is rejected and the deterministic text is
 * what the user sends.
 *
 * The reason for the belt and braces: this text goes to support under the
 * user's name, and a claim whose numbers do not match the receipt is worse
 * than no claim at all (PROMPT.md §2). vision-and-models.md §3 puts it more
 * bluntly — never let the model do arithmetic. Rewriting a sentence that
 * contains "$18.42" is close enough to arithmetic to warrant a check.
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS, PROMPT_VERSIONS, config } from "./config.js";
import { recordModelCall } from "./db.js";
import { sha256 } from "./storage.js";
import { extractAmountsCents, type ClaimDraft } from "../core/claim.js";
import { ShortedDataError } from "../core/types.js";

let anthropic: Anthropic | null = null;
function client(): Anthropic {
  anthropic ??= new Anthropic({ apiKey: config.anthropicApiKey() });
  return anthropic;
}

const POLISH_PROMPT = `You are editing a message a customer will send to food-delivery support.

Rewrite it to be brief, calm and factual. Rules, all absolute:
- Do NOT change, add, remove, reorder or recompute any dollar amount. Every "$" figure
  must appear in your output exactly as written, and you must not introduce new ones.
- Do NOT add claims about the company's policies, refund practices, or what they
  "always" or "never" do. You have no knowledge of those.
- Do NOT add threats, legal citations, accusations, or emotional appeals.
- Do NOT invent details about the order, the items, the delivery, or the driver.
- Keep it under 150 words.

Return only the rewritten message.`;

/** Same amounts, same counts, any order. */
function sameAmounts(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA.every((value, i) => value === sortedB[i]);
}

export interface PolishResult {
  text: string;
  /** False when the model's output was rejected and the draft was used instead. */
  usedModel: boolean;
  rejectedReason?: string;
}

/**
 * Rephrase a draft, or fall back to it.
 *
 * Never throws on a bad rewrite: the deterministic draft is always a correct
 * message, so a failed polish degrades to plain wording rather than to no
 * claim. It IS recorded as a failure, because a model that keeps mangling
 * amounts is something the eval needs to see.
 */
export async function polishClaimText(
  draft: ClaimDraft,
  ctx: { userId: string; orderId: string | null },
): Promise<PolishResult> {
  const started = Date.now();
  const inputHash = sha256(draft.body);

  const reject = async (reason: string, error: string): Promise<PolishResult> => {
    await recordModelCall({
      userId: ctx.userId,
      orderId: ctx.orderId,
      kind: "claim_text",
      modelId: MODELS.claimText,
      promptVersion: PROMPT_VERSIONS.claimText,
      inputHash,
      latencyMs: Date.now() - started,
      error,
    });
    return { text: draft.body, usedModel: false, rejectedReason: reason };
  };

  let response: Anthropic.Message;
  try {
    response = await client().messages.create({
      model: MODELS.claimText,
      max_tokens: 1_000,
      system: POLISH_PROMPT,
      messages: [{ role: "user", content: draft.body }],
    });
  } catch (err) {
    return reject("model_call_failed", err instanceof Error ? err.message : String(err));
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (text === "") {
    return reject("empty_output", "claim polish returned no text");
  }

  // The check this file exists for.
  if (!sameAmounts(extractAmountsCents(text), draft.amountsCents)) {
    return reject(
      "amount_drift",
      `claim polish changed the amounts: draft ${draft.amountsCents.join(",")} vs ` +
        `output ${extractAmountsCents(text).join(",")}`,
    );
  }

  await recordModelCall({
    userId: ctx.userId,
    orderId: ctx.orderId,
    kind: "claim_text",
    modelId: MODELS.claimText,
    promptVersion: PROMPT_VERSIONS.claimText,
    inputHash,
    latencyMs: Date.now() - started,
    output: { text },
  });

  return { text, usedModel: true };
}

/**
 * The escalation paragraph, appended only when the user asks for it.
 *
 * Kept out of the polish path on purpose: a legal citation is the one part of
 * this message that must be reproduced exactly, and a model asked for brevity
 * will happily paraphrase a CFR section. core/claim.ts wrote it; it ships as
 * written or not at all.
 */
export function withEscalation(text: string, draft: ClaimDraft): string {
  if (draft.escalation === null) {
    throw new ShortedDataError(
      "no escalation path is citable for this order's funding instrument",
      "CLAIM_NO_ESCALATION",
    );
  }
  return `${text.trimEnd()}\n\n${draft.escalation.explanation}\n(${draft.escalation.citation})\n`;
}
