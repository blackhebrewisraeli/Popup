import { handleDiagnostic } from './handler.ts';

Deno.serve((req) =>
  handleDiagnostic(req, {
    env: (name) => Deno.env.get(name),
    fetch,
    now: () => performance.now(),
  }),
);
