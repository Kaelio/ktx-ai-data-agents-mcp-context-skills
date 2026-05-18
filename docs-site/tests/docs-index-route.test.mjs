import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const configuredDocsSiteUrl = process.env.DOCS_SITE_URL;
const docsBasePath = "/ktx";
let docsSiteUrl = configuredDocsSiteUrl;
let docsServer;
let docsServerOutput = "";
let nextEnvPath;
let nextEnvContents;

async function getAvailablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return address.port;
}

function appendDocsServerOutput(chunk) {
  docsServerOutput = `${docsServerOutput}${chunk.toString()}`.slice(-4000);
}

async function waitForDocsServer() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (docsServer?.exitCode !== null) {
      throw new Error(
        `Docs server exited before it was ready.\n${docsServerOutput}`,
      );
    }

    try {
      await fetch(`${docsSiteUrl}${docsBasePath}/docs`, { redirect: "manual" });
      return;
    } catch {
      await delay(200);
    }
  }

  throw new Error(`Timed out waiting for docs server.\n${docsServerOutput}`);
}

before(async () => {
  if (configuredDocsSiteUrl) {
    return;
  }

  const docsSiteDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  nextEnvPath = join(docsSiteDir, "next-env.d.ts");
  nextEnvContents = await readFile(nextEnvPath, "utf8");

  const port = await getAvailablePort();
  docsSiteUrl = `http://127.0.0.1:${port}`;
  docsServer = spawn(
    "pnpm",
    ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", `${port}`],
    {
      cwd: docsSiteDir,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  docsServer.stdout.on("data", appendDocsServerOutput);
  docsServer.stderr.on("data", appendDocsServerOutput);

  await waitForDocsServer();
});

after(async () => {
  if (docsServer && docsServer.exitCode === null) {
    docsServer.kill("SIGTERM");
    await Promise.race([
      once(docsServer, "exit"),
      delay(5000).then(() => docsServer?.kill("SIGKILL")),
    ]);
  }

  if (nextEnvPath && nextEnvContents !== undefined) {
    await writeFile(nextEnvPath, nextEnvContents);
  }
});

test("/ktx/docs redirects to the docs introduction", async () => {
  const response = await fetch(`${docsSiteUrl}${docsBasePath}/docs`, {
    redirect: "manual",
  });

  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    `${docsBasePath}/docs/getting-started/introduction`,
  );
});

test("/ktx/api/search returns docs search results", async () => {
  const response = await fetch(
    `${docsSiteUrl}${docsBasePath}/api/search?query=setup`,
  );

  assert.equal(response.status, 200);

  const results = await response.json();
  assert.ok(Array.isArray(results), "search response should be an array");
  assert.ok(
    results.some(
      (result) =>
        typeof result.url === "string" && result.url.startsWith("/docs/"),
    ),
    "search should return at least one docs result",
  );
});
