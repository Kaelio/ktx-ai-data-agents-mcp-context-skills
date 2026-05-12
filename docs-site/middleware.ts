import { NextResponse, type NextRequest } from "next/server";

const markdownMimeTypes = new Set([
  "text/markdown",
  "text/x-markdown",
  "application/markdown",
]);

export function middleware(request: NextRequest) {
  if (!isMarkdownPreferred(request.headers.get("accept"))) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (!pathname.startsWith("/docs/") || pathname.endsWith(".md")) {
    return NextResponse.next();
  }

  const rewriteUrl = request.nextUrl.clone();
  rewriteUrl.pathname = `/llms.mdx${pathname}`;

  return NextResponse.rewrite(rewriteUrl);
}

export const config = {
  matcher: ["/docs/:path*"],
};

function isMarkdownPreferred(acceptHeader: string | null) {
  if (!acceptHeader) return false;

  const accepted = acceptHeader
    .split(",")
    .map((entry, index) => {
      const [type = "", ...parameters] = entry.trim().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim())
        .find((parameter) => parameter.startsWith("q="));

      return {
        type: type.trim().toLowerCase(),
        quality: quality ? Number.parseFloat(quality.slice(2)) : 1,
        index,
      };
    })
    .filter((entry) => Number.isFinite(entry.quality) && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);

  const preferred = accepted[0]?.type;
  return preferred ? markdownMimeTypes.has(preferred) : false;
}
