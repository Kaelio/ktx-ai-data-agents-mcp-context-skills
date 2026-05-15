import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  basePath: "/ktx",
  async rewrites() {
    return [
      {
        source: "/docs/:path*.md",
        destination: "/llms.mdx/docs/:path*",
      },
    ];
  },
  async redirects() {
    return [
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
        source: "/:path*",
        has: [{ type: "host", value: "ktx.sh" }],
        destination: "https://docs.kaelio.com/ktx/:path*",
        permanent: true,
        basePath: false,
      },
    ];
  },
};

export default withMDX(config);
