export type NexusErrorCode =
  | "NEXUS_VERSION_MISMATCH"
  | "NEXUS_CONFIG_INVALID"
  | "NEXUS_CONNECTION_FAILED"
  | "NEXUS_UNIQUE_VIOLATION"
  | "NEXUS_FOREIGN_KEY_VIOLATION"
  | "NEXUS_NOT_FOUND"
  | "NEXUS_TIMEOUT"
  | "NEXUS_TX_EXPIRED"
  | "NEXUS_MIGRATION_CONFLICT"
  | "NEXUS_VALIDATION_ERROR"
  | "NEXUS_ENGINE_CRASHED"
  | "NEXUS_INTERNAL_ERROR";

export interface ProtocolErrorDetail {
  code: NexusErrorCode;
  message: string;
  model?: string;
  fields?: string[];
  retryable: boolean;
}

const URL_CRED_REGEX = /([a-zA-Z0-9+.-]+:\/\/[^:/\s]+:)([^@\s]+)(@)/g;
const KV_PASS_REGEX = /(password|passwd|pwd|secret)=([^\s&;]+)/gi;

export function scrubCredentials(input: string): string {
  return input
    .replace(URL_CRED_REGEX, "$1[REDACTED]$3")
    .replace(KV_PASS_REGEX, "$1=[REDACTED]");
}

export class NexusError extends Error {
  public readonly code: NexusErrorCode;
  public readonly model?: string;
  public readonly fields?: string[];
  public readonly retryable: boolean;

  constructor(detail: ProtocolErrorDetail) {
    super(scrubCredentials(detail.message));
    this.name = "NexusError";
    this.code = detail.code;
    this.model = detail.model;
    this.fields = detail.fields;
    this.retryable = detail.retryable;
  }

  static fromProtocol(detail: ProtocolErrorDetail): NexusError {
    return new NexusError(detail);
  }
}
