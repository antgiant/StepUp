import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GoogleCliAuth } from "../src/storage/googleAuth.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
async function cacheFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stepup-gauth-"));
  dirs.push(dir);
  return path.join(dir, "google-token.json");
}

interface Call {
  url: string;
  body: URLSearchParams;
}
function fakeGoogle(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body instanceof URLSearchParams ? init.body : new URLSearchParams() });
    const r = responses.shift() ?? { status: 500, json: {} };
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("Google sign-in for the command line", () => {
  it("signs in through the loopback redirect with PKCE and keeps the refresh token", async () => {
    const file = await cacheFile();
    const google = fakeGoogle([{ json: { access_token: "A1", expires_in: 3600, refresh_token: "R1" } }]);
    let authUrl = "";
    const auth = new GoogleCliAuth({
      clientId: "cid",
      clientSecret: "sec",
      cacheFile: file,
      fetch: google.fetchFn,
      openUrl: (url) => {
        authUrl = url;
        const u = new URL(url);
        // The browser would send the person to Google and Google would redirect back here.
        const back = new URL(u.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", "the-code");
        back.searchParams.set("state", u.searchParams.get("state")!);
        void fetch(back);
      },
    });
    expect(await auth.getToken()).toBe("A1");

    const u = new URL(authUrl);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata");
    expect(u.searchParams.get("access_type")).toBe("offline");

    const exchange = google.calls[0]!.body;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("the-code");
    expect(exchange.get("client_secret")).toBe("sec");
    expect(exchange.get("code_verifier")).toBeTruthy();

    const saved = JSON.parse(await readFile(file, "utf-8")) as { refreshToken: string };
    expect(saved.refreshToken).toBe("R1");
  });

  it("uses a cached token while it is fresh, then refreshes it from the refresh token", async () => {
    const file = await cacheFile();
    let clock = 1_000_000;
    const google = fakeGoogle([
      { json: { access_token: "A2", expires_in: 3600 } },
    ]);
    const seed = new GoogleCliAuth({ clientId: "cid", clientSecret: "sec", cacheFile: file, fetch: google.fetchFn, now: () => clock });
    // Seed the cache as an earlier run would have left it.
    await (await import("node:fs/promises")).writeFile(file, JSON.stringify({ refreshToken: "R1", accessToken: "A1", expiresAt: clock + 3_600_000 }));
    expect(await seed.getToken()).toBe("A1");
    expect(google.calls).toHaveLength(0);

    clock += 3_600_000; // expired
    const again = new GoogleCliAuth({ clientId: "cid", clientSecret: "sec", cacheFile: file, fetch: google.fetchFn, now: () => clock });
    expect(await again.getToken()).toBe("A2");
    expect(google.calls[0]!.body.get("grant_type")).toBe("refresh_token");
    expect(google.calls[0]!.body.get("refresh_token")).toBe("R1");
  });

  it("forgets everything on sign-out", async () => {
    const file = await cacheFile();
    await (await import("node:fs/promises")).writeFile(file, JSON.stringify({ refreshToken: "R1" }));
    const auth = new GoogleCliAuth({ clientId: "c", clientSecret: "s", cacheFile: file, fetch: fakeGoogle([]).fetchFn });
    await auth.signOut();
    await expect(readFile(file, "utf-8")).rejects.toThrow();
  });

  it("refuses a redirect whose state does not match", async () => {
    const file = await cacheFile();
    const auth = new GoogleCliAuth({
      clientId: "c",
      clientSecret: "s",
      cacheFile: file,
      fetch: fakeGoogle([]).fetchFn,
      openUrl: (url) => {
        const back = new URL(new URL(url).searchParams.get("redirect_uri")!);
        back.searchParams.set("code", "x");
        back.searchParams.set("state", "forged");
        void fetch(back);
      },
    });
    await expect(auth.signIn()).rejects.toThrow(/unexpected state/);
  });
});
