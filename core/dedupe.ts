/**
 * Shorted — cross-photo detection dedupe. PURE, deterministic, no I/O.
 *
 * research/findings/RESPONSES.md R5: run one detection call per photo so an
 * item's photo attribution is a fact the caller already knows, rather than
 * something the model is asked to invent. That leaves the merge, and the merge
 * belongs here — in core/, testable, for the same reason the diff does.
 *
 * The hard case, stated honestly: the same name appearing in two photos is
 * genuinely ambiguous. It is either one item photographed twice (summing
 * double-counts, and a duplicate that matches nothing becomes a phantom
 * wrong-item claim) or two items in two frames (taking the max under-counts,
 * and that becomes a phantom shortage). Both errors are the expensive kind
 * (vision-and-models.md §6).
 *
 * So we do not pick silently. We merge conservatively — quantity is the MAX
 * across photos, never the sum — and we FLAG the item as cross-photo ambiguous.
 * The confirmation screen surfaces flagged items first, and the human, who is
 * holding the food, resolves it. That is the labeling pipeline doing its job
 * rather than a heuristic pretending to be one (PROMPT.md §3.4).
 */
import type { DetectedItem } from "./types.js";
import { normalizeItemName } from "./diff.js";

/** One detection call's result, tied to the exact photo it ran on. */
export interface PhotoDetection {
  photoPath: string;
  items: Array<Omit<DetectedItem, "photoPath">>;
  /** The model saw closed or stacked containers in this photo. */
  obstructed: boolean;
}

export interface MergedDetection extends DetectedItem {
  /** Every photo this name appeared in. Evidence, in the claim PDF's sense. */
  photoPaths: string[];
  /**
   * The same name appeared in more than one photo, so its true count cannot be
   * settled from the photos alone. Forces a human decision; never resolved here.
   */
  crossPhotoAmbiguous: boolean;
  /** Quantity in the photo that showed the most of it. */
  maxQuantityInOnePhoto: number;
  /** Sum across photos — the upper bound, kept so the UI can offer both. */
  summedQuantity: number;
}

export interface MergeResult {
  items: MergedDetection[];
  /** True if any photo reported closed or stacked containers. */
  obstructed: boolean;
  /** Photos that produced no detections at all. Countable, not silently dropped. */
  emptyPhotoPaths: string[];
}

/**
 * Merge per-photo detections into one candidate list.
 *
 * Deterministic: output order follows first appearance, and first appearance
 * follows the order the photos were supplied in.
 */
export function mergePhotoDetections(detections: readonly PhotoDetection[]): MergeResult {
  const byName = new Map<
    string,
    {
      name: string;
      maxQuantity: number;
      summed: number;
      confidence: number;
      photoPaths: string[];
    }
  >();
  const emptyPhotoPaths: string[] = [];

  for (const photo of detections) {
    if (photo.items.length === 0) emptyPhotoPaths.push(photo.photoPath);

    // Within a single photo the same name is genuinely two containers on the
    // table, so it sums. Ambiguity only exists ACROSS photos.
    const withinPhoto = new Map<string, { name: string; quantity: number; confidence: number }>();
    for (const item of photo.items) {
      const key = normalizeItemName(item.name);
      const existing = withinPhoto.get(key);
      if (existing === undefined) {
        withinPhoto.set(key, {
          name: item.name,
          quantity: item.quantity,
          confidence: item.confidence,
        });
      } else {
        existing.quantity += item.quantity;
        existing.confidence = Math.max(existing.confidence, item.confidence);
      }
    }

    for (const [key, item] of withinPhoto) {
      const existing = byName.get(key);
      if (existing === undefined) {
        byName.set(key, {
          name: item.name,
          maxQuantity: item.quantity,
          summed: item.quantity,
          confidence: item.confidence,
          photoPaths: [photo.photoPath],
        });
      } else {
        existing.maxQuantity = Math.max(existing.maxQuantity, item.quantity);
        existing.summed += item.quantity;
        // A second sighting corroborates existence; take the stronger read.
        existing.confidence = Math.max(existing.confidence, item.confidence);
        if (!existing.photoPaths.includes(photo.photoPath)) {
          existing.photoPaths.push(photo.photoPath);
        }
      }
    }
  }

  const items: MergedDetection[] = [...byName.values()].map((entry) => {
    const first = entry.photoPaths[0];
    if (first === undefined) {
      // Unreachable: an entry only exists because a photo produced it.
      throw new Error("merged detection with no source photo");
    }
    return {
      name: entry.name,
      quantity: entry.maxQuantity,
      confidence: entry.confidence,
      photoPath: first,
      photoPaths: entry.photoPaths,
      crossPhotoAmbiguous: entry.photoPaths.length > 1,
      maxQuantityInOnePhoto: entry.maxQuantity,
      summedQuantity: entry.summed,
    };
  });

  return {
    items,
    obstructed: detections.some((d) => d.obstructed),
    emptyPhotoPaths,
  };
}
