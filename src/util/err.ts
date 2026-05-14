export type ErrCode =
  | "NOT_FOUND"
  | "BAD_INPUT"
  | "EMBEDDING_DOWN"
  | "DB_LOCKED"
  | "MIGRATION_FAILED"
  | "CONFIG"
  | "LLM_AUTH"
  | "LLM_DOWN"
  | "EXTERNAL_TOOL"
  | "UNKNOWN";

export class KenError extends Error {
  code: ErrCode;
  exitCode: number;
  hint?: string;

  constructor(code: ErrCode, message: string, opts: { exitCode?: number; hint?: string } = {}) {
    super(message);
    this.code = code;
    this.exitCode = opts.exitCode ?? exitCodeFor(code);
    this.hint = opts.hint;
  }
}

function exitCodeFor(code: ErrCode): number {
  switch (code) {
    case "NOT_FOUND": return 4;
    case "BAD_INPUT": return 2;
    case "EMBEDDING_DOWN": return 5;
    case "DB_LOCKED": return 6;
    case "MIGRATION_FAILED": return 7;
    case "CONFIG": return 8;
    case "LLM_AUTH": return 9;
    case "LLM_DOWN": return 10;
    case "EXTERNAL_TOOL": return 11;
    default: return 1;
  }
}
