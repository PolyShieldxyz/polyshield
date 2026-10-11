// Emit the pipeline's adapter text (packages/circuits/pipeline/src/lib/adapter.ts) for (name, nPublic).
// Node >= 22.6 strips TypeScript types natively.
import path from "path";
const adapterPath = path.resolve(process.argv[2]);
const { buildAdapter } = await import(adapterPath);
process.stdout.write(buildAdapter(process.argv[3], Number(process.argv[4])));
