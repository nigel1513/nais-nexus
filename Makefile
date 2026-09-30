# Thin wrapper; scripts/nais is the source of truth (D-033).
.PHONY: up down logs migrate seed storage-init credentials test lint typecheck contracts contracts-check contract-test gate-a
up down logs migrate seed storage-init credentials test lint typecheck contracts contracts-check contract-test gate-a:
	@./scripts/nais $@
