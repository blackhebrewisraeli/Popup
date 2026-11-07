import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
// Relative, not `@/`: vite.config.ts loads this file before the alias exists.
import {
  SCAN_ID,
  TRADINGVIEW_DEV_SCAN_FILE,
  TRADINGVIEW_DEV_SCAN_ROUTE,
  TRADINGVIEW_SAVED_SCANS_ROUTE,
} from '../src/lib/tradingViewDevScan';

/** This machine's loopback addresses, from its own interface table. */
function loopbackAddresses(): Set<string> {
  return new Set(
    Object.values(networkInterfaces()).flatMap((list) =>
      (list ?? []).filter((address) => address.internal).map((address) => address.address),
    ),
  );
}

/** A dual-stack listener reports IPv4 peers as IPv4-mapped IPv6 addresses, hence the prefix strip. */
export function isLoopback(remote: string | undefined, loopback = loopbackAddresses()): boolean {
  return remote !== undefined && loopback.has(remote.replace(/^::ffff:/, ''));
}

/**
 * The page asked for this machine by a loopback name. These routes run before Vite's own
 * host check, so a page whose name was re-pointed at 127.0.0.1 (DNS rebinding) is refused here.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  let hostname: string;
  try {
    hostname = new URL(`http://${host ?? ''}`).hostname;
  } catch {
    return false;
  }
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.localhost');
}

export interface LocalRequest {
  remote: string | undefined;
  host: string | undefined;
}

const isLocal = ({ remote, host }: LocalRequest) => isLoopback(remote) && isLoopbackHost(host);

type Reply = { status: number; body?: string };

/** One request for the dev scan file: 403 from another machine, 404 when nothing was imported. */
export async function serveDevScan(
  request: LocalRequest,
  store: string,
  read: (path: string, encoding: 'utf8') => Promise<string> = readFile,
): Promise<Reply> {
  // The dev server listens on every interface; fetched market data stays on this machine.
  if (!isLocal(request)) return { status: 403 };
  try {
    return { status: 200, body: await read(join(store, TRADINGVIEW_DEV_SCAN_FILE), 'utf8') };
  } catch {
    return { status: 404 };
  }
}

export type SavedScans = Pick<
  typeof import('./tradingViewSavedScans'),
  'listSavedScans' | 'readSavedScan'
>;

/**
 * The saved-scan routes: `/` lists, `/<scanId>` reads one. Only a scan ID is accepted,
 * never a path, so nothing outside the store's own snapshot names can be requested.
 */
export async function serveSavedScans(
  request: LocalRequest,
  url: string | undefined,
  store: string,
  load: () => Promise<SavedScans>,
): Promise<Reply> {
  if (!isLocal(request)) return { status: 403 };
  const path = (url ?? '/').split('?')[0];
  const scanId = /^\/([^/]+)$/.exec(path ?? '')?.[1];
  if (path !== '/' && !(scanId && SCAN_ID.test(scanId))) return { status: 400 };
  try {
    const saved = await load();
    const body = scanId
      ? await saved.readSavedScan(store, scanId)
      : await saved.listSavedScans(store);
    return body === null ? { status: 404 } : { status: 200, body: JSON.stringify(body) };
  } catch {
    return { status: 500 };
  }
}

function local(req: IncomingMessage): LocalRequest {
  return { remote: req.socket.remoteAddress, host: req.headers.host };
}

function send(res: ServerResponse, { status, body }: Reply) {
  res.statusCode = status;
  if (body !== undefined) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
  }
  res.end(body);
}

/**
 * `vite dev` only (`apply: 'serve'`): hands the local TradingView development
 * scan (src/lib/tradingViewDevScan.ts), and the saved scans beside it, from the
 * git-ignored scan store to a browser on this machine. Production builds have no
 * such route.
 */
export function tradingViewDevScanPlugin(store = '.zerochart-scans'): Plugin {
  return {
    name: 'zerochart-tradingview-dev-scan',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(TRADINGVIEW_DEV_SCAN_ROUTE, (req, res) => {
        void serveDevScan(local(req), store).then((reply) => send(res, reply));
      });
      // Loaded through Vite, which resolves the `@/` imports this file cannot use.
      const load = () =>
        server.ssrLoadModule('/scripts/tradingViewSavedScans.ts') as Promise<SavedScans>;
      server.middlewares.use(TRADINGVIEW_SAVED_SCANS_ROUTE, (req, res) => {
        void serveSavedScans(local(req), req.url, store, load).then((reply) => send(res, reply));
      });
    },
  };
}
