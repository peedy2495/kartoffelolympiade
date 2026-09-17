import { describe, expect, it } from "vitest";
import { buildAllowedDomains } from "../src/server/allowed-domains.ts";

function hosts(env: Record<string, string>): string[] {
  return buildAllowedDomains(env as NodeJS.ProcessEnv).map(
    (d) => `${d.protocol ?? ""}://${d.hostname}${d.port ? `:${d.port}` : ""}`,
  );
}

describe("allowed domains", () => {
  it("always includes the production host and local http hosts", () => {
    const list = hosts({});
    expect(list).toContain("https://kartoffelolympiade.vercel.app");
    expect(list).toContain("http://localhost");
    expect(list).toContain("http://127.0.0.1");
    expect(list).toContain("http://[::1]");
  });

  it("local patterns carry no port (any dev port matches)", () => {
    const entries = buildAllowedDomains({} as NodeJS.ProcessEnv);
    for (const h of ["localhost", "127.0.0.1", "[::1]"]) {
      const found = entries.find((d) => d.hostname === h);
      expect(found?.protocol).toBe("http");
      expect(found?.port).toBeUndefined();
    }
  });

  it("parses exact Vercel deployment hosts (bare host and URL forms)", () => {
    const list = hosts({
      VERCEL_URL: "preview-abc123-user.vercel.app",
      VERCEL_BRANCH_URL: "https://branch-host.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "kartoffelolympiade.vercel.app",
    });
    expect(list).toContain("https://preview-abc123-user.vercel.app");
    expect(list).toContain("https://branch-host.vercel.app");
    // Production host deduplicated, not repeated.
    expect(list.filter((h) => h === "https://kartoffelolympiade.vercel.app")).toHaveLength(1);
  });

  it("rejects malicious and malformed Vercel values", () => {
    const list = hosts({
      VERCEL_URL: "*.vercel.app",
      VERCEL_BRANCH_URL: "evil.com@kartoffelolympiade.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "not a host / with spaces",
    });
    expect(list).not.toContain("https://*.vercel.app");
    expect(list).toHaveLength(4); // default prod + 3 local only
  });

  it("accepts an explicit APP_ORIGIN custom domain, rejects non-origins", () => {
    expect(hosts({ APP_ORIGIN: "https://spiele.example.de" })).toContain(
      "https://spiele.example.de",
    );
    expect(hosts({ APP_ORIGIN: "http://localhost:4311" })).toContain(
      "http://localhost:4311",
    );
    for (const bad of [
      "https://*.example.de",
      "https://example.de/path",
      "https://example.de?x=1",
      "https://user:pass@example.de",
      "ftp://example.de",
      "not-a-url",
      "",
    ]) {
      expect(hosts({ APP_ORIGIN: bad })).toHaveLength(4);
    }
  });

  it("never emits wildcards or empty-hostname patterns", () => {
    for (const env of [
      {},
      { VERCEL_URL: "*" },
      { VERCEL_URL: "{}" },
      { APP_ORIGIN: "https://*" },
    ]) {
      const entries = buildAllowedDomains(env as NodeJS.ProcessEnv);
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.hostname).toBeTruthy();
        expect(e.hostname).not.toContain("*");
      }
    }
  });
});
