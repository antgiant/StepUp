import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { GoogleDriveAuth, StorageAccount } from "@step-up/shared";

const SCOPE = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.appdata";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ABOUT_URL = "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)";

interface Cache {
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  account?: StorageAccount;
}

export interface GoogleCliAuthOptions {
  clientId: string;
  /** A "Desktop app" client's secret is not confidential (Google documents it as such for installed apps). */
  clientSecret: string;
  cacheFile: string;
  fetch?: typeof fetch;
  /** Shows the person the sign-in address (opens a browser where it can). */
  openUrl?: (url: string) => void;
  now?: () => number;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function openInBrowser(url: string): void {
  console.log(`\n=== Google sign-in required ===\nOpen this address in a browser and allow access:\n${url}\n===============================\n`);
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd!, args as string[], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    /* the printed address is enough */
  }
}

/**
 * Google sign-in for the command line: the loopback flow with PKCE (a browser opens, Google redirects back to a port
 * on this computer). The refresh token is kept in the cache folder so later runs sign in silently.
 */
export class GoogleCliAuth implements GoogleDriveAuth {
  private readonly fetchFn: typeof fetch;
  private readonly open: (url: string) => void;
  private readonly now: () => number;
  private cache: Cache | undefined;

  constructor(private readonly options: GoogleCliAuthOptions) {
    this.fetchFn = options.fetch ?? ((...a) => fetch(...a));
    this.open = options.openUrl ?? openInBrowser;
    this.now = options.now ?? Date.now;
  }

  private async load(): Promise<Cache> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.options.cacheFile, "utf-8")) as Cache;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.options.cacheFile), { recursive: true });
    await writeFile(this.options.cacheFile, JSON.stringify(this.cache ?? {}), { encoding: "utf-8", mode: 0o600 });
  }

  private async tokenRequest(params: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.clientSecret, ...params }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
    return { access_token: body.access_token, expires_in: body.expires_in ?? 3600, ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}) };
  }

  /** The address to send the person to, for the given PKCE challenge and loopback port. */
  authUrl(port: number, challenge: string, state: string): string {
    return `${AUTH_URL}?${new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: `http://127.0.0.1:${port}`,
      response_type: "code",
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      state,
    })}`;
  }

  private async interactive(): Promise<void> {
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(16));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const code = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for the Google sign-in to finish.")), 5 * 60_000);
        server.on("request", (req, res) => {
          const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
          const err = url.searchParams.get("error");
          const got = url.searchParams.get("code");
          if (!got && !err) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<p>You can close this window and return to the terminal.</p>");
          clearTimeout(timer);
          if (err) reject(new Error(`Google sign-in was declined (${err}).`));
          else if (url.searchParams.get("state") !== state) reject(new Error("Google sign-in returned an unexpected state; please try again."));
          else resolve(got!);
        });
        this.open(this.authUrl(port, challenge, state));
      });
      const t = await this.tokenRequest({ code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: `http://127.0.0.1:${port}` });
      const cache = await this.load();
      cache.accessToken = t.access_token;
      cache.expiresAt = this.now() + t.expires_in * 1000;
      if (t.refresh_token) cache.refreshToken = t.refresh_token;
      await this.save();
    } finally {
      server.close();
    }
  }

  async getToken(refresh = false): Promise<string> {
    const cache = await this.load();
    if (!refresh && cache.accessToken && (cache.expiresAt ?? 0) - this.now() > 60_000) return cache.accessToken;
    if (cache.refreshToken) {
      try {
        const t = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: cache.refreshToken });
        cache.accessToken = t.access_token;
        cache.expiresAt = this.now() + t.expires_in * 1000;
        await this.save();
        return t.access_token;
      } catch {
        /* the grant was revoked or expired: sign in again below */
      }
    }
    await this.interactive();
    return this.cache!.accessToken!;
  }

  async restore(): Promise<StorageAccount | undefined> {
    const cache = await this.load();
    if (cache.account) return cache.account;
    const token = await this.getToken();
    const res = await this.fetchFn(ABOUT_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return undefined;
    const user = ((await res.json()) as { user?: { emailAddress?: string; displayName?: string } }).user;
    const name = user?.emailAddress ?? user?.displayName;
    if (!name) return undefined;
    cache.account = { id: name, name };
    await this.save();
    return cache.account;
  }

  async signIn(): Promise<void> {
    await this.interactive();
  }

  async signOut(): Promise<void> {
    this.cache = {};
    await rm(this.options.cacheFile, { force: true });
  }

  canAutoSignIn = () => false;
  async autoSignIn(): Promise<void> {
    await this.signIn();
  }
}
