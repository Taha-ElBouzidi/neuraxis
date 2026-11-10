import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
async function load() {
    if (workerData && workerData.module)
        return (await import(pathToFileURL(workerData.module).href)).load();
    const { pipeline, env } = await import('@xenova/transformers');
    env.allowLocalModels = false;
    return pipeline('feature-extraction', workerData.model);
}
try {
    const embed = await load();
    parentPort.on('message', async ({ id, text, opts }) => {
        try {
            const o = await embed(text, opts);
            const data = Float32Array.from(o.data);
            parentPort.postMessage({ id, data }, [data.buffer]);
        }
        catch (e) {
            parentPort.postMessage({ id, error: String((e && e.message) || e) });
        }
    });
    parentPort.postMessage({ ready: true });
}
catch (e) {
    parentPort.postMessage({ loadError: String((e && e.message) || e) });
}
