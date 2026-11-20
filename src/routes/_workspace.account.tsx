import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_workspace/account')({
  head: () => ({
    meta: [
      { title: 'Account — Popup' },
      {
        name: 'description',
        content:
          'Manual Spot experiments, tracked holdings, data export and TradingView webhook keys.',
      },
    ],
  }),
});
