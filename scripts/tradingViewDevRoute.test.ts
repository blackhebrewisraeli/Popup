// @vitest-environment node

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  TRADINGVIEW_DEV_SCAN_FILE,
  TRADINGVIEW_DEV_SCAN_ROUTE,
  TRADINGVIEW_SAVED_SCANS_ROUTE,
} from '@/lib/tradingViewDevScan';
import {
  isLoopback,
  isLoopbackHost,
  serveDevScan,
  serveSavedScans,
  tradingViewDevScanPlugin,
  type SavedScans,
} from './tradingViewDevRoute';

const LOOPBACK = new Set(['127.0.0.1', '::1']);
const LOCAL = { remote: '127.0.0.1', host: 'localhost:8080' };
const ID = '20261107T170244Z-76cde900';

describe('isLoopback', () => {
  it('accepts this machine, including an IPv4 peer on a dual-stack listener, and nothing else', () => {
    expect(isLoopback('127.0.0.1', LOOPBACK)).toBe(true);
    expect(isLoopback('::1', LOOPBACK)).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1', LOOPBACK)).toBe(true);
    expect(isLoopback('10.100.102.6', LOOPBACK)).toBe(false);
    expect(isLoopback('::ffff:10.100.102.6', LOOPBACK)).toBe(false);
    expect(isLoopback(undefined, LOOPBACK)).toBe(false);
  });

  it('reads the loopback addresses from the interface table', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
  });
});

