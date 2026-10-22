// A failed native attempt lets Server fall back on the next request. A user abort
// is not a compaction failure. State is bounded, process-local, and expires.
type Failure = { failedAt: number; reason?: string; fingerprint?: string };
const key = Symbol.for("openclaw.nativeCompactionFailures");
const globalState = globalThis as typeof globalThis & { [key]?: Map<string, Failure> };
const failures = (globalState[key] ??= new Map<string, Failure>());
const RETENTION_MS = 30 * 60_000;
export function recordNativeCompactionResult(
  file: string,
  success: boolean,
  detail?: Pick<Failure, "reason" | "fingerprint">,
): void {
  const existing = getNativeCompactionFailure(file);
  if (
    !success &&
    detail?.fingerprint &&
    existing &&
    existing.reason === detail.reason &&
    existing.fingerprint === detail.fingerprint
  ) {
    return;
  }
  failures.delete(file);
  if (success) {
    return;
  }
  failures.set(file, { failedAt: Date.now(), ...detail });
  while (failures.size > 256) {
    failures.delete(failures.keys().next().value!);
  }
}
export function getNativeCompactionFailure(file: string): Failure | undefined {
  const failure = failures.get(file);
  if (failure && Date.now() - failure.failedAt >= RETENTION_MS) {
    failures.delete(file);
    return undefined;
  }
  return failure;
}
