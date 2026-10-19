import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGE_HEADERS } from '../../worker/page.js';

const read = (p) => readFileSync(join(import.meta.dirname, '../../public', p), 'utf8');
const HTML = read('index.html');
const HEADERS = read('_headers');
const csp = HEADERS.match(/^\s+Content-Security-Policy:\s*(.+)$/m)[1];
const directive = (name) => csp.split(';').map((d) => d.trim().split(/\s+/)).find(([n]) => n === name)?.slice(1) ?? [];

// 인라인 스크립트를 고치면 해시가 달라져 CSP가 조용히 스크립트를 막으므로, 실제 내용과 맞는지 확인한다
describe('public/_headers', () => {
  it('script-src의 해시가 index.html 인라인 스크립트와 정확히 일치한다 (빠진 것도 남은 것도 없음)', () => {
    const inline = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
      ([, body]) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`,
    );
    expect(inline).toHaveLength(2);
    const hashes = directive('script-src').filter((s) => s.startsWith("'sha256-"));
    expect(new Set(hashes)).toEqual(new Set(inline));
  });

  it('모든 경로에 보안 헤더를 건다', () => {
    expect(HEADERS).toMatch(/^\/\*$/m);
    expect(HEADERS).toMatch(/^\s+X-Content-Type-Options: nosniff$/m);
    expect(HEADERS).toMatch(/^\s+Referrer-Policy: no-referrer$/m);
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
    expect(directive('object-src')).toEqual(["'none'"]);
  });

  // Worker가 직접 내보내는 첫 페이지(/)에는 _headers가 붙지 않아 같은 값을 코드에 두므로, 둘이 어긋나지 않게 한다
  it('Worker가 내보내는 페이지 헤더가 _headers의 /* 규칙과 같다', () => {
    const rule = Object.fromEntries([...HEADERS.matchAll(/^\s+([\w-]+):\s*(.+)$/gm)].map(([, name, value]) => [name, value.trim()]));
    expect(PAGE_HEADERS).toEqual(rule);
  });
});
