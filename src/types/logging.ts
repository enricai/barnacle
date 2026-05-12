import type pino from "pino";

export interface Logger extends pino.Logger {
  errorWithStack: (error: unknown, msg?: string) => void;
}
