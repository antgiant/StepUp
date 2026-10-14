/**
 * StepUp signs in with MSAL (Azure AD B2C). MSAL.js keeps one access token per API in the tab's sessionStorage. The agent
 * only ever reads an access token for the API it needs; the refresh token is never touched (B2C may rotate it, which could
 * sign the page out).
 */
export const REIMBURSEMENT_SCOPE = "5bd9fe13-76ed-4dbb-b8c3-7811dbf16276/access_as_user";
/** The person API's scope (public: it is in StepUp's own appsettings.json); the student list comes from there. */
export const PERSON_SCOPE = "cb885232-83b3-49bc-99cb-55d5b14c52ae/access_as_user";
/** The provider API's scope (public, from StepUp's appsettings.json): the "Who did you pay?" list comes from there. */
export const PROVIDER_SCOPE = "429e3036-53d2-4215-a413-05b7ced0fa9d/access_as_user";

export interface StepUpToken {
  secret: string;
  /** Seconds since 1970. */
  expiresOn: number;
  /** The person's id, from the token's `scholar_personId` claim (the list request filters on it; it is checked server-side). */
  guardian?: string;
}

type StorageLike = Pick<Storage, "length" | "key" | "getItem">;

/** The access token for `scope` that expires last, or undefined. */
export function findAccessToken(storage: StorageLike, scope = REIMBURSEMENT_SCOPE): StepUpToken | undefined {
  let best: { secret: string; expiresOn: number } | undefined;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key) continue;
    let v: { credentialType?: unknown; target?: unknown; expiresOn?: unknown; secret?: unknown } | null;
    try {
      v = JSON.parse(storage.getItem(key) ?? "null");
    } catch {
      continue;
    }
    if (!v || v.credentialType !== "AccessToken" || typeof v.target !== "string" || !v.target.endsWith(scope)) continue;
    const expiresOn = Number(v.expiresOn);
    if (typeof v.secret !== "string" || !Number.isFinite(expiresOn)) continue;
    if (!best || expiresOn > best.expiresOn) best = { secret: v.secret, expiresOn };
  }
  if (!best) return undefined;
  return { ...best, guardian: guardianOf(best.secret) };
}

function guardianOf(jwt: string): string | undefined {
  try {
    const payload = jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(payload)) as { scholar_personId?: unknown };
    return typeof claims.scholar_personId === "string" ? claims.scholar_personId : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the token is good for at least `marginMs` more. */
export const tokenFresh = (t: StepUpToken, now: number, marginMs = 60_000): boolean => t.expiresOn * 1000 - now >= marginMs;
