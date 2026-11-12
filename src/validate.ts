import { CATALOG } from "./catalog.js";
import { RouterError, type RouteOptions, type SandboxSpec, type Strategy } from "./types.js";

/** Every key a SandboxSpec can have. Anything else in a request is a mistake (e.g. "memory" for "memoryGb"). */
export const SPEC_KEYS = ["vcpu", "memoryGb", "gpu", "env", "timeoutMinutes", "image", "metadata"] as const;
/** Every key RouteOptions can have. */
export const ROUTE_KEYS = ["provider", "strategy", "fallback", "require", "createTimeoutSeconds", "deadlineSeconds"] as const;
export const STRATEGIES: readonly Strategy[] = ["default", "balanced", "verified", "cheapest", "fastest"];

const bad = (msg: string) => new RouterError(msg, [], "bad_request");
const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
/** How a bad value is shown: numbers as-is (NaN, Infinity), anything else as JSON. */
const show = (v: unknown) => (typeof v === "number" ? String(v) : JSON.stringify(v));
const stringMap = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

/**
 * Throws RouterError("bad_request") for a spec or route a provider couldn't make sense of: sizes and
 * times that aren't positive numbers, an unknown strategy or fallback, maps that aren't string maps.
 * Called by `plan()`, so every create, route and CLI command goes through it.
 */
export function validate(spec: SandboxSpec = {}, route: RouteOptions = {}): void {
  for (const k of ["vcpu", "memoryGb", "timeoutMinutes"] as const) {
    if (spec[k] !== undefined && !positive(spec[k])) throw bad(`${k} must be a positive number, got ${show(spec[k])}`);
  }
  if (spec.gpu !== undefined && (typeof spec.gpu !== "string" || !spec.gpu)) throw bad(`gpu must be a GPU type such as "T4", got ${JSON.stringify(spec.gpu)}`);
  for (const k of ["env", "image", "metadata"] as const) {
    if (spec[k] !== undefined && !stringMap(spec[k])) throw bad(`${k} must be an object of strings`);
  }
  if (route.strategy !== undefined && !STRATEGIES.includes(route.strategy)) {
    throw bad(`unknown strategy ${JSON.stringify(route.strategy)}: use one of ${STRATEGIES.filter((s) => s !== "default").join(", ")}`);
  }
  if (route.fallback !== undefined && route.fallback !== true && route.fallback !== false && route.fallback !== "any") {
    throw bad(`fallback must be true, false or "any", got ${JSON.stringify(route.fallback)}`);
  }
  for (const k of ["createTimeoutSeconds", "deadlineSeconds"] as const) {
    if (route[k] !== undefined && !positive(route[k])) throw bad(`${k} must be a positive number, got ${show(route[k])}`);
  }
  if (route.require !== undefined && (!Array.isArray(route.require) || !route.require.every((r) => typeof r === "string"))) {
    throw bad("require must be a list of capabilities, e.g. [\"pause\"]");
  }
  if (route.provider !== undefined) {
    const ids = ([] as unknown[]).concat(route.provider);
    const unknown = ids.filter((id) => typeof id !== "string" || !CATALOG.some((c) => c.id === id));
    if (unknown.length || ids.length === 0) throw bad(`unknown provider: ${unknown.map((u) => JSON.stringify(u)).join(", ") || "(empty list)"}`);
  }
}

/** Split a flat request body into spec and route options, refusing keys that are neither. */
export function splitRequest(body: Record<string, unknown>): { spec: SandboxSpec; route: RouteOptions } {
  const spec: Record<string, unknown> = {};
  const route: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(body ?? {})) {
    if ((ROUTE_KEYS as readonly string[]).includes(k)) route[k] = v;
    else if ((SPEC_KEYS as readonly string[]).includes(k)) spec[k] = v;
    else unknown.push(k);
  }
  if (unknown.length) throw bad(`unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}: a sandbox takes ${SPEC_KEYS.join(", ")}; routing takes ${ROUTE_KEYS.join(", ")}`);
  validate(spec as SandboxSpec, route as RouteOptions);
  return { spec: spec as SandboxSpec, route: route as RouteOptions };
}
