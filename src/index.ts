/**
 * mcpsteward: local-first MCP server inspection and trust toolkit.
 *
 * Public entry point. Subpath exports (`mcpsteward/core`, `mcpsteward/protocol`,
 * `mcpsteward/conformance`, `mcpsteward/ledger`, `mcpsteward/mcp`) expose the
 * individual faculties; this module re-exports the stable surface most consumers
 * need.
 */

export {
  compareRevisions,
  eraOf,
  isKnownRevision,
  isSupportedRevision,
  KNOWN_UNSUPPORTED_REVISIONS,
  requiresInitializeHandshake,
  selectBestRevision,
  SUPPORTED_REVISIONS,
  TARGET_REVISION,
} from './core/revisions.js';

export type { KnownRevision, ProtocolEra, ProtocolRevision } from './core/revisions.js';

export {
  collectEnvSecrets,
  findResidualSecret,
  redact,
  redactDeep,
  redactionFingerprint,
  SECRET_ENV_NAME_PATTERN,
} from './core/redaction.js';

export type { RedactionOptions } from './core/redaction.js';

export {
  AuthenticationRequiredError,
  CancellationError,
  ConfigurationError,
  DiscoveryError,
  ERROR_CODES,
  hasErrorCode,
  InternalError,
  isMcpStewardError,
  LedgerCorruptionError,
  McpStewardError,
  PolicyViolationError,
  ProtocolViolationError,
  TimeoutError,
  toMcpStewardError,
  TransportError,
  UnsupportedRevisionError,
  VersionNegotiationError,
} from './core/errors.js';

export type { ErrorCode, ErrorDetails, McpStewardErrorOptions } from './core/errors.js';

export {
  canonicalizeJsonText,
  canonicalizeJsonValue,
  canonicalizeNumberToken,
  canonicalizeString,
  canonicalizeValue,
  hashCanonicalForm,
  hashJsonText,
  hashValue,
  isContentHash,
} from './core/canonical.js';

export type { ContentHash } from './core/canonical.js';

export { isJsonNumber, jsonNumber, parseJsonPreservingNumbers } from './core/json-parse.js';

export type { JsonNumber, JsonObject, JsonValue } from './core/json-parse.js';

export {
  buildMerkleProof,
  computeSurfaceHashes,
  descriptorKey,
  EMPTY_MERKLE_ROOT,
  merkleLeaf,
  merkleNode,
  merkleRoot,
  verifyMerkleProof,
} from './core/merkle.js';

export type { MerkleProof, MerkleProofStep } from './core/merkle.js';

export {
  buildDescriptor,
  buildDescriptors,
  readDescription,
  readIdentity,
  readInputSchema,
  readRequiredParameters,
  readSchemaProperties,
} from './core/descriptor.js';

export { assertNever, DESCRIPTOR_CATEGORIES, DRIFT_KINDS } from './core/types.js';

export type {
  AuthPosture,
  ConformanceRule,
  Descriptor,
  DescriptorCategory,
  DriftEvent,
  DriftKind,
  DriftReport,
  Finding,
  Grade,
  GradeLetter,
  HttpServerRef,
  LedgerEntry,
  NormativeLevel,
  Policy,
  PolicyViolation,
  PolicyViolationKind,
  RegistrationSite,
  RiskTier,
  RuleCategory,
  RuleConfidence,
  RuleOutcome,
  RuleResult,
  ServerEndpoint,
  ServerRef,
  ServerSurface,
  Severity,
  SpecCitation,
  StdioServerRef,
  SurfaceHashes,
  TransportKind,
  TrustPin,
} from './core/types.js';

export { McpClient, deriveServerId, surfaceRootOf } from './protocol/client.js';

export type {
  CaptureOptions,
  CaptureProgress,
  DiscoverOutcome,
  Transport,
} from './protocol/client.js';

export { StdioTransport } from './protocol/stdio-transport.js';

export type { StdioTransportOptions } from './protocol/stdio-transport.js';

export { HttpTransport, lastSseData } from './protocol/http-transport.js';

export type {
  HttpTransportOptions,
  RawHttpResponse,
  RawRequestOptions,
} from './protocol/http-transport.js';

export { discover, knownClients, projectConfigCandidates } from './discovery/index.js';

export type {
  ClientDefinition,
  ClientId,
  ConfigShape,
  PathConfidence,
  DiscoveryOptions,
  DiscoveryProblem,
  Inventory,
  InventorySummary,
} from './discovery/index.js';

export { allRules, grade, RULES, ruleById } from './conformance/index.js';

export type {
  ConformanceReport,
  RegisteredRule,
  RuleContext,
} from './conformance/index.js';

export type { CaptureEvidence, CaptureResult } from './protocol/client.js';

export { allMigrationPatterns, analyzeMigration, MIGRATION_PATTERNS, patternById } from './migration/index.js';

export type {
  AnalyzeOptions,
  DetectionConfidence,
  MigrationFinding,
  MigrationPattern,
  MigrationReport,
} from './migration/index.js';

export {
  computeEntryHash,
  GENESIS_HASH,
  Ledger,
  LEDGER_FORMAT_VERSION,
  LEDGER_MAGIC,
} from './ledger/index.js';

export type {
  AppendInput,
  LedgerHeader,
  LedgerOptions,
  VerifyResult,
} from './ledger/index.js';

export {
  createPin,
  DEFAULT_RISK_WEIGHTS,
  describeKind,
  diffAgainstPin,
  diffSurfaces,
  highestRisk,
  isUnchanged,
  loadPin,
  savePin,
} from './trust/index.js';

export type { DiffOptions, PinOptions, RiskWeights } from './trust/index.js';

export {
  checkPolicy,
  describeViolationKind,
  exceeds,
  EXIT_CODES,
  exitCodeFor,
  initPolicy,
  isBelow,
  loadPolicy,
  parsePolicy,
  savePolicy,
} from './policy/index.js';

export type {
  ExitCode,
  InitPolicyOptions,
  PolicyInput,
  PolicyResult,
} from './policy/index.js';

export {
  allItems,
  buildReport,
  isClean,
  isReportFormat,
  render,
  REPORT_FORMATS,
} from './report/index.js';

export type {
  BuildReportInput,
  Report,
  ReportFormat,
  ReportItem,
  ReportKind,
  ReportSection,
  RenderOptions,
  SummaryItem,
} from './report/index.js';

export { createLogger, isLogLevel, LOG_LEVELS, NOOP_LOGGER } from './core/logger.js';

export type { Logger, LogLevel, LogRecord, LoggerOptions, LogSink } from './core/logger.js';

export {
  configFromEnv,
  DEFAULT_CONFIG,
  parseConfigFile,
  resolveConfig,
  validateConfig,
} from './core/config.js';

export type {
  ConfigOverrides,
  McpStewardConfig,
  ResolveConfigInput,
} from './core/config.js';
