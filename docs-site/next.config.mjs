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
    return [
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
        source: "/:path*",
        has: [{ type: "host", value: "docs.ktx.sh" }],
        destination: "https://docs.kaelio.com/ktx/:path*",
        permanent: true,
        basePath: false,
      },
      {
        source: "/slack",
        has: [{ type: "host", value: "ktx.sh" }],
        destination:
          "https://join.slack.com/t/ktxcommunity/shared_invite/zt-3y9b44m1x-LVyNNJD5nwaZHq4XS29LMQ",
        permanent: false,
        basePath: false,
      },
      {
        source: "/:path((?!stars(?:/|$)).*)",
        has: [{ type: "host", value: "ktx.sh" }],
        destination: "https://docs.kaelio.com/ktx/:path",
        permanent: true,
        basePath: false,
      },
    ];
  },
};

export default withMDX(config);
