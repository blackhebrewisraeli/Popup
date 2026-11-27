import { createFileRoute } from '@tanstack/react-router';
import { DailyResearch } from '@/components/Workspace';

export const Route = createFileRoute('/_workspace/')({
  component: DailyResearch,
  head: () => ({
    meta: [
      { title: 'Research — Popup' },
      {
        name: 'description',
        content: 'Review daily Binance Spot candidates and inspect scan evidence.',
      },
    ],
  }),
});
