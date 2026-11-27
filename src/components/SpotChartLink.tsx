export function SpotChartLink({ symbol }: Readonly<{ symbol: string }>) {
  const query = new URLSearchParams({ symbol: `BINANCE:${symbol}`, interval: '15' });

  return (
    <a
      className="portfolio-cash-btn"
      href={`https://www.tradingview.com/chart/?${query}`}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${symbol} intraday chart on TradingView (new tab)`}
    >
      Open chart
    </a>
  );
}
