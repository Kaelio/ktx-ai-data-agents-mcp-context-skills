import {
  getLlmDocsPage,
  getLlmDocsPages,
  getPageMarkdown,
} from "@/lib/llm-docs";

export const dynamic = "force-static";

export async function GET(
  _request: Request,
  props: { params: Promise<{ slug?: string[] }> },
) {
  const params = await props.params;
  const page = getLlmDocsPage(params.slug);
  if (!page) {
    return new Response("Documentation page not found.\n", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  return new Response(await getPageMarkdown(page), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

export function generateStaticParams() {
  return getLlmDocsPages().map((page) => ({ slug: page.slug }));
}
