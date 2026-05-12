export type AuditEntryKind = 'user_prompt' | 'thinking' | 'text' | 'tool_use' | 'system';

export interface UserPromptContent {
  text: string;
}

export interface ThinkingContent {
  text: string;
}

export interface TextContent {
  text: string;
}

export interface ToolUseContent {
  tool_name: string;
  input: Record<string, unknown>;
  result?: unknown;
  is_error?: boolean;
  touched_paths?: string[];
  touched_symbols?: string[];
}

export interface SystemContent {
  text: string;
  compactMetadata?: Record<string, unknown>;
}

// T1/D6: discriminated union over `kind` so consumers can switch without
// `(c as any)` casts. AuditEntry stays loose at `Record<string, unknown>`
// for back-compat with existing call sites; getContent<T>() is the
// type-safe narrowing helper.
export type AuditEntryContent =
  | UserPromptContent
  | ThinkingContent
  | TextContent
  | ToolUseContent
  | SystemContent;

export interface AuditEntry {
  id: string;
  session_id: string;
  project_id: string;
  conversation_id: string;
  turn_id: string;
  timestamp: string;
  kind: AuditEntryKind;
  subtype?: string;
  content: Record<string, unknown>;
  raw_event?: Record<string, unknown>;
}

export function asToolUse(c: Record<string, unknown>): ToolUseContent {
  return c as unknown as ToolUseContent;
}

export function asText(c: Record<string, unknown>): TextContent {
  return c as unknown as TextContent;
}

