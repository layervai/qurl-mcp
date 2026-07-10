import { getRequestQurlApiKey } from "./auth/request-context.js";

type ConsoleMethodName = "log" | "info" | "debug" | "warn" | "error";

const PATCH_FLAG = Symbol.for("qurl-mcp.consoleTimestampPatched");
// Keep this aligned with the qURL API credential contract when its documented
// key format changes. Bearer-form credentials are redacted independently.
// Exact active/environment credentials are removed first as the
// format-independent backstop; this prefix pattern catches other current qURL
// keys that appear in unstructured upstream text.
const QURL_API_KEY_PATTERN = /lv_[A-Za-z0-9_-]+/g;
const BEARER_CREDENTIAL_PATTERN = /Bearer\s+\S+/gi;
const sensitiveLogValuesByScope = new Map<string, Set<string>>();

export function registerSensitiveLogValues(scope: string, values: Array<string | undefined>): void {
  const sensitiveValues = new Set(values.filter((value): value is string => Boolean(value)));
  if (sensitiveValues.size === 0) sensitiveLogValuesByScope.delete(scope);
  else sensitiveLogValuesByScope.set(scope, sensitiveValues);
}

export function clearSensitiveLogValues(scope?: string): void {
  if (scope === undefined) sensitiveLogValuesByScope.clear();
  else sensitiveLogValuesByScope.delete(scope);
}

function formatTimestamp(date = new Date()): string {
  return date.toISOString().replace("T", " ").replace("Z", " UTC");
}

export function logInfo(message: string): void {
  process.stderr.write(`${formatTimestamp()} ${sanitizeLogValue(message)}\n`);
}

function redactAndFlattenLogValue(value: string): string {
  let redacted = value;
  const credentials = [
    ...Array.from(sensitiveLogValuesByScope.values()).flatMap((values) => [...values]),
    getRequestQurlApiKey(),
    process.env.QURL_API_KEY,
    process.env.QURL_SMTP_USERNAME,
    process.env.QURL_SMTP_PASSWORD,
  ].filter((credential): credential is string => Boolean(credential));
  for (const credential of new Set(credentials)) {
    redacted = redacted.replaceAll(credential, "[REDACTED]");
  }
  return redacted
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

function sanitizeConsoleArgumentWithoutTruncation(arg: unknown): string {
  if (typeof arg === "string") return redactAndFlattenLogValue(arg);
  if (arg instanceof Error) {
    const name = redactAndFlattenLogValue(arg.name || "Error");
    const message = redactAndFlattenLogValue(arg.message || "no message");
    return `${name}: ${message}`;
  }
  if (arg === null || ["number", "boolean", "bigint"].includes(typeof arg)) return String(arg);
  // Do not let console format arbitrary objects because nested credential
  // fields would bypass string redaction. Call sites that need structure must
  // select and sanitize the fields they intend to log.
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
