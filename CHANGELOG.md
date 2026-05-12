# Changelog

All notable changes to Red Key. Most recent first.

## 2026-05-12

### Fixed
- **Quit Match no longer resurrects the player.** The client previously sent
  a `match-end` message the server didn't recognize, so the server kept the
  match alive and re-attached the player on the next reconnect. The client
  now sends `match-quit` and waits for the server's authoritative `match-end`
  before tearing down local state.
- **Clash "Tap to continue" recovers from a dropped dismiss.** Removed a
  one-shot debounce flag that prevented re-sending if the first
  `clash-dismiss` was lost in transit. Repeat dismisses are idempotent on
  the server.
- **Resume into a match cleans up stale clash UI.** `applyMatchStart` now
  cancels any pending QTE animation frame, clears clash timers, drops the
  cached `clash` object, and hides the overlay. The `clash-dismiss` handler
  also tears down the overlay even when local `clash` is already null.

## 2026-05-11

### Added
- **Initial deployment of the Red Key game server.** Authoritative Node.js
  WebSocket server that runs the simulation and serves the HTML client over
  the same port. Set up for deployment on Render's free tier.
- **Quit Match button.** Visible only during an active multiplayer match.
  Asks for confirmation, then forfeits.
- **Supabase-backed accounts.** Replaced browser-local storage with a
  Supabase Postgres `profiles` table behind Supabase Auth. Username +
  password registration is unchanged from the player's perspective, but
  accounts now persist across browsers and devices. Email confirmation is
  auto-handled by a database trigger so synthetic emails work without an
  inbox. Row-Level Security restricts each user to their own row.

### Changed
- **Match persistence rules.** During an active match the main menu is no
  longer reachable — Quit Match is the only exit. Logging in on a second
  tab transfers the live match into the new session automatically; the old
  tab is told its session moved. Disconnects no longer end matches; a
  match only ends on win or quit.
- **Turn timer is now visible.** The existing 60-second countdown was
  rendered at 11px in dim type. Bumped to 24px italic with a "Time Left"
  label inside the scoreboard's Turn cell. Pulses red under 10 seconds.

### Fixed
- **Lock-In stuck after turn 1.** A guard flag (`mpMyAimsLocked`) was set
  when submitting moves and never cleared on turn end, so subsequent locks
  were silently rejected by the client. Cleared on `turn-end` and
  `kickoff`.
- **Resume-safe match restart.** On a mid-match reconnect, `applyMatchStart`
  was leaving stale `animating` and lock-in flags in place. The server now
  reports its true `animating` state and whether each side has locked in;
  the client reconstructs UI from those values.

---

Going forward, every update gets an entry above. Group by date, with
`Added` / `Changed` / `Fixed` subsections in that order. Keep entries
short — one or two sentences each — and lead with the user-visible change,
not the implementation detail.
