import "./global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import { Outfit, Inter, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import type { Metadata } from "next";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    template: "%s | KTX Docs",
    default: "KTX Docs",
  },
  description:
    "Open-source context infrastructure that makes agentic analytics reliable.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${outfit.variable} ${inter.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
