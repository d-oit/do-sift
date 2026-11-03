export { createResearchServer, listen } from "./server.js";
export {
  ANSWER_BASIS_MESSAGES,
  ANSWER_CACHED_PREFIX,
  ANSWER_EVIDENCE_ONLY_MESSAGE,
  ANSWER_FAILED_MESSAGE,
  ANSWER_GROUNDED_MESSAGE,
  ANSWER_PARTIAL_MESSAGE,
  ANSWER_UNRESOLVED_LABEL,
  DEFAULT_PAGE,
} from "./default-page.js";
export type {
  AnswerDegradedEvent,
  AnswerHttpResponse,
  AnswerSuspectEvent,
  AuthenticatedRequestOwner,
  MembershipAdminHandlers,
  HttpRequestEvent,
  OperationalEvent,
  ResearchRunOutcome,
  ResearchServerOptions,
  RuntimeHandlers,
  SourceCard,
  TenantMemberChangeView,
  TenantMemberView,
} from "./server.js";
export { MEMBERSHIP_ADMIN_CHANGES_PATH, MEMBERSHIP_ADMIN_PATH } from "./membership-admin.js";
export { createAnswerService, AnswerCancelledError } from "./answer.js";
export type {
  AnswerOutcome,
  AnswerRevisions,
  AnswerServiceDeps,
  AnswerServiceOptions,
  AnswerTask,
  SynthesisAuditEvent,
  UsageReconciliation,
} from "./answer.js";
export { MetricsRegistry } from "./metrics.js";
export { createRuntime } from "./runtime.js";
export type { Runtime, RuntimeOptions } from "./runtime.js";
export {
  DEFAULT_MAX_RESOLVED_TENANTS,
  TenantAccessError,
  createRuntimeResolver,
  resolvePrincipalRuntime,
} from "./runtime-resolver.js";
export type {
  PrincipalRuntimeDeps,
  PrincipalRuntimeRequest,
  RuntimeResolver,
  RuntimeResolverOptions,
  TenantAccessFailure,
} from "./runtime-resolver.js";
export {
  canonicalizeUrl,
  createMergedSearchProvider,
  mergeSearchHits,
  MergedSearchError,
} from "./search-merge.js";

// MCP (Model Context Protocol) stdio adapter — issue #122, plan 037.
export {
  JSON_RPC_ERRORS,
  SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  callTool,
  createSession,
  handleLine,
  handleMessage,
  listTools,
  negotiateVersion,
  validateArguments,
} from "./mcp.js";
export type {
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
  McpHost,
  McpServerOptions,
  McpToolDefinition,
  McpToolResult,
  ProtocolVersion,
} from "./mcp.js";
