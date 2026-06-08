import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { baseOptions } from "@/app/layout.config";
import { GitHubStars } from "@/components/github-stars";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      {...baseOptions}
      sidebar={{
        banner: (
          <div className="flex">
            <GitHubStars />
          </div>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
