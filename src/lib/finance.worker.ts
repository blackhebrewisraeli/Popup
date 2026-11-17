import { FinanceCache, handleFinanceRequest, type FinanceRequest } from './financeCompute';

interface FinanceWorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as FinanceWorkerScope;
const cache = new FinanceCache();

scope.onmessage = (event: MessageEvent) => {
  const { id, request } = event.data as { id: number; request: FinanceRequest };
  handleFinanceRequest(request, cache).then(
    (value) => scope.postMessage({ id, result: value }),
    (error: unknown) =>
      scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
  );
};
