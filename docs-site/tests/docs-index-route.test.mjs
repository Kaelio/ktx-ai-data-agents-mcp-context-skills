import assert from "node:assert/strict";
import test from "node:test";

const docsSiteUrl = process.env.DOCS_SITE_URL ?? "http://localhost:3000";

test("/docs redirects to the docs introduction", async () => {
  const response = await fetch(`${docsSiteUrl}/docs`, { redirect: "manual" });

  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    "/docs/getting-started/introduction",
  );
});
