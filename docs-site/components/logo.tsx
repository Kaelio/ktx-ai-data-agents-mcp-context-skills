export function Logo() {
  return (
    <div className="flex items-center gap-2.5 group">
      <div className="relative flex items-center justify-center transition-transform duration-300 ease-out group-hover:rotate-[-4deg]">
        <img
          src="/brand/ktx-mascot.svg"
          alt=""
          aria-hidden="true"
          className="h-14 w-14 object-contain block dark:hidden"
        />
        <img
          src="/brand/ktx-mascot-dark.svg"
          alt=""
          aria-hidden="true"
          className="h-14 w-14 object-contain hidden dark:block"
        />
      </div>
      <span
        className="text-[17px] font-semibold text-fd-foreground tracking-tight"
        style={{ fontFamily: "var(--font-display), var(--font-sans), sans-serif" }}
      >
        KTX
      </span>
      <span
        className="text-[14px] font-medium text-fd-muted-foreground/80 tracking-tight border-l border-fd-border pl-2 ml-0.5"
        style={{ fontFamily: "var(--font-display), var(--font-sans), sans-serif" }}
      >
        Docs
      </span>
    </div>
  );
}
