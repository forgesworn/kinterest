# Kinterest — working notes

- Money is integers in minor units, always. No floats near money, ever.
- Domain code is pure (no I/O, no Date.now()); time is a parameter.
- British English. Tests beside sources. Conventional commits.
- Canonical time units: entries/audits/ticks carry unix SECONDS; `newId` takes milliseconds. Label any new time field.
- Relay marker tag is `kin-jar`.
- Internal specs and plans live in the private suite repo, not here.
