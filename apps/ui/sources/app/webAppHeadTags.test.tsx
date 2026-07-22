// react-test-renderer 19 returns null from toJSON() in this node env (no act support).
// renderToStaticMarkup produces equivalent HTML; render() parses it to the same Node[] shape.
import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { WebAppHeadTags } from './webAppHeadTags';

type Node = { type?: string; props?: Record<string, any>; children?: any };

function parseNodes(html: string): Node[] {
  const nodes: Node[] = [];
  const tagRe = /<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g;
  const attrRe = /([\w-]+)(?:="([^"]*)")?/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const type = m[1];
    const attrStr = m[2] ?? '';
    const props: Record<string, string> = {};
    let a: RegExpExecArray | null;
    attrRe.lastIndex = 0;
    while ((a = attrRe.exec(attrStr)) !== null) {
      props[a[1]] = a[2] ?? '';
    }
    nodes.push({ type, props });
  }
  return nodes;
}

function render(): Node[] {
  const html = renderToStaticMarkup(<WebAppHeadTags />);
  return parseNodes(html);
}

describe('WebAppHeadTags', () => {
  test('links the web app manifest', () => {
    const nodes = render();
    expect(nodes.some((n) => n.type === 'link' && n.props?.rel === 'manifest' && n.props?.href === '/manifest.webmanifest')).toBe(true);
  });

  test('marks the app as apple-mobile-web-app-capable (iOS standalone)', () => {
    const nodes = render();
    expect(nodes.some((n) => n.type === 'meta' && n.props?.name === 'apple-mobile-web-app-capable' && n.props?.content === 'yes')).toBe(true);
  });

  test('links an apple-touch-icon', () => {
    const nodes = render();
    expect(nodes.some((n) => n.type === 'link' && n.props?.rel === 'apple-touch-icon' && n.props?.href === '/apple-touch-icon.png')).toBe(true);
  });
});
