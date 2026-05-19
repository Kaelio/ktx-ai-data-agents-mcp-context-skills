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
const JSON_TOKEN_PATTERN =
  /"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?\b|\b(?:true|false|null)\b|[{}[\],:]/g;
const SQL_TOKEN_PATTERN =
  /--[^\n]*|'(?:''|[^'])*'|\b\d+(?:\.\d+)?\b|\b(?:select|from|join|left|right|inner|outer|on|where|group|by|order|limit|as|sum|avg|min|max|count|coalesce|date_trunc|case|when|then|else|end|and|or|is|not|null|false|true|with|having|over|partition|insert|update|delete|create|alter|drop|table|view)\b|[(),.;=*<>+-]/gi;
const CODE_LIKE_TOKEN_PATTERN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|#(?![{\w-]+:)[^\n]*|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?\b\d+(?:\.\d+)?\b|\b(?:const|let|var|function|return|import|export|from|type|interface|extends|async|await|if|else|for|while|switch|case|break|continue|try|catch|throw|new|class|public|private|protected|readonly|true|false|null|undefined|pnpm|uv|ktx|node|npx|curl|git)\b|--?[\w-]+|[{}[\](),.;:=*<>|&+-]/g;
const SQL_FUNCTIONS = new Set([
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "coalesce",
  "date_trunc",
]);
const CODE_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "import",
  "export",
  "from",
  "type",
  "interface",
  "extends",
  "async",
  "await",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "try",
  "catch",
  "throw",
  "new",
  "class",
  "public",
  "private",
  "protected",
  "readonly",
]);
const COMMAND_KEYWORDS = new Set(["pnpm", "uv", "ktx", "node", "npx", "curl", "git"]);
const CODE_CONSTANTS = new Set(["true", "false", "null", "undefined"]);

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

function stripOneLeadingBlankLine(text: string) {
  return text.startsWith("\n") ? text.slice(1) : text;
}

function extractCodeHeader(language: string | null, code: string) {
  const normalized = normalizeLanguage(language);
  const firstLineEnd = code.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? code : code.slice(0, firstLineEnd);
  const rest = firstLineEnd === -1 ? "" : code.slice(firstLineEnd + 1);
  const commentPrefix =
    normalized === "sql"
      ? "--"
      : normalized === "javascript" ||
          normalized === "js" ||
          normalized === "jsx" ||
          normalized === "typescript" ||
          normalized === "ts" ||
          normalized === "tsx"
        ? "//"
        : "#";

  if (!firstLine.trimStart().startsWith(commentPrefix)) {
    return { header: null, code };
  }

  const candidate = firstLine
    .trim()
    .slice(commentPrefix.length)
    .trim();
  const looksLikePath =
    candidate.includes("/") &&
    /\.[A-Za-z0-9]+(?:["'`)]*)?$/.test(candidate);

  if (!looksLikePath) return { header: null, code };

  return {
    header: candidate,
    code: stripOneLeadingBlankLine(rest),
  };
}

function normalizeLanguage(language: string | null) {
  return language?.toLowerCase() ?? "";
}

function pushMatchedToken(
  parts: ReactNode[],
  token: string,
  className: string,
  key: string,
) {
  parts.push(
    <span key={key} className={className}>
      {token}
    </span>,
  );
}

function highlightJson(code: string) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of code.matchAll(JSON_TOKEN_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(code.slice(lastIndex, index));

    const nextText = code.slice(index + token.length);
    const className = token.startsWith('"')
      ? /^\s*:/.test(nextText)
        ? "ktx-token-key"
        : "ktx-token-string"
      : /^-?\d/.test(token)
        ? "ktx-token-number"
        : /^(true|false|null)$/.test(token)
          ? "ktx-token-constant"
          : "ktx-token-punctuation";

    pushMatchedToken(parts, token, className, `json-${tokenIndex}`);
    lastIndex = index + token.length;
    tokenIndex += 1;
  }

  if (lastIndex < code.length) parts.push(code.slice(lastIndex));
  return parts;
}

function highlightYaml(code: string) {
  const parts: ReactNode[] = [];
  const lines = code.split(/(\n)/);
  let tokenIndex = 0;

  for (const line of lines) {
    if (line === "\n") {
      parts.push(line);
      continue;
    }

    const commentIndex = line.search(/\s#/);
    const fullLineComment = line.trimStart().startsWith("#");
    const contentEnd =
      fullLineComment || commentIndex === -1 ? line.length : commentIndex + 1;
    const content = fullLineComment ? "" : line.slice(0, contentEnd);
    const comment = fullLineComment ? line : line.slice(contentEnd);
    const keyMatch = content.match(/^(\s*(?:-\s*)?)([A-Za-z_][\w.-]*)(\s*:)/);

    if (keyMatch) {
      parts.push(keyMatch[1]);
      pushMatchedToken(parts, keyMatch[2], "ktx-token-key", `yaml-key-${tokenIndex}`);
      pushMatchedToken(
        parts,
        keyMatch[3],
        "ktx-token-punctuation",
        `yaml-colon-${tokenIndex}`,
      );
      const rest = content.slice(keyMatch[0].length);
      if (rest) parts.push(...highlightInlineValue(rest, `yaml-${tokenIndex}`));
    } else if (content) {
      parts.push(...highlightInlineValue(content, `yaml-${tokenIndex}`));
    }

    if (comment) {
      pushMatchedToken(parts, comment, "ktx-token-comment", `yaml-comment-${tokenIndex}`);
    }
    tokenIndex += 1;
  }

  return parts;
}

function highlightInlineValue(value: string, keyPrefix: string) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let tokenIndex = 0;
  const pattern = /'(?:''|[^'])*'|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?\b|\b(?:true|false|null)\b|[()[\]{},:=!<>+-]/g;

  for (const match of value.matchAll(pattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(value.slice(lastIndex, index));

    const className =
      token.startsWith("'") || token.startsWith('"')
        ? "ktx-token-string"
        : /^-?\d/.test(token)
          ? "ktx-token-number"
          : /^(true|false|null)$/.test(token)
            ? "ktx-token-constant"
            : "ktx-token-punctuation";

    pushMatchedToken(parts, token, className, `${keyPrefix}-value-${tokenIndex}`);
    lastIndex = index + token.length;
    tokenIndex += 1;
  }

  if (lastIndex < value.length) parts.push(value.slice(lastIndex));
  return parts;
}

