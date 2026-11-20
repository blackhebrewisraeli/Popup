import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_workspace/paper-trading')({
  head: () => ({
    meta: [
      { title: 'Simulation history — Popup' },
      {
        name: 'description',
        content:
          'Paper Desk and Build Portfolio are paused. Read and export earlier simulated records; nothing here places, changes or resets a trade.',
      },
    ],
  }),
});
