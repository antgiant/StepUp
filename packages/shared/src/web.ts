/** Browser-safe subset of the shared package (no ExcelJS, no Node-only code). */
export * from "./domain/types.js";
export * from "./domain/money.js";
export * from "./events/types.js";
export * from "./events/hlc.js";
export * from "./events/fold.js";
export * from "./events/store.js";
export * from "./events/ledger.js";
export * from "./rules/readiness.js";
export * from "./rules/budget.js";
export * from "./util/hash.js";
export * from "./util/ids.js";
export * from "./entry/allocate.js";
export * from "./entry/actions.js";
export * from "./entry/queue.js";
export * from "./entry/mapping.js";
export * from "./submit/plan.js";
export * from "./workspace/ingest.js";
