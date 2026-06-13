import { Suspense } from "react";
import { GitHubIcon } from "@/components/github-icon";

const REPO = "kaelio/ktx";
export const GITHUB_REPO_URL = `https://github.com/${REPO}`;
const API_URL = `https://api.github.com/repos/${REPO}`;

async function fetchStarCount(): Promise<number | null> {
  try {
    const res = await fetch(API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      // Revalidate hourly. GitHub's unauthenticated REST limit is 60 req/h per
      // IP, so a single cached server-side fetch keeps the count fresh while
      // never exposing visitors to rate limits or layout shift.
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: unknown };
    return typeof data.stargazers_count === "number"
      ? data.stargazers_count
      : null;
  } catch {
    return null;
  }
}

/** Compact, GitHub-style count: 847 → "847", 1234 → "1.2k", 12345 → "12.3k". */
function formatStars(count: number): string {
  if (count < 1000) return count.toLocaleString("en-US");
  const thousands = count / 1000;
  const rounded =
    thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
  return `${rounded}k`;
}

function StarGlyph() {
  return (
    <svg className="ktx-stars-star" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.6l2.9 5.88 6.49.95-4.7 4.57 1.11 6.46L12 17.4l-5.8 3.06 1.11-6.46-4.7-4.57 6.49-.95z" />
    </svg>
  );
}

async function StarsInner() {
  const count = await fetchStarCount();
  return (
    <span className="ktx-stars">
      <GitHubIcon className="ktx-stars-gh" />
      {count !== null ? (
        <span className="ktx-stars-count-wrap">
          <StarGlyph />
          <span className="ktx-stars-count">{formatStars(count)}</span>
        </span>
      ) : (
        <span className="ktx-stars-count">Star</span>
      )}
    </span>
  );
}

function StarsSkeleton() {
  return (
    <span className="ktx-stars" aria-hidden="true">
      <GitHubIcon className="ktx-stars-gh" />
      <span className="ktx-stars-skeleton-bar" />
    </span>
  );
}

/**
 * Footer star widget — GitHub mark + live count. Rendered as the `icon` of a
 * fumadocs `type: "icon"` link, so it lands in the sidebar footer pill beside
 * the Slack icon and the theme toggle. fumadocs supplies the surrounding <a>
 * (href + aria-label), so this renders inner content only — no anchor.
 */
export function GitHubStars() {
  return (
    <Suspense fallback={<StarsSkeleton />}>
      <StarsInner />
    </Suspense>
  );
}
