export function Logo() {
  return (
    <div className="flex items-center gap-2 group">
      <div className="relative flex items-center justify-center transition-transform duration-300 ease-out group-hover:rotate-[-4deg]">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="ktx-grad-a" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="var(--color-fd-primary)" />
              <stop offset="100%" stopColor="var(--color-fd-primary)" stopOpacity="0.55" />
            </linearGradient>
            <linearGradient id="ktx-grad-b" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="var(--color-fd-primary)" stopOpacity="0.85" />
              <stop offset="100%" stopColor="var(--color-fd-primary)" stopOpacity="0.4" />
            </linearGradient>
          </defs>
          {/* Bottom layer */}
          <path
            d="M3 17 L12 21.5 L21 17 L12 12.5 Z"
            fill="url(#ktx-grad-a)"
            opacity="0.4"
          />
          {/* Middle layer */}
          <path
            d="M3 12 L12 16.5 L21 12 L12 7.5 Z"
            fill="url(#ktx-grad-b)"
            opacity="0.7"
          />
          {/* Top layer */}
          <path
            d="M3 7 L12 11.5 L21 7 L12 2.5 Z"
            fill="var(--color-fd-primary)"
          />
        </svg>
      </div>
      <span
        className="text-[15px] font-semibold text-fd-foreground tracking-tight"
        style={{ fontFamily: "var(--font-display), var(--font-sans), sans-serif" }}
      >
        KTX
      </span>
      <span
        className="text-[13px] font-medium text-fd-muted-foreground/80 tracking-tight border-l border-fd-border pl-2 ml-0.5"
        style={{ fontFamily: "var(--font-display), var(--font-sans), sans-serif" }}
      >
        Docs
      </span>
    </div>
  );
}
