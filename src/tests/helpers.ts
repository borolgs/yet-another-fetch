import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, vi } from 'vitest';

export const baseUrl = 'https://example.com';

type MockRoute = Parameters<ReturnType<MockAgent['get']>['intercept']>[0];

/**
 * Fresh `MockAgent` per test, net connect disabled. `intercept` returns the interceptor, so
 * `.reply()` / `.replyWithError()` / `.persist()` chain as usual.
 */
export function setupMockAgent() {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();

    setGlobalDispatcher(agent);
    agent.disableNetConnect();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      // An unconsumed interceptor means the client skipped a fetch it was expected to make.
      agent.assertNoPendingInterceptors();
    } finally {
      await agent.close();
    }
  });

  return {
    intercept: (options: MockRoute) => agent.get(baseUrl).intercept(options),
  };
}
