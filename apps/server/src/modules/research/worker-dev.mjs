// Development-only bootstrap: registers the tsx loader inside the worker thread, then loads the
// TypeScript worker. Production runs the compiled dist/modules/research/worker.js directly.
import { register } from "tsx/esm/api";

register();
await import("./worker.ts");
