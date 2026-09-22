import { stat } from "node:fs/promises";

// Product runtimes should hand off before the native reader's absolute admission limit.
export const TRANSCRIPT_ROTATE_BYTES = 8 * 1024 * 1024;
export const TRANSCRIPT_HARD_BYTES = 16 * 1024 * 1024;

export class SessionTranscriptLimitError extends Error {
  readonly code = "SESSION_TRANSCRIPT_LIMIT";
  constructor(readonly bytes: number) {
    super(
      "SESSION_TRANSCRIPT_LIMIT: this runtime has reached its history size limit; continue in a new runtime using a complete context handoff. Prior history has been preserved.",
    );
  }
}

/** Check before repair/prewarm/open, and again before each provider call in a long tool loop. */
export async function assertSessionTranscriptBudget(file: string): Promise<void> {
  try {
    const size = (await stat(file)).size;
    if (size >= TRANSCRIPT_HARD_BYTES) {
      throw new SessionTranscriptLimitError(size);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
