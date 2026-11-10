const STOP = new Set(('the a an and or but if then than that this these those of in on at to for with from by as is '
    + 'are was were be been being it its his her their our your my me you he she they we i do does '
    + 'did done have has had will would can could should shall may might must not no yes so such '
    + 'about into over under out up down off again once here there when where why how all any both '
    + 'each few more most other some only own same too very just also now new old get got make made '
    + 'use used using need needs want wants like likes see saw know known think thought take took go '
    + 'going come came what which who whom whose while during before after above below between '
    + 'through against because until unless upon per via etc am pm ok okay yeah yes dont doesnt isnt '
    + 'wasnt cant wont im ive id ill youre theyre thats whats lets us them him one two three '
    + 'btw fyi pls plz asap anyway anyways basically actually literally really quite rather maybe '
    + 'perhaps please thanks thank hey hi hello yo lol haha oh ah um uh hmm well right sure fine '
    + 'let lets gonna wanna gotta stuff thing things something anything nothing everything').split(/\s+/));
function stem(w) {
    if (w.length <= 3)
        return w;
    for (const [suf, min] of [['ations', 6], ['ation', 5], ['ings', 5], ['edly', 5], ['ing', 4],
        ['ies', 4], ['ied', 4], ['ers', 4], ['er', 4], ['ed', 4], ['ly', 4], ['es', 4], ['s', 3]]) {
        if (w.length > min && w.endsWith(suf)) {
            let base = w.slice(0, -suf.length);
            if (base.length > 2 && /([bdfglmnprt])\1$/.test(base))
                base = base.slice(0, -1);
            return base;
        }
    }
    return w;
}
export function terms(s) {
    const out = new Set();
    for (const raw of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length < 2 || STOP.has(raw))
            continue;
        if (/^\d+$/.test(raw))
            continue;
        out.add(raw);
        const st = stem(raw);
        if (st !== raw && st.length >= 2 && !STOP.has(st))
            out.add(st);
    }
    return [...out];
}
