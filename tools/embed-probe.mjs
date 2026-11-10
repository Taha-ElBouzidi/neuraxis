import { pathToFileURL } from 'node:url';
const [model, module] = process.argv.slice(2);
try {
    let embed;
    if (module)
        embed = await (await import(pathToFileURL(module).href)).load();
    else {
        const { pipeline, env } = await import('@xenova/transformers');
        env.allowLocalModels = false;
        embed = await pipeline('feature-extraction', model);
    }
    const o = await embed('embedding probe', { pooling: 'mean', normalize: true });
    if (!o || !o.data || !o.data.length)
        throw new Error('the embedding came back empty');
    process.stdout.write('ok\n');
    process.exit(0);
}
catch (e) {
    process.stderr.write(String((e && e.message) || e).slice(0, 300) + '\n');
    process.exit(2);
}
