export function watchTailnet({ list, bind, intervalMs = 0 }) {
    const seen = new Set();
    const sweep = () => {
        const bound = [];
        for (const a of list()) {
            if (seen.has(a))
                continue;
            seen.add(a);
            bind(a);
            bound.push(a);
        }
        return bound;
    };
    sweep();
    const timer = intervalMs > 0 ? setInterval(sweep, intervalMs) : null;
    return {
        sweep,
        known: () => [...seen],
        stop() { if (timer)
            clearInterval(timer); },
        forget(a) { seen.delete(a); },
    };
}
