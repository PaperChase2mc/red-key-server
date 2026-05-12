# Changelog

All notable changes to Red Key. Most recent first.

## 2026-05-12

### Fixed
- Quit Match actually ends the match now. Previously, quitting could put you back into the same match a few seconds later.
- The "Tap to continue" prompt after a clash now works reliably. If your first tap didn't register, a second tap will.
- Stale clash screens no longer linger when rejoining a match.

## 2026-05-11

### Added
- Red Key is now live online. Anyone can play by visiting the URL.
- Quit Match button during multiplayer matches. Asks for confirmation before forfeiting.
- Accounts now persist across browsers and devices. Sign in with the same username and password from any browser, phone, or computer and your players, keys, and roster come with you.

### Changed
- During a multiplayer match, the main menu is locked. Quit Match is the only way out.
- Signing in on a second tab puts you straight into your live match instead of blocking the tab. The old tab is told its session moved.
- Disconnects no longer end matches. A match only ends on a win or when someone quits.
- The 60-second turn timer is now large and clearly labeled inside the scoreboard. Pulses red under 10 seconds.

### Fixed
- Locking in moves after the first turn works again. Used to silently fail starting on turn 2.
- Rejoining a match in progress no longer leaves the game stuck in a broken state.

---

Going forward, every update gets an entry above. Group by date, with
Added / Changed / Fixed subsections in that order. Plain English — what
the player sees, not how it was built.
