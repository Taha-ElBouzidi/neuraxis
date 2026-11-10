// One embedding in a child process, to learn whether the embedding model can run on this machine at all
// (tools/embed-guard.mjs starts it). On a CPU without AVX (2026-11-09) onnxruntime-node dies with an
// illegal instruction (exit 3221225501, 0xC000001D), and a native crash on a worker thread would end the whole brain
// server; in a child it ends only the child. Prints "ok" and exits 0 when an embedding came back.
// Usage: node tools/embed-probe.mjs <model> [module]
import { pathToFileURL } from 'node:url';

const [model, module] = process.argv.slice(2);
try {
  let embed;
  if (module) embed = await (await import(pathToFileURL(module).href)).load();
  else {
    const { pipeline, env } = await import('@xenova/transformers');
    env.allowLocalModels = false;
    embed = await pipeline('feature-extraction', model);
  }
  const o = await embed('embedding probe', { pooling: 'mean', normalize: true });
  if (!o || !o.data || !o.data.length) throw new Error('the embedding came back empty');
  process.stdout.write('ok\n');
  process.exit(0);
} catch (e) {
  process.stderr.write(String((e && e.message) || e).slice(0, 300) + '\n');
  process.exit(2);
}
