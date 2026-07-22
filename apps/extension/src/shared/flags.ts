/**
 * Feature flags (auto-test-mode-spec §12). `autoTestMode` gates the Auto tab
 * and stays OFF in the store build until M5 acceptance passes (design.md
 * Migration Plan); dev and E2E builds have it ON. The store pipeline opts out
 * by setting VITE_STORE_BUILD=1 at build time.
 */
export const AUTO_TEST_MODE: boolean = import.meta.env?.VITE_STORE_BUILD !== '1';
