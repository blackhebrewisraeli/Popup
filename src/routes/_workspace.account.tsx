import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_workspace/account')({
  head: () => ({
    meta: [
      { title: 'Account — Popup' },
      {
        name: 'description',
        content: 'Subscription, TradingView webhook keys, data export and tracked holdings.',
      },
    ],
  }),
});
