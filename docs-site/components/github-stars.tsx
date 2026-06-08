import { Suspense } from "react";
import { GitHubIcon } from "@/components/github-icon";

const REPO = "kaelio/ktx";
const REPO_URL = `https://github.com/${REPO}`;
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

async function StarsContent() {
  const count = await fetchStarCount();
  const label =
    count === null
      ? "Star ktx on GitHub"
      : `Star ktx on GitHub — ${count.toLocaleString("en-US")} stars`;

  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="ktx-stars"
    >
      <span className="ktx-stars-seg ktx-stars-seg--label">
        <GitHubIcon className="ktx-stars-gh" />
        <span className="ktx-stars-text">Star</span>
      </span>
      {count !== null && (
        <span className="ktx-stars-seg ktx-stars-seg--count">
          <StarGlyph />
          <span className="ktx-stars-count">{formatStars(count)}</span>
        </span>
      )}
    </a>
  );
}

function StarsSkeleton() {
  return (
    <span className="ktx-stars ktx-stars--skeleton" aria-hidden="true">
      <span className="ktx-stars-seg ktx-stars-seg--label">
        <GitHubIcon className="ktx-stars-gh" />
        <span className="ktx-stars-text">Star</span>
      </span>
      <span className="ktx-stars-seg ktx-stars-seg--count">
        <span className="ktx-stars-skeleton-bar" />
      </span>
    </span>
  );
}

export function GitHubStars() {
  return (
    <Suspense fallback={<StarsSkeleton />}>
      <StarsContent />
    </Suspense>
  );
}
