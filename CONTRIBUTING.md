# Contributing to KTX

Thanks for your interest in KTX. This page covers **how to contribute** and
the **contributor rewards program**. For development setup, repository
layout, and verification commands, see the
[Contributing guide in the docs](https://docs.kaelio.com/ktx/docs/community/contributing).

## How to contribute

1. Browse open issues labeled
   [`good first issue`](https://github.com/Kaelio/ktx/labels/good%20first%20issue)
   or [`help wanted`](https://github.com/Kaelio/ktx/labels/help%20wanted).
2. Comment on the issue to claim it. A maintainer will confirm scope and
   assign it to you.
3. For changes not covered by an existing issue, open one first so we can
   align on scope before you write code.
4. Open a pull request that resolves the issue. Keep it focused — one
   logical change per PR.
5. Run the relevant checks before requesting review. See the
   [docs contributing page](https://docs.kaelio.com/ktx/docs/community/contributing#running-tests)
   for the right commands per area.

## Contributor rewards program

We send merch to contributors whose pull requests get merged. The goal is
to thank the people building KTX with us, not to drive volume.

### How it works

1. A maintainer marks an issue `reward:eligible` when it's ready for an
   outside contributor.
2. You open a PR that resolves the issue.
3. A maintainer reviews and merges.
4. After merge, the maintainer adds a `reward:tier-*` label and replies
   on the PR asking you to email `support@kaelio.com` with your shipping
   address, size (if applicable), and a link to the merged PR.
5. We ship within four weeks.

### Reward tiers

| Tier | Reward | Earned by |
|------|--------|-----------|
| 1 | Sticker pack | Your first merged PR, any size |
| 2 | T-shirt | A substantive merged PR: bug fix with a regression test, new docs page, connector test fixture, CLI improvement |
| 3 | Hoodie | Three or more merged PRs, or one major contribution (new integration, significant feature) |

Maintainers decide tier; decisions are final. Tiers do not stack on the
same PR.

### Eligibility

- Only **merged** PRs count. Closed-without-merge or stale PRs do not earn
  rewards.
- The GitHub account must be at least 30 days old at the time the PR is
  opened.
- The PR must resolve a real issue or measurable improvement.
- We ship worldwide where customs allow. If we cannot ship to your region
  we will substitute an equivalent (gift card or digital).

### Not eligible

- Typo-only PRs and whitespace/formatting changes
- Drive-by style or lint cleanup without prior discussion
- Mass reformatting or wrapper/abstraction churn
- AI-generated PRs that do not pass review on their first revision
- PRs that bundle unrelated changes
- Anything that would be reverted in code review

We use these rules to keep the program sustainable and to protect the
quality of the project. They are not a judgment on contributors — they
exist so a small maintainer team can keep saying yes.

## Where to ask what

See the [Community & Support](https://docs.kaelio.com/ktx/docs/community/support)
page for the full guide. The short version:

- **Questions, "how do I...", setup help, sharing patterns**: join the
  [KTX Slack](https://join.slack.com/t/ktxcommunity/shared_invite/zt-3y9b44m1x-LVyNNJD5nwaZHq4XS29LMQ).
- **Bugs**: use the [Bug report](.github/ISSUE_TEMPLATE/bug_report.yml)
  template.
- **Feature requests**: use the
  [Feature request](.github/ISSUE_TEMPLATE/feature_request.yml) template.
- **Security**: report privately via
  [GitHub Security Advisories](https://github.com/Kaelio/ktx/security/advisories/new),
  not as a public issue.

## Code of conduct

KTX follows the
[Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
Be respectful, assume good intent, and keep discussion focused on the
project. Report concerns to the maintainers in Slack or by email at
`support@kaelio.com`.
