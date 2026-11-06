import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_workspace/')({
  head: () => ({
    meta: [
      { title: 'Popup — Signals worth opening' },
      {
        name: 'description',
        content:
          'A market scanner that explains every result: each asset’s score, rank, and the setup conditions it meets or misses.',
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
