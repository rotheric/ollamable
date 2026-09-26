/** Provider and model jointly identify token vocabularies and model-dependent caches. */
export function modelIdentity(provider: string | undefined, model: string | undefined): string {
  return JSON.stringify([provider ?? null, model ?? null]);
}
