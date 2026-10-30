export { MigrationError, applyMigrations, hashMigrationSql, loadMigrations } from "./migrate.js";
export type { AppliedMigration, Migration } from "./migrate.js";
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
export { BudgetService, BudgetServiceError } from "./budget.js";
export type { DailyCaps, HeldUsage, ReserveInput, SettleInput, SettleResult } from "./budget.js";
export { backfillPassageNoiseClasses } from "./noise.js";
export {
  ScheduledRetentionRunner,
  calculateRetentionCutoff,
  evaluateOwnerRetention,
  getStartOfUtcDay,
  pruneOwnerHistory,
  validateRetentionCutoff,
} from "./retention.js";
export type {
  PruneOwnerHistoryOptions,
  RetentionCandidates,
  RetentionReceipt,
  RetentionResult,
  ScheduledRetentionRunnerOptions,
} from "./retention.js";
export { JobQueue, JobQueueError } from "./jobs.js";
export type { JobQueueOptions, JobRecord, JobStatus } from "./jobs.js";
export { buildMatchQuery, extractQueryTokens, searchPassages } from "./retrieval.js";
export type { PassageHit } from "./retrieval.js";
export {
  backfillPassageEmbeddings,
  blobToVector,
  cosineSimilarity,
  hybridSearch,
  MAX_EMBEDDING_CANDIDATES,
  rrfFuse,
  searchByEmbedding,
  storePassageEmbeddings,
  vectorToBlob,
} from "./embeddings.js";
export type { TextEmbedder, VectorHit } from "./embeddings.js";
export { createFastEmbedEmbedder, EMBEDDING_MODEL_ID } from "./fastembed-embedder.js";
export {
  BackupError,
  assertLocalLibsqlUrl,
  backupToFile,
  openRestore,
  verifyRestore,
} from "./backup.js";
