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
  // Tokens stay in this tab's session storage rather than long-lived local storage.
  cache: { cacheLocation: "sessionStorage" },
});

let account: AccountInfo | null = null;

/** Completes a sign-in redirect if one just happened and, if signed in, hooks Graph up to this account's tokens. */
export async function initAuth(): Promise<AccountInfo | null> {
  await msal.initialize();
  const result = await msal.handleRedirectPromise();
  account = result?.account ?? msal.getAllAccounts()[0] ?? null;
  if (account) {
    msal.setActiveAccount(account);
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

export const signIn = () => msal.loginRedirect({ scopes: SCOPES, prompt: "select_account" });
export const signOut = () => msal.logoutRedirect({ account: account ?? undefined });
