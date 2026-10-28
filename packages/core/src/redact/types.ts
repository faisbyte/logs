export type PlaceholderType = 'aws_key';

export type RedactionCounts = Partial<Record<PlaceholderType, number>>;

export interface Span {
  start: number;
  end: number;
  type: PlaceholderType;
}

export interface Detector {
  type: PlaceholderType;
  find(text: string): Omit<Span, 'type'>[];
}

export const placeholder = (type: PlaceholderType) => `[REDACTED:${type}]`;
