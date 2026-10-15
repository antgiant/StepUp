import type { GoogleDriveAuth, StorageAccount } from "@step-up/shared/web";

/**
 * Public identifier of the Google OAuth "Web application" client (it is not a secret; the site's origin must be listed as an
 * authorized JavaScript origin on it). Leave empty until the client exists: Google is then not offered on the first screen.
 */
export const GOOGLE_CLIENT_ID: string = "786911806780-t4fbouoc0gqmqqou4qa5gk8gsovbgi91.apps.googleusercontent.com";
export const googleConfigured = GOOGLE_CLIENT_ID !== "";
/**
 * Public identifiers for Google's folder Picker (neither is a secret): a browser API key restricted to this site's origin and to the
 * Picker API, and the Cloud project's number. With `drive.file` the Picker is how the app is given a folder it did not create.
 * Leave empty until they exist: the "Choose with Google Drive" button is then not offered.
 */
export const GOOGLE_API_KEY: string = "";
export const GOOGLE_APP_ID: string = "";
export const pickerConfigured = googleConfigured && GOOGLE_API_KEY !== "" && GOOGLE_APP_ID !== "";

/**
 * Both scopes are non-sensitive (no Google verification review). `drive.file` reaches only the files and folders this app created;
 * `drive.appdata` holds this app's own hidden settings. The full `drive` scope is "restricted" and is deliberately not used.
 */
const SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata";
/** Access tokens last about an hour and Google issues no refresh token to a browser, so the current one is kept for this tab only. */
const TOKEN_KEY = "stepup.google.token";
/** Who signed in last, so the next visit can ask Google for a token without showing an account picker. */
const HINT_KEY = "stepup.google.account";

interface TokenClient {
  requestAccessToken(config?: { prompt?: string; hint?: string }): void;
}
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}
interface GoogleGlobal {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (r: TokenResponse) => void;
        error_callback?: (e: { type?: string; message?: string }) => void;
      }): TokenClient;
    };
  };
}

let loading: Promise<GoogleGlobal> | undefined;
function loadGoogle(): Promise<GoogleGlobal> {
  return (loading ??= new Promise((resolve, reject) => {
    const have = (window as unknown as { google?: GoogleGlobal }).google;
    if (have?.accounts?.oauth2) return resolve(have);
    const script = Object.assign(document.createElement("script"), { src: "https://accounts.google.com/gsi/client", async: true });
    script.onload = () => resolve((window as unknown as { google: GoogleGlobal }).google);
    script.onerror = () => {
      loading = undefined;
      reject(new Error("Could not load Google sign-in. Check your connection and try again."));
    };
    document.head.append(script);
  }));
}

interface Session {
  token: string;
  expiresAt: number;
  account: StorageAccount;
}
let session: Session | undefined;

const fresh = (s: Session | undefined): s is Session => s !== undefined && s.expiresAt - Date.now() > 60_000;

function readSession(): Session | undefined {
  try {
    const s = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? "null") as Session | null;
    return s && fresh(s) ? s : undefined;
  } catch {
    return undefined;
  }
}
function saveSession(s: Session | undefined): void {
  try {
    if (s) {
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify(s));
      localStorage.setItem(HINT_KEY, s.account.id);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(HINT_KEY);
    }
  } catch {
    /* storage blocked: sign-in just lasts until the page is reloaded */
  }
}
const hint = (): string | undefined => {
  try {
    return localStorage.getItem(HINT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

/** Asks Google for an access token. `prompt: "none"` must succeed without any window (a returning, already-consented person). */
async function requestToken(prompt: string, loginHint?: string): Promise<{ token: string; expiresIn: number }> {
  if (!googleConfigured) throw new Error("Google sign-in is not set up for this site yet.");
  const google = await loadGoogle();
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (r) => (r.access_token ? resolve({ token: r.access_token, expiresIn: r.expires_in ?? 3600 }) : reject(new Error(r.error_description || r.error || "Google sign-in failed."))),
      error_callback: (e) => reject(new Error(e.message || e.type || "Google sign-in was cancelled.")),
    });
    client.requestAccessToken({ prompt, ...(loginHint ? { hint: loginHint } : {}) });
  });
}

