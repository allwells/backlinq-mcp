// Minimal type declarations for bun:sqlite built-in
// Full API: https://bun.sh/docs/api/sqlite

declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string, options?: { readonly?: boolean; create?: boolean });
    exec(sql: string): void;
    prepare<T = Record<string, unknown>>(sql: string): Statement<T>;
    transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
    close(throwOnError?: boolean): void;
  }

  export interface Statement<T = Record<string, unknown>> {
    get(...params: unknown[]): T | null;
    all(...params: unknown[]): T[];
    run(...params: unknown[]): void;
  }
}
