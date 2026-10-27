/** Shared env fixture for the composed-app entrypoint tests (plan 005-007, OPS-05). */
export const BASE_ENV: Record<string, string> = {
  DO_SIFT_OWNERS: "owner-a",
  DO_SIFT_SEARCH_PROVIDER: "fixture",
};
