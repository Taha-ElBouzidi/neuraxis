import test from 'node:test';
import assert from 'node:assert/strict';
import { frontPageItems, declaredRemovals, undeclaredRemovals } from './front-page-check.mjs';
const OLD = [
    '<h1 align="center">Neuraxis</h1>',
    '<p align="center"><img src="docs/img/neuraxis-map.gif" width="900"></p>',
    '## What you get',
    '![diagram](docs/img/how-it-works.svg)',
    'See [the guide](docs/GUIDE.md).',
].join('\n');
test('reads headings, images and links from markdown and HTML', () => {
    const items = frontPageItems(OLD);
    for (const i of ['heading: Neuraxis', 'heading: What you get', 'image: docs/img/neuraxis-map.gif',
        'image: docs/img/how-it-works.svg', 'link: docs/GUIDE.md'])
        assert.ok(items.has(i), i);
    assert.ok(!items.has('link: docs/img/how-it-works.svg'), 'an image is not also a link');
});
test('the 0.4.114 case: the map and the diagram dropped with nothing said', () => {
    const NEW = '<h1 align="center">Neuraxis</h1>\n## What you get\nSee [the guide](docs/GUIDE.md).\n';
    const cl = '# Changelog\n\n## 0.4.114\n\n- Agent messages built in.\n\n## 0.4.108\n\n- Removed from the front page: docs/img/neuraxis-map.gif\n';
    assert.deepEqual(undeclaredRemovals(OLD, NEW, cl, '0.4.114').sort(), ['image: docs/img/how-it-works.svg', 'image: docs/img/neuraxis-map.gif']);
});
test('a removal named in this version passes, an older version does not count', () => {
    const NEW = '<h1 align="center">Neuraxis</h1>\n## What you get\n![diagram](docs/img/how-it-works.svg)\nSee [the guide](docs/GUIDE.md).\n';
    const cl = '## 0.4.115\n\n- **Removed from the front page:** the moving map\n  (docs/img/neuraxis-map.gif), replaced by a still picture.\n\n## 0.4.108\n';
    assert.match(declaredRemovals(cl, '0.4.115'), /neuraxis-map\.gif/);
    assert.deepEqual(undeclaredRemovals(OLD, NEW, cl, '0.4.115'), []);
    assert.deepEqual(undeclaredRemovals(OLD, NEW, cl, '0.4.116'), ['image: docs/img/neuraxis-map.gif']);
});
test('adding content never holds', () => {
    assert.deepEqual(undeclaredRemovals(OLD, OLD + '\n## New section\n', '', '0.4.115'), []);
});
test('a name wrapped over two changelog lines still counts', () => {
    const NEW = '<h1 align="center">Neuraxis</h1>\n![diagram](docs/img/how-it-works.svg)\n<img src="docs/img/neuraxis-map.gif">\nSee [the guide](docs/GUIDE.md).\n';
    const cl = '## 0.4.115\n\n- **Removed from the front page:** headings: What\n  you get.\n';
    assert.deepEqual(undeclaredRemovals(OLD, NEW, cl, '0.4.115'), []);
});
