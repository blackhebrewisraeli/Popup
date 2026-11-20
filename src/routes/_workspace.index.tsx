import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_workspace/')({
  head: () => ({
    meta: [
      { title: 'Popup — Signals worth opening' },
      {
        name: 'description',
        content:
          'Research opens on a dated shortlist of liquid Binance Spot pairs, ranked by volume rather than score. The model scan explains each asset’s score and the setup conditions it meets or misses.',
      },
      { property: 'og:title', content: 'Popup — Signals worth opening' },
      {
        property: 'og:description',
        content: 'A market scanner that explains every result.',
      },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  }),
});
