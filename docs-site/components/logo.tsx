export function Logo() {
  return (
    <div className="flex items-center gap-3.5 group">
      <div className="relative flex items-center justify-center transition-transform duration-300 ease-out group-hover:rotate-[-4deg]">
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
      </div>
      <div className="flex flex-col items-start leading-none">
        <span
          className="text-[24px] font-semibold text-fd-foreground tracking-tight"
          style={{ fontFamily: "var(--font-display), var(--font-sans), sans-serif" }}
        >
          KTX
        </span>
        <span
          className="mt-1 whitespace-nowrap text-[13px] font-medium text-fd-muted-foreground/80 tracking-tight"
          style={{ fontFamily: "var(--font-display), var(--font-sans), sans-serif" }}
        >
          by Kaelio
        </span>
      </div>
      <span
        className="text-[19px] font-medium text-fd-muted-foreground/80 tracking-tight border-l border-fd-border pl-3 ml-1"
        style={{ fontFamily: "var(--font-display), var(--font-sans), sans-serif" }}
      >
        Docs
      </span>
    </div>
  );
}
