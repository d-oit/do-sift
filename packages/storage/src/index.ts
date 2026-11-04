export { MigrationError, applyMigrations, hashMigrationSql, loadMigrations } from "./migrate.js";
export type { AppliedMigration, Migration } from "./migrate.js";
export { DEFAULT_TENANT_ID } from "@do-sift/contracts";
export { Repositories } from "./repositories.js";
export type {
  AnswerBlocks,
  AnswerInput,
  AnswerRow,
  AnswerUsage,
  DocumentInput,
  DocumentOrigin,
  DocumentRow,
  EpisodeRow,
  FeedbackRow,
  OwnerRow,
  PassageInput,
  PassageNoiseClass,
  PassageRow,
  RequestRow,
} from "./repositories.js";
export {
  SYSTEM_ACTOR,
  TENANT_MEMBER_CHANGE_LIMIT,
  TenantMembershipDirectory,
} from "./membership.js";
export type { TenantMemberRow } from "./membership.js";
export { BudgetService, BudgetServiceError } from "./budget.js";
export type { DailyCaps, HeldUsage, ReserveInput, SettleInput, SettleResult } from "./budget.js";
export { backfillPassageNoiseClasses } from "./noise.js";
export {
  DEFAULT_MEMBER_CHANGE_RETENTION_DAYS,
  DEFAULT_RETENTION_CONFIG,
  MIN_MEMBER_CHANGE_RETENTION_DAYS,
  calculateSafeCutoff,
  calculateStartOfTodayUtc,
  executeOwnerRetention,
  pruneMemberChangeLog,
  pruneOwnerHistory,
  validateCutoffIso,
  validateMemberChangeRetentionDays,
} from "./retention.js";
export type {
  MemberChangeRetentionOptions,
  MemberChangeRetentionReceipt,
  RetentionConfig,
  RetentionOptions,
  RetentionReceipt,
  RetentionResult,
} from "./retention.js";
export { JobQueue, JobQueueError } from "./jobs.js";
export type { JobQueueOptions, JobRecord, JobStatus } from "./jobs.js";
export { buildMatchQuery, extractQueryTokens, searchPassages } from "./retrieval.js";
export type { PassageHit } from "./retrieval.js";
export {
  EmptyVectorError,
  NonFiniteVectorError,
  VectorCountMismatchError,
  VectorDimensionMismatchError,
  VectorValidationError,
  backfillPassageEmbeddings,
  blobToVector,
  cosineSimilarity,
  getExistingModelDimension,
  hybridSearch,
  MAX_EMBEDDING_CANDIDATES,
  rrfFuse,
  searchByEmbedding,
  storePassageEmbeddings,
  validateVector,
  vectorToBlob,
} from "./embeddings.js";
export type { BackfillOptions, BackfillResult, TextEmbedder, VectorHit } from "./embeddings.js";
export { createFastEmbedEmbedder, EMBEDDING_MODEL_ID } from "./fastembed-embedder.js";
export {
  BackupError,
  assertLocalLibsqlUrl,
  backupToFile,
  openRestore,
  verifyRestore,
} from "./backup.js";
export {
  SYNTHESIS_FAILURE_KINDS,
  SynthesisCallLogService,
  synthesisCostMicroUsd,
} from "./synthesis-log.js";
export type { SynthesisCallLog, SynthesisCallRow, SynthesisFailureKind } from "./synthesis-log.js";
