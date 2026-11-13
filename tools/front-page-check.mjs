const NL = /\r?\n/;
export function frontPageItems(md) {
    const items = new Set();
    const text = String(md || '');
    for (const line of text.split(NL)) {
        const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
        if (h)
            items.add('heading: ' + h[1].trim());
    }
    for (const m of text.matchAll(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>/gi))
        items.add('heading: ' + m[1].trim());
    for (const m of text.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g))
        items.add('image: ' + m[1]);
    for (const m of text.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi))
        items.add('image: ' + m[1]);
    for (const m of text.matchAll(/(?<!!)\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g))
        items.add('link: ' + m[1]);
    for (const m of text.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi))
        items.add('link: ' + m[1]);
    return items;
}
export function declaredRemovals(changelog, version) {
    const lines = String(changelog || '').split(NL);
    const start = lines.findIndex((l) => l.trim() === '## ' + version);
    if (start === -1)
        return '';
    const out = [];
    for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
        const l = lines[i].replace(/^\s*[-*]\s*/, '');
        if (/^\**Removed from the front page:/i.test(l)) {
            out.push(l);
            for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]) && !/^\s*[-*]\s/.test(lines[j]); j++)
                out.push(lines[j]);
        }
    }
    return out.join(' ').replace(/\s+/g, ' ');
}
export function undeclaredRemovals(oldMd, newMd, changelog, version) {
    const before = frontPageItems(oldMd);
    const after = frontPageItems(newMd);
    const declared = declaredRemovals(changelog, version);
    const removed = [...before].filter((i) => !after.has(i));
    return removed.filter((i) => !declared.includes(i.slice(i.indexOf(': ') + 2).replace(/\s+/g, ' ')));
}
