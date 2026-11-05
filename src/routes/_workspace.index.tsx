import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_workspace/')({
  head: () => ({
    meta: [
      { title: 'Popup — Signals worth opening' },
      {
        name: 'description',
        content:
          'Surface explainable market signals, investigate the factors, and test ideas with backtesting and simulated trading.',
      },
      { property: 'og:title', content: 'Popup — Signals worth opening' },
      {
        property: 'og:description',
        content: 'See what matters. Test what follows.',
      },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  }),
});
