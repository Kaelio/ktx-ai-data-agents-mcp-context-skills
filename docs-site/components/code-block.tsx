"use client";

import {
  type ReactNode,
  type ReactElement,
  isValidElement,
} from "react";
import { CopyButton } from "./copy-button";

type Props = {
  children?: ReactNode;
  className?: string;
  title?: string;
  // rehype-pretty-code adds data attributes such as data-language; capture them via index signature
  [key: string]: unknown;
};

const TERMINAL_LANGS = new Set(["bash", "sh", "shell", "zsh"]);
const WIZARD_GLYPHS = /^\s*[◆◇◯◐○●]/;

function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    const props = (node as ReactElement<{ children?: ReactNode }>).props;
    return extractText(props.children);
  }
  return "";
}

function detectLanguage(props: Props, children: ReactNode): string | null {
  const dataLang = props["data-language"];
  if (typeof dataLang === "string" && dataLang) return dataLang;

  const className = typeof props.className === "string" ? props.className : "";
  const m = className.match(/language-([\w-]+)/);
  if (m) return m[1];

  if (isValidElement(children)) {
    const childProps = (children as ReactElement<{ className?: string }>).props;
    const childClass = typeof childProps.className === "string" ? childProps.className : "";
    const cm = childClass.match(/language-([\w-]+)/);
    if (cm) return cm[1];
  }

  return null;
}

export function CodeBlock(props: Props) {
  const { children, title, className: _ignored, ...rest } = props;
  const language = detectLanguage(props, children);
  const codeText = extractText(children);

  const isTerminal =
    (language !== null && TERMINAL_LANGS.has(language)) ||
    WIZARD_GLYPHS.test(codeText);
  const hasTitle = typeof title === "string" && title.length > 0;

  // Mode A — Terminal
  if (isTerminal) {
    return (
      <div className="not-prose ktx-code ktx-code-terminal group">
        <div className="ktx-code-terminal-head">
          <span className="ktx-tl-dot" style={{ background: "#ff5f57" }} />
          <span className="ktx-tl-dot" style={{ background: "#febc2e" }} />
          <span className="ktx-tl-dot" style={{ background: "#28c840" }} />
          <span className="ktx-code-terminal-label">
            {hasTitle ? title : "zsh"}
          </span>
          <CopyButton
            text={codeText}
            className="ml-auto text-white/80"
          />
        </div>
        <pre {...rest} className="ktx-code-body ktx-code-body-terminal">
          {children}
        </pre>
      </div>
    );
  }

  // Mode B — VS Code tab (filename present)
  if (hasTitle) {
    return (
      <div className="not-prose ktx-code ktx-code-tab group">
        <div className="ktx-code-tab-head">
          <span className="ktx-file-glyph" data-lang={language ?? ""} />
          <span className="ktx-code-tab-filename">{title}</span>
          {language && <span className="ktx-lang-pill">{language}</span>}
          <CopyButton text={codeText} className="ml-auto" />
        </div>
        <pre {...rest} className="ktx-code-body ktx-code-body-tab">
          {children}
        </pre>
      </div>
    );
  }

  // Mode C — Minimal default
  return (
    <div className="not-prose ktx-code ktx-code-minimal group relative">
      {language && <span className="ktx-code-minimal-lang">{language}</span>}
      <CopyButton text={codeText} className="ktx-code-minimal-copy" />
      <pre {...rest} className="ktx-code-body ktx-code-body-minimal">
        {children}
      </pre>
    </div>
  );
}
