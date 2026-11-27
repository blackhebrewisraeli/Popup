import { createFileRoute } from '@tanstack/react-router';
import { AccountPanel } from '@/components/AccountPanel';

export const Route = createFileRoute('/_workspace/account')({
  component: AccountPanel,
  head: () => ({
    meta: [
      { title: 'Spot journal — Popup' },
      {
        name: 'description',
        content: 'Review Binance Spot executions and recorded entry and no-entry decisions.',
      },
    ],
  }),
});
