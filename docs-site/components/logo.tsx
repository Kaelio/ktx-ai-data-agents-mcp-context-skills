"use client";

import Link from "next/link";

const brandFont = {
  fontFamily: "var(--font-display), var(--font-sans), sans-serif",
} as const;

export function Logo({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <div className={className}>
      <div className="flex items-center gap-3.5 group">
        <Link href={href} aria-label="ktx documentation home" className="flex items-center no-underline">
          <span className="relative flex items-center justify-center transition-transform duration-300 ease-out group-hover:rotate-[-4deg]">
            <img
              src="/ktx/brand/ktx-mascot.svg"
              alt=""
              aria-hidden="true"
              className="h-20 w-20 object-contain block dark:hidden"
            />
            <img
              src="/ktx/brand/ktx-mascot-dark.svg"
              alt=""
              aria-hidden="true"
              className="h-20 w-20 object-contain hidden dark:block"
            />
          </span>
        </Link>
        <div className="flex flex-col items-start leading-none">
          <Link
            href={href}
            className="text-[42px] font-semibold text-fd-foreground tracking-tight no-underline"
            style={brandFont}
          >
            ktx
          </Link>
          <a
            href="https://www.kaelio.com"
            target="_blank"
            rel="noreferrer"
            className="mt-1 whitespace-nowrap text-[13px] font-medium text-fd-muted-foreground/80 tracking-tight no-underline transition-colors hover:text-fd-foreground"
            style={brandFont}
          >
            by Kaelio
          </a>
        </div>
        <span
          className="text-[19px] font-medium text-fd-muted-foreground/80 tracking-tight border-l border-fd-border pl-3 ml-1"
          style={brandFont}
        >
          Docs
        </span>
      </div>
    </div>
  );
}
