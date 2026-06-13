import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Logo } from "@/components/logo";
import { SlackIcon } from "@/components/slack-icon";
import { GitHubStars, GITHUB_REPO_URL } from "@/components/github-stars";
import { ThemeToggle } from "@/components/theme-toggle";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: Logo,
    transparentMode: "top",
  },
  // Custom two-icon switcher (light / dark) where each icon selects its own
  // theme. The default "light-dark" switcher is a single blind toggle — both
  // icons just flip the theme, so clicking the sun while already in light mode
  // jumps to dark, which reads as broken.
  slots: {
    themeSwitch: ThemeToggle,
  },
  links: [
    {
      type: "icon",
      label: "Join the ktx Slack community",
      icon: <SlackIcon />,
      text: "Slack",
      url: "https://join.slack.com/t/ktxcommunity/shared_invite/zt-3y9b44m1x-LVyNNJD5nwaZHq4XS29LMQ",
      external: true,
    },
    {
      type: "icon",
      label: "Star ktx on GitHub",
      icon: <GitHubStars />,
      text: "GitHub",
      url: GITHUB_REPO_URL,
      external: true,
    },
  ],
};