describe('isLoopbackHost', () => {
  it('accepts a page that asked for this machine by a loopback name, and refuses a rebound one', () => {
    for (const host of [
      'localhost:8080',
      '127.0.0.1:8080',
      '[::1]:8080',
      'app.localhost',
      'localhost',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of [
      'evil.example:8080',
      'localhost.evil.example',
      '10.100.102.6:8080',
      '127.0.0.1.nip.io',
      '',
      undefined,
      'bad host',
    ]) {
      expect(isLoopbackHost(host), String(host)).toBe(false);
    }
  });
});

describe('serveDevScan', () => {
  it('serves the file locally, 404s without one and 403s another machine without reading', async () => {
    const reads: string[] = [];
    const read = async (path: string) => {
      reads.push(path);
      return '{"kind":"tradingview-dev-scan"}';
    };
    expect(await serveDevScan(LOCAL, 'store', read)).toEqual({
      status: 200,
      body: '{"kind":"tradingview-dev-scan"}',
    });
    expect(reads).toEqual([join('store', TRADINGVIEW_DEV_SCAN_FILE)]);
    const missing = async () => Promise.reject(new Error('ENOENT'));
    expect(await serveDevScan(LOCAL, 'store', missing)).toEqual({ status: 404 });
    expect(await serveDevScan({ ...LOCAL, remote: '10.100.102.6' }, 'store', read)).toEqual({
      status: 403,
    });
    expect(await serveDevScan({ ...LOCAL, host: 'evil.example:8080' }, 'store', read)).toEqual({
      status: 403,
    });
    expect(reads).toHaveLength(1);
  });
});

describe('serveSavedScans', () => {
  function saved(read: Awaited<ReturnType<SavedScans['readSavedScan']>> = null) {
    const module: SavedScans = {
      listSavedScans: vi.fn(async () => ({ scans: [], unreadable: 0 })),
      readSavedScan: vi.fn(async () => read),
    };
    return { module, load: vi.fn(async () => module) };
  }

  it('lists at the route itself and reads one scan by its ID', async () => {
    const { module, load } = saved({ state: 'MALFORMED', scanId: ID, reason: 'labeled fixture' });
    expect(await serveSavedScans(LOCAL, '/', 'store', load)).toEqual({
      status: 200,
      body: '{"scans":[],"unreadable":0}',
    });
    expect(await serveSavedScans(LOCAL, '/?t=1', 'store', load)).toMatchObject({ status: 200 });
    expect(module.listSavedScans).toHaveBeenCalledWith('store');
    expect(await serveSavedScans(LOCAL, `/${ID}`, 'store', load)).toEqual({
      status: 200,
      body: JSON.stringify({ state: 'MALFORMED', scanId: ID, reason: 'labeled fixture' }),
    });
    expect(module.readSavedScan).toHaveBeenCalledWith('store', ID);
  });

  it('404s a scan the store does not hold, and 500s a failure without its detail', async () => {
    expect(await serveSavedScans(LOCAL, `/${ID}`, 'store', saved().load)).toEqual({
      status: 404,
    });
    const broken = vi.fn(async () => Promise.reject(new Error('/private/path EACCES')));
    expect(await serveSavedScans(LOCAL, '/', 'store', broken)).toEqual({ status: 500 });
  });

  it.each([
    '/../tradingview-dev-scan.json',
    '/..%2F..%2Fetc%2Fpasswd',
    '/%2e%2e%2f%2e%2e%2f.env',
    `/${ID}.json`,
    `/${ID}/`,
    `/${ID}/x`,
    `/${ID.toUpperCase()}`,
    '/20261107T170244Z-76cde90',
    `/x${ID}`,
    '/.json',
    '//etc/passwd',
    '/tradingview-dev-scan.20261107T170244Z-76cde900.d88efcb69451',
  ])('refuses %s as not a scan ID, before loading or reading anything', async (url) => {
    const { module, load } = saved();
    expect(await serveSavedScans(LOCAL, url, 'store', load)).toEqual({ status: 400 });
    expect(load).not.toHaveBeenCalled();
    expect(module.readSavedScan).not.toHaveBeenCalled();
  });

  it.each([
    { remote: '10.100.102.6', host: 'localhost:8080' },
    { remote: '::ffff:192.168.1.20', host: '192.168.1.20:8080' },
    { remote: undefined, host: 'localhost:8080' },
    { remote: '127.0.0.1', host: 'rebound.example:8080' },
    { remote: '127.0.0.1', host: undefined },
  ])('refuses a request from $remote for host $host', async (request) => {
    const { load } = saved();
    for (const url of ['/', `/${ID}`]) {
      expect(await serveSavedScans(request, url, 'store', load)).toEqual({ status: 403 });
    }
    expect(load).not.toHaveBeenCalled();
  });
});

describe('tradingViewDevScanPlugin', () => {
  type Handler = (
    req: { url?: string; headers: { host?: string }; socket: { remoteAddress?: string } },
    res: Response & { headers: Record<string, string> },
  ) => void;
  interface Response {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  }

  function configure(plugin: ReturnType<typeof tradingViewDevScanPlugin>, load: () => unknown) {
    const routes = new Map<string, Handler>();
    const ssrLoadModule = vi.fn(async (path: string) => load() ?? path);
    const configureServer = plugin.configureServer as (server: unknown) => void;
    configureServer({
      middlewares: { use: (route: string, handler: Handler) => routes.set(route, handler) },
      ssrLoadModule,
    });
    expect([...routes.keys()]).toEqual([TRADINGVIEW_DEV_SCAN_ROUTE, TRADINGVIEW_SAVED_SCANS_ROUTE]);
    const request = (route: string, remote: string, url = '/', host = 'localhost:8080') =>
      new Promise<{ status: number; headers: Record<string, string>; body: string | undefined }>(
        (done) => {
          const res = {
            statusCode: 0,
            headers: {} as Record<string, string>,
            setHeader(name: string, value: string) {
              this.headers[name] = value;
            },
            end(body?: string) {
              done({ status: this.statusCode, headers: this.headers, body });
            },
          };
          routes.get(route)!({ url, headers: { host }, socket: { remoteAddress: remote } }, res);
        },
      );
    return { request, ssrLoadModule };
  }

  it('exists only on the dev server and answers from the store', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-route-'));
    const plugin = tradingViewDevScanPlugin(store);
    expect(plugin.apply).toBe('serve');
    const { request } = configure(plugin, () => undefined);
    expect(await request(TRADINGVIEW_DEV_SCAN_ROUTE, '::ffff:127.0.0.1')).toEqual({
      status: 404,
      headers: {},
      body: undefined,
    });
    await writeFile(join(store, TRADINGVIEW_DEV_SCAN_FILE), '{}');
    expect(await request(TRADINGVIEW_DEV_SCAN_ROUTE, '127.0.0.1')).toEqual({
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: '{}',
    });
    expect((await request(TRADINGVIEW_DEV_SCAN_ROUTE, '192.168.1.20')).status).toBe(403);
    const rebound = await request(TRADINGVIEW_DEV_SCAN_ROUTE, '127.0.0.1', '/', 'evil.example');
    expect(rebound.status).toBe(403);
  });

  it('loads the saved-scan module through Vite, and only for a local, valid request', async () => {
    const module: SavedScans = {
      listSavedScans: vi.fn(async () => ({ scans: [], unreadable: 2 })),
      readSavedScan: vi.fn(async () => null),
    };
    const { request, ssrLoadModule } = configure(tradingViewDevScanPlugin('store'), () => module);
    expect(await request(TRADINGVIEW_SAVED_SCANS_ROUTE, '192.168.1.20')).toMatchObject({
      status: 403,
    });
    expect(await request(TRADINGVIEW_SAVED_SCANS_ROUTE, '127.0.0.1', '/../x')).toMatchObject({
      status: 400,
    });
    expect(ssrLoadModule).not.toHaveBeenCalled();
    expect(await request(TRADINGVIEW_SAVED_SCANS_ROUTE, '::1')).toEqual({
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: '{"scans":[],"unreadable":2}',
    });
    expect(await request(TRADINGVIEW_SAVED_SCANS_ROUTE, '::1', `/${ID}`)).toMatchObject({
      status: 404,
    });
    expect(ssrLoadModule).toHaveBeenCalledWith('/scripts/tradingViewSavedScans.ts');
    expect(module.readSavedScan).toHaveBeenCalledWith('store', ID);
  });
});
