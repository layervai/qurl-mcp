type ConsoleMethodName = "log" | "info" | "debug" | "warn" | "error";

const PATCH_FLAG = Symbol.for("qurl-mcp.consoleTimestampPatched");
// Keep this aligned with the qURL API-key format. Bearer-form credentials are
// redacted independently, but a bare key in an upstream error depends on this
// prefix-aware pattern. Supported qURL keys always use `lv_`; an arbitrary
// non-prefixed secret cannot be identified safely from unstructured text.
const QURL_API_KEY_PATTERN = /lv_[A-Za-z0-9_-]+/g;
const BEARER_CREDENTIAL_PATTERN = /Bearer\s+\S+/gi;

function formatTimestamp(date = new Date()): string {
  return date.toISOString().replace("T", " ").replace("Z", " UTC");
}

export function logInfo(message: string): void {
  process.stderr.write(`${formatTimestamp()} ${sanitizeLogValue(message)}\n`);
}

function redactAndFlattenLogValue(value: string): string {
  return value
    .replace(BEARER_CREDENTIAL_PATTERN, "Bearer [REDACTED]")
    .replace(QURL_API_KEY_PATTERN, "[REDACTED]")
    .replace(/[\r\n\u2028\u2029]/g, " ");
}

export function sanitizeLogValue(value: string): string {
  return redactAndFlattenLogValue(value).slice(0, 512);
}

export function formatErrorForLog(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const name = sanitizeLogValue(error.name || "Error");
  const message = sanitizeLogValue(error.message || "no message");
  return `${name}: ${message}`;
}

export function sanitizeConsoleArgument(arg: unknown): unknown {
  if (typeof arg === "string") return sanitizeLogValue(arg);
  if (arg instanceof Error) return formatErrorForLog(arg);
  if (arg === null || ["number", "boolean", "bigint"].includes(typeof arg)) return arg;
  // Do not let console format arbitrary objects because nested credential
  // fields would bypass string redaction. Call sites that need structure must
  // select and sanitize the fields they intend to log.
  try {
    return sanitizeLogValue(String(arg));
  } catch {
    return "[unprintable]";
  }
}

function sanitizeConsoleArgumentWithoutTruncation(arg: unknown): string {
  if (typeof arg === "string") return redactAndFlattenLogValue(arg);
  if (arg instanceof Error) {
    const name = redactAndFlattenLogValue(arg.name || "Error");
    const message = redactAndFlattenLogValue(arg.message || "no message");
    return `${name}: ${message}`;
  }
  if (arg === null || ["number", "boolean", "bigint"].includes(typeof arg)) return String(arg);
  try {
    return redactAndFlattenLogValue(String(arg));
  } catch {
    return "[unprintable]";
  }
}

function prefixArgs(args: unknown[]): unknown[] {
  const prefix = `${formatTimestamp()} `;
  if (args.length === 0) {
    return [prefix.trimEnd()];
  }

  // Make redaction the console boundary rather than a call-site convention.
  // Arbitrary objects are collapsed rather than delegated to console's deep
  // formatter, which could reveal nested credentials.
  // Collapse the complete call before applying the final bound. Limiting each
  // argument independently would still allow an unbounded line when a caller
  // supplies many arguments.
  const message = args.map(sanitizeConsoleArgumentWithoutTruncation).join(" ");
  return [`${prefix}${sanitizeLogValue(message)}`];
}

export function installTimestampedConsole(): void {
  const globalConsole = console as typeof console & { [PATCH_FLAG]?: boolean };
  if (globalConsole[PATCH_FLAG]) {
    return;
  }

  // stdout is reserved for JSON-RPC in stdio mode. Route every common console
  // method through the captured stderr writer so a future console.log/info/debug
  // call cannot corrupt the protocol stream or bypass credential redaction.
  const writeToStderr = globalConsole.error.bind(globalConsole);
  const methods: ConsoleMethodName[] = ["log", "info", "debug", "warn", "error"];
  for (const method of methods) {
    Object.defineProperty(globalConsole, method, {
      configurable: true,
      value: (...args: unknown[]) => writeToStderr(...prefixArgs(args)),
      writable: true,
    });
  }

  globalConsole[PATCH_FLAG] = true;
}
