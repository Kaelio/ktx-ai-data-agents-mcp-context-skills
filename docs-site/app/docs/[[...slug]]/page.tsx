import { source } from "@/lib/source";
import {
  DocsPage,
  DocsBody,
  DocsTitle,
  DocsDescription,
} from "fumadocs-ui/page";
import { notFound, redirect } from "next/navigation";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { CodeBlock } from "@/components/code-block";
import { DocsPageActions } from "@/components/docs-page-actions";

const docsIndexPath = "/docs/getting-started/introduction";
const docsIndexSlug = ["getting-started", "introduction"] as const;

function isDocsIndex(slug: string[] | undefined) {
  return slug === undefined || slug.length === 0 || slug.join("/") === "";
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  if (isDocsIndex(params.slug)) {
    redirect(docsIndexPath);
  }

  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsPageActions
        markdownUrl={`${page.url}.md`}
        mdxSource={page.data.content}
      />
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents, pre: CodeBlock }} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return [{ slug: [""] }, ...source.generateParams()];
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(
    isDocsIndex(params.slug) ? [...docsIndexSlug] : params.slug,
  );
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
