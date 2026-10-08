import { checkStepUpShape, type StepUpShape } from "@step-up/shared";

const warned = new Set<StepUpShape>();

/**
 * Checks one of StepUp's own API responses against the shape the code expects. On a mismatch it says so loudly (once
 * per kind per run) and returns false: the caller must not use the response. StepUp changes its site without notice.
 */
export function stepUpShapeOk(shape: StepUpShape, body: unknown): boolean {
  const problems = checkStepUpShape(shape, body);
  if (problems.length === 0) return true;
  if (!warned.has(shape)) {
    warned.add(shape);
    console.warn(
      `\n!! StepUp's "${shape}" response no longer looks the way this tool expects (the site may have changed):\n` +
        problems.slice(0, 5).map((p) => `   - ${p}`).join("\n") +
        `\n   Not using it. Nothing was written from it. The automation may need an update.`
    );
  }
  return false;
}
