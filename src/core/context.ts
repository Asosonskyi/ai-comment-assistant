import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Product } from "../config/productSchema";
import type { Store } from "../store/Store";
import type { Registry } from "./registry";

export type Logger = Pick<FastifyBaseLogger, "debug" | "info" | "warn" | "error">;

// Shared dependencies handed to every pipeline module.
export interface AppContext {
  store: Store;
  registry: Registry;
  products: Map<string, Product>;
  log: Logger;
}

export function newId(): string {
  return randomBytes(6).toString("base64url");
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