function highlightSql(code: string) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of code.matchAll(SQL_TOKEN_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(code.slice(lastIndex, index));

    const lowerToken = token.toLowerCase();
    const className = token.startsWith("--")
      ? "ktx-token-comment"
      : token.startsWith("'")
        ? "ktx-token-string"
        : /^\d/.test(token)
          ? "ktx-token-number"
          : SQL_FUNCTIONS.has(lowerToken)
            ? "ktx-token-function"
            : /^[a-z_]+$/i.test(token)
              ? "ktx-token-keyword"
              : "ktx-token-punctuation";

    pushMatchedToken(parts, token, className, `sql-${tokenIndex}`);
    lastIndex = index + token.length;
    tokenIndex += 1;
  }

  if (lastIndex < code.length) parts.push(code.slice(lastIndex));
  return parts;
}

function highlightCodeLike(code: string) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of code.matchAll(CODE_LIKE_TOKEN_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(code.slice(lastIndex, index));

    const lowerToken = token.toLowerCase();
    const className =
      token.startsWith("//") || token.startsWith("/*") || token.startsWith("#")
        ? "ktx-token-comment"
        : token.startsWith("'") || token.startsWith('"') || token.startsWith("`")
          ? "ktx-token-string"
          : /^-?\d/.test(token)
            ? "ktx-token-number"
            : CODE_CONSTANTS.has(lowerToken)
              ? "ktx-token-constant"
              : CODE_KEYWORDS.has(lowerToken)
                ? "ktx-token-keyword"
                : COMMAND_KEYWORDS.has(lowerToken)
                  ? "ktx-token-function"
                  : token.startsWith("-")
                    ? "ktx-token-flag"
                    : "ktx-token-punctuation";

    pushMatchedToken(parts, token, className, `code-${tokenIndex}`);
    lastIndex = index + token.length;
    tokenIndex += 1;
  }

  if (lastIndex < code.length) parts.push(code.slice(lastIndex));
  return parts;
}

function highlightCode(language: string | null, code: string) {
  const normalized = normalizeLanguage(language);
  if (normalized === "json" || normalized === "jsonc") return highlightJson(code);
  if (normalized === "yaml" || normalized === "yml") return highlightYaml(code);
  if (normalized === "sql") return highlightSql(code);
  if (
    [
      "bash",
      "sh",
      "shell",
      "zsh",
      "javascript",
      "js",
      "jsx",
      "typescript",
      "ts",
      "tsx",
      "python",
      "py",
    ].includes(normalized)
  ) {
    return highlightCodeLike(code);
  }
  return code;
}

export function CodeBlock(props: Props) {
  const { children, title, className: _ignored, ...rest } = props;
  const language = detectLanguage(props, children);
  const rawCodeText = extractText(children);
  const extractedHeader = extractCodeHeader(language, rawCodeText);
  const codeText = extractedHeader.code;
  const headerTitle =
    typeof title === "string" && title.length > 0
      ? title
      : extractedHeader.header;
  const highlightedCode = highlightCode(language, codeText);

  const hasHeader = typeof headerTitle === "string" && headerTitle.length > 0;
  const isOutput =
    !hasHeader &&
    (WIZARD_GLYPHS.test(rawCodeText) ||
      (language !== null && OUTPUT_LANGS.has(language)));

  // Mode D - Output preview (wizard prompts, terminal output)
  if (isOutput) {
    return (
      <div className="not-prose ktx-code ktx-code-output group relative">
        <span className="ktx-code-output-label">output</span>
        <CopyButton text={rawCodeText} className="ktx-code-output-copy" />
        <pre {...rest} className="ktx-code-body ktx-code-body-output">
          {children}
        </pre>
      </div>
    );
  }

  // Mode B - Header (filename present)
  if (hasHeader) {
    return (
      <div className="not-prose ktx-code ktx-code-tab group">
        <div className="ktx-code-tab-head">
          {language && <span className="ktx-lang-pill">{language}</span>}
          <span className="ktx-code-tab-filename">{headerTitle}</span>
          <CopyButton text={codeText} className="ml-auto" />
        </div>
        <pre {...rest} className="ktx-code-body ktx-code-body-tab">
          {highlightedCode}
        </pre>
      </div>
    );
  }

  // Mode C - Minimal default
  return (
    <div className="not-prose ktx-code ktx-code-minimal group relative">
      <CopyButton text={codeText} className="ktx-code-minimal-copy" />
      <pre {...rest} className="ktx-code-body ktx-code-body-minimal">
        {highlightedCode}
      </pre>
    </div>
  );
}
