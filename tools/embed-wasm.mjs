import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
export async function load(model = 'Xenova/all-MiniLM-L6-v2') {
    const ort = require('onnxruntime-web');
    const webDir = dirname(require.resolve('onnxruntime-web/package.json'));
    ort.env.wasm.wasmPaths = join(webDir, 'dist') + '/';
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = process.env.HAVOK_EMBED_WASM_SIMD === 'on';
    const { AutoTokenizer, env } = await import('@xenova/transformers');
    env.allowLocalModels = false;
    const tokenizer = await AutoTokenizer.from_pretrained(model);
    const cacheDir = env.cacheDir || join(dirname(require.resolve('@xenova/transformers/package.json')), '.cache');
    const bytes = await readFile(join(cacheDir, ...model.split('/'), 'onnx', 'model_quantized.onnx'));
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    const names = new Set(session.inputNames);
    return async function embed(text) {
        const enc = await tokenizer(String(text), { padding: false, truncation: true });
        const ids = enc.input_ids.data;
        const mask = enc.attention_mask.data;
        const n = ids.length;
        const feeds = {
            input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (v) => BigInt(v)), [1, n]),
            attention_mask: new ort.Tensor('int64', BigInt64Array.from(mask, (v) => BigInt(v)), [1, n]),
        };
        if (names.has('token_type_ids'))
            feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n), [1, n]);
        const out = await session.run(feeds);
        const h = out.last_hidden_state || out[session.outputNames[0]];
        const dim = h.dims[2];
        const v = new Float32Array(dim);
        let m = 0;
        for (let t = 0; t < n; t++) {
            if (!Number(mask[t]))
                continue;
            m++;
            for (let k = 0; k < dim; k++)
                v[k] += h.data[t * dim + k];
        }
        let norm = 0;
        for (let k = 0; k < dim; k++) {
            v[k] /= m || 1;
            norm += v[k] * v[k];
        }
        norm = Math.sqrt(norm) || 1;
        for (let k = 0; k < dim; k++)
            v[k] /= norm;
        return { data: v };
    };
}
