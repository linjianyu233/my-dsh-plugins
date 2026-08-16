export const Config: import("@deepseek-ai/schemastery").Schema<{ sessionId: string }>;
export function apply(ctx: unknown, config: { sessionId: string }): void;
export const inject: string[];
export const name: string;
export const internals: {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
};
export function summarize(events: unknown[], firstSeq: number): string;
