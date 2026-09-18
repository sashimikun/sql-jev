/**
 * Guards the published landing page. A scripted edit once deleted a contiguous block of CSS
 * (.btn, .link, .pill, .copy, .code-wrap) and no test noticed, because nothing tested the page.
 * These checks are cheap and catch exactly the damage a slicing edit does.
 */

import { expect, test } from 'bun:test';

const html = await Bun.file(new URL('../site/index.html', import.meta.url)).text();

const REQUIRED_SELECTORS = [
  '.wrap{', '.cell{', '.read{', '.rule{', '.label{',
  '.btn{', '.btn--accent{', '.btn--ghost{', '.btn--sm{', '.btn--pill{', '.btn .arrow{',
  '.link{', '.pill{', '.copy{', '.code-wrap{',
  '.announce{', 'nav.nav{', '.nav__item{', '.nav__burger{',
  '.hero{', '.hero-heading-cell{', '.hero-body-cell{', '.hero-media{', '.hero-trust{',
  '.strip{', '.marquee{', '.stat{', '.panel{', '.panel__tabs{', '.panel__grid{', '.panel__foot{',
  '.cards{', '.card{', '.asks{', '.ask{', 'table{', 'th,td{', 'ul.facts{', '.cta{', 'footer{',
  '.iso-draw{', '.iso-step{',
  '@media (max-width:1279px)', '@media (max-width:1200px)', '@media (max-width:1024px)',
  '@media (max-width:540px)', '@media (prefers-reduced-motion',
];

test('the stylesheet keeps every selector the page depends on', () => {
  const missing = REQUIRED_SELECTORS.filter((selector) => !html.includes(selector));
  expect(missing).toEqual([]);
});

test('braces balance, so no rule silently swallows the rest of the sheet', () => {
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const open = (style.match(/\{/g) ?? []).length;
  const close = (style.match(/\}/g) ?? []).length;
  expect(open).toBe(close);
  expect(open).toBeGreaterThan(200);
});

test('the illustration palette stays the reference five plus the accent', () => {
  const svgs = [...html.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((match) => match[0]);
  expect(svgs.length).toBeGreaterThanOrEqual(5);
  const allowed = new Set(['#f5f3f2', '#eeecea', '#e0dedb', '#87f700', '#79e000', '#6fce00', '#7f806f', '#1c1c1c']);
  for (const svg of svgs) {
    for (const colour of svg.match(/#[0-9a-f]{6}/gi) ?? []) {
      expect(allowed.has(colour.toLowerCase())).toBe(true);
    }
    expect(svg).not.toMatch(/gradient|filter=|url\(#[^)]*\)>/i);
  }
});

test('the page makes no third-party request at runtime', () => {
  const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)]
    .map((match) => match[1] as string)
    .filter(
      (url) =>
        !url.startsWith('https://github.com/') &&
        !url.startsWith('https://console.typesafe.ai') &&
        !url.startsWith('https://developers.cloudflare.com/') &&
        !url.startsWith('https://bun.sh') &&
        !url.startsWith('https://nodejs.org'),
    );
  expect(external).toEqual([]);
  expect(html).not.toMatch(/<script[^>]+src=/);
  expect(html).toContain('fonts/SpaceGrotesk.woff2');
  expect(html).toContain('fonts/JetBrainsMono.woff2');
});

test('the hero keeps the reference grid at desktop and collapses below 1279px', () => {
  expect(html).toContain('grid-template-columns:minmax(48rem,1fr) 12rem 1fr');
  const collapse = html.slice(html.indexOf('@media (max-width:1279px)'));
  expect(collapse).toContain('.hero{grid-template-columns:1fr');
  expect(collapse).toContain('.hero-media{display:none}');
});
