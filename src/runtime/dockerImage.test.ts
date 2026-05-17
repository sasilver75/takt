import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("Docker worker image definition", () => {
  test("includes baseline browser evidence tooling", async () => {
    const dockerfile = await readFile("docker/codex-worker.Dockerfile", "utf8");
    const goDockerfile = await readFile("docker/codex-worker-go.Dockerfile", "utf8");
    const captureHelper = await readFile("docker/takt-capture-url", "utf8");

    expect(dockerfile).toContain("chromium");
    expect(dockerfile).toContain("CHROME_BIN=/usr/bin/chromium");
    expect(dockerfile).toContain("COPY docker/takt-capture-url");
    expect(goDockerfile).toContain("golang-go");
    expect(goDockerfile).toContain("chromium");
    expect(goDockerfile).toContain("COPY docker/takt-capture-url");
    expect(captureHelper).toContain("chromium");
    expect(captureHelper).toContain("--screenshot=");
    expect(captureHelper).toContain("--headless=new");
    expect(captureHelper).toContain("2>&1");
    expect(captureHelper).toContain("cat \"$log_path\" >&2");
  });
});
