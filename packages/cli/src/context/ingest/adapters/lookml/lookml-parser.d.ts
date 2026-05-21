declare module 'lookml-parser' {
  /** A single file parsed from its raw content. Top-level keys are block kinds (`view`, `model`, `explore`, …). */
  export type LookmlParseNode = Record<string, unknown>;

  /** Result of `parseFiles` with `fileOutput: 'by-type'`. Top-level categories map to file-name-keyed entries. */
  export interface LookmlProjectByType {
    file?: Record<string, LookmlParseNode>;
    model?: Record<string, LookmlParseNode>;
    view?: Record<string, LookmlParseNode>;
    explore?: Record<string, LookmlParseNode>;
    dashboard?: Record<string, LookmlParseNode>;
    manifest?: Record<string, LookmlParseNode>;
  }

  export interface ParseFilesSourceItem {
    path: string;
    content: string;
  }

  export interface ParseFilesOptions {
    /** Glob string, OR an array of `{ path, content }` pre-read items. */
    source: string | ParseFilesSourceItem[];
    /** `"by-name"` (default), `"array"`, or `"by-type"`. */
    fileOutput?: 'by-name' | 'array' | 'by-type';
    globOptions?: Record<string, unknown>;
    readFileOptions?: { encoding?: string };
    readFileConcurrency?: number;
    console?: Pick<Console, 'log' | 'warn' | 'error'>;
  }

  /** Parse a single LookML source string (not a file). Returns the node tree. */
  export function parse(source: string): LookmlParseNode;

  /** Parse a set of files, following `include:` directives. */
  export function parseFiles<T = LookmlProjectByType>(opts: ParseFilesOptions): Promise<T>;

  const lookmlParser: {
    parse: typeof parse;
    parseFiles: typeof parseFiles;
  };

  export default lookmlParser;
}
