import { PublicClientApplication, type AccountInfo, type ICachePlugin } from "@azure/msal-node";
import { promises as fs } from "node:fs";
import path from "node:path";

const SCOPES = ["Files.ReadWrite", "Files.ReadWrite.All", "offline_access"];
const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "msal-cache.json");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in first (see README.md).`
    );
  }
  return value;
}

const cachePlugin: ICachePlugin = {
  async beforeCacheAccess(cacheContext) {
    try {
      const data = await fs.readFile(CACHE_FILE, "utf-8");
      cacheContext.tokenCache.deserialize(data);
    } catch {
      // No cache yet — first run.
    }
  },
  async afterCacheAccess(cacheContext) {
    if (cacheContext.cacheHasChanged) {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(CACHE_FILE, cacheContext.tokenCache.serialize(), "utf-8");
    }
  },
};

let pca: PublicClientApplication | undefined;

function getPca(): PublicClientApplication {
  if (!pca) {
    pca = new PublicClientApplication({
      auth: {
        clientId: requireEnv("AZURE_CLIENT_ID"),
        authority: process.env.AZURE_AUTHORITY ?? "https://login.microsoftonline.com/common",
      },
      cache: { cachePlugin },
    });
  }
  return pca;
}

/**
 * Returns a valid Graph access token, silently refreshing from the cached
 * account when possible. Falls back to an interactive device-code prompt
 * (printed to the terminal) the first time, or whenever the refresh token
 * has expired.
 */
export async function getAccessToken(): Promise<string> {
  const client = getPca();
  const accounts = await client.getTokenCache().getAllAccounts();
  const account: AccountInfo | undefined = accounts[0];

  if (account) {
    try {
      const result = await client.acquireTokenSilent({ account, scopes: SCOPES });
      if (result?.accessToken) return result.accessToken;
    } catch {
      // Fall through to device code.
    }
  }

  const result = await client.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      console.log("\n=== Microsoft sign-in required ===");
      console.log(response.message);
      console.log("===================================\n");
    },
  });

  if (!result?.accessToken) {
    throw new Error("Failed to acquire a Microsoft Graph access token.");
  }
  return result.accessToken;
}

/** The Microsoft account the CLI is signed in as (after a token has been obtained), for saying who holds the StepUp lock. */
export async function getSignedInName(): Promise<string> {
  await getAccessToken();
  const accounts = await getPca().getTokenCache().getAllAccounts();
  return accounts[0]?.username ?? "unknown user";
}
