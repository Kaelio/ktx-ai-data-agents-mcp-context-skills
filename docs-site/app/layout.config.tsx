import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { GitHubIcon } from "@/components/github-icon";
import { Logo } from "@/components/logo";
import { SlackIcon } from "@/components/slack-icon";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: Logo,
    transparentMode: "top",
  },
  links: [
    {
      type: "icon",
      label: "GitHub",
      icon: <GitHubIcon />,
      text: "GitHub",
      url: "https://github.com/kaelio/ktx",
      external: true,
    },
    {
      type: "icon",
      label: "Join the ktx Slack community",
      icon: <SlackIcon />,
      text: "Slack",
      url: "https://join.slack.com/t/ktxcommunity/shared_invite/zt-3y9b44m1x-LVyNNJD5nwaZHq4XS29LMQ",
      external: true,
    },
  ],
};
