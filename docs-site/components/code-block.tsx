"use client";

import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  type ReactElement,
  isValidElement,
} from "react";
import { CopyButton } from "./copy-button";

type Props = ComponentPropsWithoutRef<"pre"> & {
  title?: string;
  "data-language"?: string;
};

const OUTPUT_LANGS = new Set(["text", "plain", "plaintext", "console", "output"]);
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

function findLanguageInNode(node: ReactNode): string | null {
  if (!isValidElement(node)) return null;
  const props = (node as ReactElement<{
    className?: string;
    "data-language"?: string;
    children?: ReactNode;
  }>).props;

  const dataLang = props["data-language"];
  if (typeof dataLang === "string" && dataLang) return dataLang;

  const className = typeof props.className === "string" ? props.className : "";
  const m = className.match(/language-([\w-]+)/);
  if (m) return m[1];

  const children = props.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findLanguageInNode(child);
      if (found) return found;
    }
  } else if (children) {
    return findLanguageInNode(children);
  }
  return null;
}

function detectLanguage(props: Props, children: ReactNode): string | null {
  const dataLang = props["data-language"];
  if (typeof dataLang === "string" && dataLang) return dataLang;

  const className = typeof props.className === "string" ? props.className : "";
  const m = className.match(/language-([\w-]+)/);
  if (m) return m[1];

  return findLanguageInNode(children);
}

export function CodeBlock(props: Props) {
  const { children, title, className: _ignored, ...rest } = props;
  const language = detectLanguage(props, children);
  const codeText = extractText(children);

  const hasTitle = typeof title === "string" && title.length > 0;
  const isOutput =
    !hasTitle &&
    (WIZARD_GLYPHS.test(codeText) ||
      (language !== null && OUTPUT_LANGS.has(language)));

  // Mode D - Output preview (wizard prompts, terminal output)
  if (isOutput) {
    return (
      <div className="not-prose ktx-code ktx-code-output group relative">
        <span className="ktx-code-output-label">output</span>
        <CopyButton text={codeText} className="ktx-code-output-copy" />
        <pre {...rest} className="ktx-code-body ktx-code-body-output">
          {children}
        </pre>
      </div>
    );
  }

  // Mode B - VS Code tab (filename present)
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

  // Mode C - Minimal default
  return (
    <div className="not-prose ktx-code ktx-code-minimal group relative">
      <CopyButton text={codeText} className="ktx-code-minimal-copy" />
      <pre {...rest} className="ktx-code-body ktx-code-body-minimal">
        {children}
      </pre>
    </div>
  );
}
