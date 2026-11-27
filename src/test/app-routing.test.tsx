import { QueryClient } from '@tanstack/react-query';
import { createRouter, rootRouteId } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { Workspace } from '@/components/Workspace';
import { routeTree } from '@/routeTree.gen';

describe('App routing', () => {
  const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

  it('keeps Research and the Spot journal inside the same private workspace', () => {
    expect(router.routesById['/_workspace'].options.component).toBe(Workspace);
    for (const [path, routeId] of [
      ['/', '/_workspace/'],
      ['/account', '/_workspace/account'],
    ]) {
      const [, layout, page] = router.matchRoutes(path!);
      expect(layout?.routeId).toBe('/_workspace');
      expect(page?.routeId).toBe(routeId);
    }
  });

  it('removes the former simulation and public portfolio routes', () => {
    for (const path of ['/paper-trading', '/p/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']) {
      expect(router.matchRoutes(path).at(-1)?.routeId).toBe(rootRouteId);
    }
  });
});
