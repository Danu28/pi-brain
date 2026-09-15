import { brain, isPlanDone } from "../state";

export async function nudgeRule5(ctx: any) {
  if (!brain.brainStrict) return;
  if (
    brain.hasWriteEdit &&
    !brain.hasRemember &&
    !brain.rule5Warned &&
    isPlanDone()
  ) {
    brain.rule5Warned = true;
    try {
      ctx?.ui?.notify?.(
        "Strict Rule 5: write/edit succeeded but no remember yet — call remember{cue,summary} to persist (2nd repeat → habit).",
        "warning",
      );
    } catch {}
  }
}
