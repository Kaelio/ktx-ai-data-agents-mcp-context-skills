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
import { readDocsPageMarkdown } from "@/lib/docs-markdown";

const docsIndexPath = "/docs/getting-started/introduction";
const docsIndexSlug = ["getting-started", "introduction"] as const;

function isDocsIndex(slug: string[] | undefined) {
  return slug === undefined || slug.length === 0 || slug.join("/") === "";
}

function isHeroPage(slug: string[] | undefined) {
  return slug?.join("/") === "getting-started/introduction";
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
  const mdxSource = await readDocsPageMarkdown(page.slugs);

  const hero = isHeroPage(params.slug);

  return (
    <DocsPage toc={page.data.toc}>
      {!hero && (
        <>
          <div className="flex items-start justify-between gap-4">
            <DocsTitle>{page.data.title}</DocsTitle>
            <DocsPageActions
              markdownUrl={`${page.url}.md`}
              mdxSource={mdxSource}
            />
          </div>
          <DocsDescription>{page.data.description}</DocsDescription>
        </>
      )}
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
