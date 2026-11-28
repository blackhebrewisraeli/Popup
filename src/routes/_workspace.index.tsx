import { createFileRoute } from '@tanstack/react-router';
import { Home } from '@/components/Workspace';

export const Route = createFileRoute('/_workspace/')({
  component: Home,
  head: () => ({
    meta: [
      { title: 'Research — Popup' },
      {
        name: 'description',
        content:
          'Check Binance Spot balances and received TradingView alerts, then review daily Binance Spot candidates.',
      },
    ],
  }),
});