async function accountFor(token: string): Promise<StorageAccount> {
  const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Google did not say who signed in (${res.status}).`);
  const user = ((await res.json()) as { user?: { emailAddress?: string; displayName?: string } }).user;
  const email = user?.emailAddress ?? user?.displayName ?? "Google account";
  return { id: email, name: email };
}

async function acquire(prompt: string, loginHint?: string): Promise<Session> {
  const { token, expiresIn } = await requestToken(prompt, loginHint);
  const next: Session = { token, expiresAt: Date.now() + expiresIn * 1000, account: await accountFor(token) };
  session = next;
  saveSession(next);
  return next;
}

/** Google sign-in for Drive in the browser (Google Identity Services, popup flow). */
export const googleAuth: GoogleDriveAuth = {
  /** Resumes this tab's session, or quietly asks Google for a new token for the last account. Undefined means sign in with the button. */
  async restore(): Promise<StorageAccount | undefined> {
    session = readSession();
    if (session) return session.account;
    const who = hint();
    if (!who || !googleConfigured) return undefined;
    try {
      return (await acquire("none", who)).account;
    } catch {
      return undefined;
    }
  },

  async getToken(refresh = false): Promise<string> {
    if (!refresh && fresh(session)) return session.token;
    try {
      return (await acquire("none", hint())).token;
    } catch {
      throw new Error("Your Google sign-in has expired. Reload the page and sign in with Google again.");
    }
  },

  /** Opens Google's sign-in window. Must be called from a click. Resolves once signed in; the page does not navigate. */
  async signIn(): Promise<void> {
    await acquire(hint() ? "" : "select_account", hint());
  },

  async signOut(): Promise<void> {
    session = undefined;
    saveSession(undefined);
  },

  canAutoSignIn: () => false,
  async autoSignIn(): Promise<void> {},
};

interface PickerDoc {
  id: string;
  name: string;
}
interface PickerData {
  action: string;
  docs?: PickerDoc[];
}
interface PickerGlobal {
  picker: {
    Action: { PICKED: string; CANCEL: string };
    ViewId: { FOLDERS: string };
    DocsView: new (viewId: string) => { setIncludeFolders(b: boolean): unknown; setSelectFolderEnabled(b: boolean): unknown; setMimeTypes(m: string): unknown };
    PickerBuilder: new () => {
      addView(v: unknown): unknown;
      setOAuthToken(t: string): unknown;
      setDeveloperKey(k: string): unknown;
      setAppId(a: string): unknown;
      setTitle(t: string): unknown;
      setCallback(cb: (d: PickerData) => void): unknown;
      build(): { setVisible(b: boolean): void };
    };
  };
}

let pickerApi: Promise<PickerGlobal> | undefined;
function loadPicker(): Promise<PickerGlobal> {
  return (pickerApi ??= new Promise((resolve, reject) => {
    const fail = (): void => {
      pickerApi = undefined;
      reject(new Error("Could not load Google's folder picker. Check your connection and try again."));
    };
    const ready = (): void => {
      const gapi = (window as unknown as { gapi?: { load(name: string, cb: { callback: () => void; onerror: () => void }): void } }).gapi;
      if (!gapi) return fail();
      gapi.load("picker", { callback: () => resolve((window as unknown as { google: PickerGlobal }).google), onerror: fail });
    };
    if ((window as unknown as { gapi?: unknown }).gapi) return ready();
    const script = Object.assign(document.createElement("script"), { src: "https://apis.google.com/js/api.js", async: true });
    script.onload = ready;
    script.onerror = fail;
    document.head.append(script);
  }));
}

/**
 * Opens Google's folder Picker and resolves with the folder the person chose (undefined if they closed it). Choosing a folder here
 * is what gives this app access to it under the `drive.file` scope. Must be called from a click.
 */
export async function pickGoogleFolder(): Promise<{ id: string; name: string } | undefined> {
  if (!pickerConfigured) throw new Error("Google's folder picker is not set up for this site yet.");
  const [google, token] = await Promise.all([loadPicker(), googleAuth.getToken()]);
  const p = google.picker;
  const view = new p.DocsView(p.ViewId.FOLDERS);
  view.setIncludeFolders(true);
  view.setSelectFolderEnabled(true);
  view.setMimeTypes("application/vnd.google-apps.folder");
  return new Promise((resolve) => {
    const builder = new p.PickerBuilder();
    builder.addView(view);
    builder.setOAuthToken(token);
    builder.setDeveloperKey(GOOGLE_API_KEY);
    builder.setAppId(GOOGLE_APP_ID);
    builder.setTitle("Choose the folder for your Step Up Helper files");
    builder.setCallback((data) => {
      if (data.action === p.Action.PICKED && data.docs?.[0]) resolve({ id: data.docs[0].id, name: data.docs[0].name });
      else if (data.action === p.Action.CANCEL) resolve(undefined);
    });
    builder.build().setVisible(true);
  });
}
