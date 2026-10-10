import { PublicClientApplication, type AccountInfo } from "@azure/msal-browser";
import { setTokenProvider } from "@step-up/shared/web";

/** Public identifier of the app registration (a single-page-application platform on it allows this site's URL). Not a secret. */
export const CLIENT_ID = "1b28096c-568a-4299-ae55-fe69f14423b5";
const SCOPES = ["Files.ReadWrite", "Files.ReadWrite.All"];

const msal = new PublicClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: "https://login.microsoftonline.com/common",
    redirectUri: location.origin + "/",
  },
  // Local storage, so the sign-in survives closing the installed app (session storage is cleared every time a phone
  // closes it, which meant signing in on every launch). Microsoft still expires a browser app's refresh token after
  // about a day, so an occasional sign-in remains.
  cache: { cacheLocation: "localStorage" },
});

/** Who signed in last, so the next sign-in goes straight to that account instead of asking which one. */
const HINT_KEY = "stepup.lastAccount";
const readHint = (): string | undefined => {
  try {
    return localStorage.getItem(HINT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};
const writeHint = (username: string | undefined): void => {
  try {
    if (username) localStorage.setItem(HINT_KEY, username);
    else localStorage.removeItem(HINT_KEY);
  } catch {
    /* storage blocked: the account picker just shows again */
  }
};

/** Set just before an automatic sign-in redirect and cleared once signed in, so a sign-in that fails shows the buttons instead of looping. */
const AUTO_KEY = "stepup.autoSignInTried";
const autoTried = (): boolean => {
  try {
    return sessionStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return true; // cannot guard against a loop, so never start one
  }
};
const setAutoTried = (on: boolean): void => {
  try {
    if (on) sessionStorage.setItem(AUTO_KEY, "1");
    else sessionStorage.removeItem(AUTO_KEY);
  } catch {
    /* storage blocked: automatic sign-in is already disabled by autoTried */
  }
};

let account: AccountInfo | null = null;

/** Completes a sign-in redirect if one just happened and, if signed in, hooks Graph up to this account's tokens. */
export async function initAuth(): Promise<AccountInfo | null> {
  await msal.initialize();
  const result = await msal.handleRedirectPromise();
  account = result?.account ?? msal.getAllAccounts()[0] ?? null;
  if (account) {
    msal.setActiveAccount(account);
    writeHint(account.username);
    setAutoTried(false);
    setTokenProvider(async () => {
      try {
        return (await msal.acquireTokenSilent({ scopes: SCOPES, account: account! })).accessToken;
      } catch {
        await msal.acquireTokenRedirect({ scopes: SCOPES, account: account! });
        return new Promise<string>(() => {}); // the page is navigating away
      }
    });
  }
  return account;
}

export const signIn = () => {
  const hint = readHint();
  return msal.loginRedirect(hint ? { scopes: SCOPES, loginHint: hint } : { scopes: SCOPES, prompt: "select_account" });
};
/** True when a previous sign-in left an account to go straight back to and an automatic attempt has not already failed. */
export const canAutoSignIn = (): boolean => readHint() !== undefined && !autoTried();
/** Signs in again as the remembered account without waiting for a button press. */
export const autoSignIn = () => {
  setAutoTried(true);
  return signIn();
};
export const signOut = () => {
  writeHint(undefined); // signing out is how a different account is chosen next time
  return msal.logoutRedirect({ account: account ?? undefined });
};
