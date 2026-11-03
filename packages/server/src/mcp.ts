/**
 * MCP (Model Context Protocol) server core — issue #122, plan 037.
 *
 * Exposes do-sift's search and answer capabilities to non-Node clients over
 * the stdio transport the MCP specification defines: newline-delimited
 * JSON-RPC 2.0 on stdin/stdout, `initialize` → `notifications/initialized` →
 * `tools/list` / `tools/call`.
 *
 * Deliberately a **transport adapter**, not a second API surface:
 *
 *   - the tools call the same host functions the HTTP server calls, injected
 *     here as plain async functions; nothing in this module fetches, stores,
 *     or bills on its own;
 *   - stdout carries protocol messages only. The specification is explicit
 *     that a server must not write anything else there, so diagnostics go to
 *     stderr through the injected logger;
 *   - a tool failure is reported inside the result (`isError: true`), not as a
 *     JSON-RPC error, which is what the specification asks for validation and
 *     execution errors so a client model can self-correct.
 *
 * Spec reference: https://modelcontextprotocol.io/specification/2025-11-25
 * (lifecycle, stdio transport, tools).
 */

/** Protocol revisions this server can speak. Newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Server identity reported in `initialize`. */
export const SERVER_INFO = { name: "do-sift", version: "0.1.0" } as const;

/** JSON-RPC error codes used by this server. */
export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** One MCP tool definition, in the shape `tools/list` returns. */
export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  /** JSON Schema for the arguments object. */
  inputSchema: Record<string, unknown>;
}

/** The result shape `tools/call` returns. */
export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Host capabilities this server can expose. Each is optional. */
export interface McpHost {
  /** Search mode: zero LLM calls. Returns hits plus provenance. */
  search?: (args: { question: string; limit?: number }) => Promise<unknown>;
  /** Answer mode: exactly one bounded synthesis call. */
  answer?: (args: { question: string }) => Promise<unknown>;
  /** List the evidence already stored for the caller. */
  evidence?: (args: { limit?: number }) => Promise<unknown>;
}

export interface McpServerOptions {
  host: McpHost;
  /** Diagnostics; must never be stdout. Defaults to a no-op. */
  log?: ((line: string) => void) | undefined;
}

const SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["question"],
  properties: {
    question: { type: "string", minLength: 1, maxLength: 2000 },
    limit: { type: "integer", minimum: 1, maximum: 20 },
  },
} as const;

const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["question"],
  properties: {
    question: { type: "string", minLength: 1, maxLength: 2000 },
  },
} as const;

const EVIDENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
} as const;

/** Tools this host exposes, filtered to the capabilities it actually has. */
export function listTools(host: McpHost): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [];
  if (host.search !== undefined) {
    tools.push({
      name: "search",
      title: "Search the web",
      description:
        "Run a zero-LLM search: query the configured providers, store evidence with provenance, and return the sources found. Costs no tokens.",
      inputSchema: SEARCH_SCHEMA as unknown as Record<string, unknown>,
    });
  }
  if (host.answer !== undefined) {
    tools.push({
      name: "answer",
      title: "Answer with citations",
      description:
        "Answer a question from previously stored evidence with exactly one bounded synthesis call. Citations are validated against stored evidence; if they do not resolve, the answer degrades to evidence-only output.",
      inputSchema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
    });
  }
  if (host.evidence !== undefined) {
    tools.push({
      name: "evidence",
      title: "List stored evidence",
      description:
        "List the newest stored sources for the caller, with provenance and no page text.",
      inputSchema: EVIDENCE_SCHEMA as unknown as Record<string, unknown>,
    });
  }
  return tools;
}

/** Negotiate the protocol version: echo the client's when supported, else offer ours. */
export function negotiateVersion(requested: unknown): ProtocolVersion {
  if (typeof requested === "string" && isSupported(requested)) return requested;
  return SUPPORTED_PROTOCOL_VERSIONS[0];
}

function isSupported(value: string): value is ProtocolVersion {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

function textResult(payload: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): McpToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Validate the `arguments` object against one tool's schema, minimally but strictly. */
export function validateArguments(
  tool: McpToolDefinition,
  args: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return { ok: false, message: "arguments must be an object" };
  }
  const value = (args ?? {}) as Record<string, unknown>;
  const schema = tool.inputSchema as {
    properties?: Record<
      string,
      { type?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number }
    >;
    required?: string[];
    additionalProperties?: boolean;
  };
  for (const key of Object.keys(value)) {
    if (schema.additionalProperties === false && schema.properties?.[key] === undefined) {
      return { ok: false, message: `unexpected argument "${key}"` };
    }
  }
  for (const key of schema.required ?? []) {
    if (value[key] === undefined)
      return { ok: false, message: `missing required argument "${key}"` };
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const given = value[key];
    if (given === undefined) continue;
    if (spec.type === "string") {
      if (typeof given !== "string") return { ok: false, message: `"${key}" must be a string` };
      if (spec.minLength !== undefined && given.length < spec.minLength) {
        return { ok: false, message: `"${key}" is shorter than ${spec.minLength}` };
      }
      if (spec.maxLength !== undefined && given.length > spec.maxLength) {
        return { ok: false, message: `"${key}" is longer than ${spec.maxLength}` };
      }
    }
    if (spec.type === "integer") {
      if (typeof given !== "number" || !Number.isInteger(given)) {
        return { ok: false, message: `"${key}" must be an integer` };
      }
      if (spec.minimum !== undefined && given < spec.minimum) {
        return { ok: false, message: `"${key}" must be >= ${spec.minimum}` };
      }
      if (spec.maximum !== undefined && given > spec.maximum) {
        return { ok: false, message: `"${key}" must be <= ${spec.maximum}` };
      }
    }
  }
  return { ok: true, value };
}

