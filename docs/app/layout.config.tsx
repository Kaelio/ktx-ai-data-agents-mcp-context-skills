import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Logo } from "@/components/logo";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: <Logo />,
    transparentMode: "top",
  },
  githubUrl: "https://github.com/kaelio/ktx",
};
