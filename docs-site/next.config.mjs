import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  basePath: "/ktx",
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/stars",
          has: [{ type: "host", value: "ktx.sh" }],
          destination: "https://ktx-stars.vercel.app/stars",
          basePath: false,
        },
        {
          source: "/stars/:path*",
          has: [{ type: "host", value: "ktx.sh" }],
          destination: "https://ktx-stars.vercel.app/stars/:path*",
          basePath: false,
        },
      ],
      afterFiles: [
        {
          source: "/docs/:path*.md",
          destination: "/llms.mdx/docs/:path*",
        },
      ],
    };
  },
  async redirects() {
    // Alias-host canonicalization MUST come before the generic root/docs
    // redirects below. Those generic rules have no host guard, so if they ran
    // first they would inject a "/ktx" basePath into the path on the alias
    // hosts, which the alias catch-alls would then prepend a second time —
    // producing https://docs.kaelio.com/ktx/ktx/docs/... Redirects also run
    // before beforeFiles rewrites, so the ktx.sh catch-all must exclude
    // /stars* to let the stars dashboard rewrite proxy through.
    return [
      {
        source: "/slack",
        has: [{ type: "host", value: "ktx.sh" }],
        destination:
          "https://join.slack.com/t/ktxcommunity/shared_invite/zt-3y9b44m1x-LVyNNJD5nwaZHq4XS29LMQ",
        permanent: false,
        basePath: false,
      },
      {
        source: "/:path*",
        has: [{ type: "host", value: "docs.ktx.sh" }],
        destination: "https://docs.kaelio.com/ktx/:path*",
        permanent: true,
        basePath: false,
      },
      {
        source: "/:path((?!stars(?:/|$)).*)",
        has: [{ type: "host", value: "ktx.sh" }],
        destination: "https://docs.kaelio.com/ktx/:path",
        permanent: true,
        basePath: false,
      },
      {
        source: "/",
        destination: "/ktx/docs/getting-started/introduction",
        permanent: false,
        basePath: false,
      },
      {
        source: "/docs",
        destination: "/docs/getting-started/introduction",
        permanent: false,
        basePath: false,
      },
      {
        // The AI Resources section collapsed from four pages to one. Redirect
        // the retired per-page slugs to the consolidated page. Redirects run
        // before the .md rewrite, so the Markdown variant must be matched
        // first and keep its .md suffix; otherwise a cached per-page Markdown
        // URL would 308 to the HTML page and break the agent Markdown contract.
        source: "/docs/ai-resources/:slug([^/]+\\.md)",
        destination: "/docs/ai-resources.md",
        permanent: true,
      },
      {
        source: "/docs/ai-resources/:slug",
        destination: "/docs/ai-resources",
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
