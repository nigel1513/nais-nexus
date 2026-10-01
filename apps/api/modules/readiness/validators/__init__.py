"""One file per check (M05 §2). Each exposes check(ctx) -> CheckOutcome and must stay deterministic:
no clock, no randomness, no network, no environment reads (M05-AT-14 enforces this).
The VALIDATORS registry is added once all nine checks exist (Task 10)."""
