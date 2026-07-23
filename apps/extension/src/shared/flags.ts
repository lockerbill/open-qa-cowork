/**
 * Feature flags (auto-test-mode-spec §12). `autoTestMode` gated the Auto tab
 * during the rollout: OFF in store builds until M5 acceptance passed
 * (design.md Migration Plan). M5 acceptance is green (demo run → defect card
 * → one-click bug report; Playwright draft replays green), so the flag now
 * defaults ON everywhere; VITE_DISABLE_AUTO_TEST_MODE=1 remains as the
 * emergency store-build kill switch (rollback = flag off, no data migration).
 */
export const AUTO_TEST_MODE: boolean = import.meta.env?.VITE_DISABLE_AUTO_TEST_MODE !== '1';
