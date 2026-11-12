# Changelog

## [0.2.4] - 2026-11-12

### Changed

- Re-verified compatibility with Pi 1.5.2 on Node 24.20.0: local and disposable
  lease suites pass, with no runtime code changes.
- Documented project-preset trust decisions and Pi 1.5.1+ idle cache warming.
- Added this changelog to the package payload for Pi's Extension Updates notice.

## [0.2.3] - 2026-11-11

### Changed

- Collapsed the child lifecycle to `active` and `stopped`, with `send` resuming a
  live stopped child.
- Added an eight-entry admission cap and a `remove` action that releases the
  process, transcript and slot.

## [0.2.2] - 2026-11-11

### Changed

- Added preset names to `list`, ten-minute running reminders, and timestamped
  child ids that survive restarts.

## [0.2.1] - 2026-11-10

### Changed

- Coalesced completion notifications at the next message boundary instead of one
  notice per idle transition.

## [0.2.0] - 2026-11-10

### Changed

- Added user-defined Markdown launch presets with `model`, `thinking`, `tools`
  and preset-only `system_append` defaults.