/** Call one tool. Never throws: failures become `isError` results. */
export async function callTool(host: McpHost, name: string, args: unknown): Promise<McpToolResult> {
  const tool = listTools(host).find((candidate) => candidate.name === name);
  if (tool === undefined) return errorResult(`unknown tool "${name}"`);
  const validated = validateArguments(tool, args);
  if (!validated.ok) return errorResult(validated.message);
  const input = validated.value;

  try {
    if (name === "search" && host.search !== undefined) {
      const payload = await host.search({
        question: String(input.question),
        ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
      });
      return textResult(payload);
    }
    if (name === "answer" && host.answer !== undefined) {
      return textResult(await host.answer({ question: String(input.question) }));
    }
    if (name === "evidence" && host.evidence !== undefined) {
      const payload = await host.evidence(
        input.limit === undefined ? {} : { limit: Number(input.limit) },
      );
      return textResult(payload);
    }
    return errorResult(`tool "${name}" is not available on this host`);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

interface SessionState {
  /** True once `initialize` succeeded and `notifications/initialized` arrived. */
  ready: boolean;
  /** True once an `initialize` request was answered. */
  initialized: boolean;
  protocolVersion: ProtocolVersion;
}

/**
 * Handle one JSON-RPC message. Returns the response, or undefined for a
 * notification (which by definition has no response).
 */
export async function handleMessage(
  options: McpServerOptions,
  state: SessionState,
  message: JsonRpcRequest,
): Promise<JsonRpcResponse | undefined> {
  const isNotification = message.id === undefined;
  const id = message.id ?? null;

  const respond = (result: unknown): JsonRpcResponse | undefined =>
    isNotification ? undefined : { jsonrpc: "2.0", id, result };
  const fail = (code: number, errorMessage: string): JsonRpcResponse | undefined =>
    isNotification ? undefined : { jsonrpc: "2.0", id, error: { code, message: errorMessage } };

  switch (message.method) {
    case "initialize": {
      const params = (message.params ?? {}) as { protocolVersion?: unknown; clientInfo?: unknown };
      state.protocolVersion = negotiateVersion(params.protocolVersion);
      state.initialized = true;
      options.log?.(
        `initialize from ${describeClient(params.clientInfo)} (protocol ${state.protocolVersion})`,
      );
      return respond({
        protocolVersion: state.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "do-sift exposes zero-LLM web search and citation-checked answers over stored evidence. Call search first, then answer.",
      });
    }
    case "notifications/initialized": {
      state.ready = true;
      return undefined;
    }
    case "ping":
      return respond({});
    case "tools/list": {
      if (!state.initialized) return fail(JSON_RPC_ERRORS.invalidRequest, "not initialized");
      return respond({ tools: listTools(options.host) });
    }
    case "tools/call": {
      if (!state.initialized) return fail(JSON_RPC_ERRORS.invalidRequest, "not initialized");
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") {
        return fail(JSON_RPC_ERRORS.invalidParams, "tools/call requires a string name");
      }
      return respond(await callTool(options.host, params.name, params.arguments));
    }
    default:
      return fail(JSON_RPC_ERRORS.methodNotFound, `unknown method "${message.method}"`);
  }
}

function describeClient(clientInfo: unknown): string {
  if (clientInfo === null || typeof clientInfo !== "object") return "unknown client";
  const info = clientInfo as { name?: unknown; version?: unknown };
  const name = typeof info.name === "string" ? info.name : "unknown";
  const version = typeof info.version === "string" ? info.version : "?";
  return `${name} ${version}`;
}

/** A fresh session state. One per connection. */
export function createSession(): SessionState {
  return { ready: false, initialized: false, protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0] };
}

/**
 * Parse and dispatch one line of input. Returns the serialized response line,
 * or undefined when the message was a notification. A malformed line yields a
 * `-32700` parse error with a null id, which is what JSON-RPC requires.
 */
export async function handleLine(
  options: McpServerOptions,
  state: SessionState,
  line: string,
): Promise<string | undefined> {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return serialize({
      jsonrpc: "2.0",
      id: null,
      error: { code: JSON_RPC_ERRORS.parseError, message: "invalid JSON" },
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return serialize({
      jsonrpc: "2.0",
      id: null,
      error: { code: JSON_RPC_ERRORS.invalidRequest, message: "expected a single JSON-RPC object" },
    });
  }
  const message = parsed as JsonRpcRequest;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return serialize({
      jsonrpc: "2.0",
      id: (message.id ?? null) as string | number | null,
      error: {
        code: JSON_RPC_ERRORS.invalidRequest,
        message: "expected jsonrpc 2.0 with a method",
      },
    });
  }
  const response = await handleMessage(options, state, message);
  return response === undefined ? undefined : serialize(response);
}

function serialize(value: unknown): string {
  // A JSON-RPC line must not contain a newline; JSON.stringify never emits one.
  return JSON.stringify(value);
}
