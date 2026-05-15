# Changelog

All notable changes to Red Key. Most recent first.

## 2026-05-12

### Added
- Account changes are now live. If an admin gifts you keys, sets your tag, or promotes you, your key count, name, tag, and admin button update on your screen immediately — no refresh.
- Skill Builder is now live too. When one admin saves, edits, or deletes an ability, every other admin watching the Skill Builder sees the list update right away. Weapon names on the roster screen also refresh in place.
- Maintenance mode now kicks non-admins live. The instant an admin flips the switch, every connected non-admin player is signed out and shown the offline screen, no refresh required.
- Admins can toggle maintenance mode from the admin panel. When it's on, non-admins who try to log in see an offline screen with the Discord invite link, a Copy Link button, and a Go Back to Login button. Admins are unaffected.

### Changed
- New player drop rates: Common 49.5%, Uncommon 25%, Rare 20%, Epic 5%, Legendary 0.5%. Rares are more common; Legendaries are much rarer.
- Once you lock in for a turn, you can no longer drag players, drag the ball, or change Kick/Dribble mode until the next turn starts. The plan is committed.

### Changed
- WebSocket reconnect delay reduced from 5 seconds to 1.5 seconds. Brief network blips now recover three times faster.

### Changed
- The Skill Builder form is simplified to just Name and Description. The legacy Trigger, Effect, and Magnitude fields are gone — all real behavior lives in the existing Behavior / Zones / Requirements / Rewards sections.
- The Description field is now player-facing: it appears on the player tile of any character that holds the weapon, in a gold-bordered callout below the weapon name. This is what players see when they get a character with the weapon.
- The Test Ability button no longer opens a separate sandbox. It now equips your in-progress ability onto both teams' strikers and drops you straight into a practice match. A local evaluator mirrors the server's ability logic, so abilities fire at the end of each practice turn with the same flash, sound, and cutscene as in a real game. Leaving practice via the menu cleans up automatically — your real player rosters aren't touched.

### Added
- Phase 5 of the Skill Builder: an in-builder sandbox to test your ability before saving it. A new "Test Ability" button in the editor opens a small test pitch with a draggable Owner, Enemy, and Ball. Toggles for "Owner has ball" and "Owner won a clash this turn" let you exercise the on-ball/off-ball gating and the Clash and Win requirement. Player-placed zones use the same chip-to-drop flow as in a real match. Press Fire Turn to see exactly which requirements met, which ones didn't, and which rewards would activate — no live match required.
- Phase 3c of the Skill Builder: player-placed zones. When one of your equipped abilities has a zone set to "Player Places", a chip appears above the field during planning. Tap a chip, then click anywhere on the pitch to drop that zone. The zone shows immediately. On lock-in, your placements travel with your moves and get evaluated like any other zone. Placements reset every turn — you re-drop them each planning phase.
- Phase 3b of the Skill Builder: zone-based abilities now work in matches. Requirements like "enemy in zone" or "ball in zone" check actual positions at the end of every turn. Teleport-to-Zone moves the player to the zone's center. Auto-Clash forces an immediate clash with the enemy in the zone — the QTE overlay pops up and lock-in is blocked until it resolves.
- Active zones render on the pitch as translucent dashed circles in their configured colors. They appear above the field paint and under the players, so they never block clicks.
- Phase 4 of the Skill Builder: per-ability sound effects and cutscenes. The Skill Builder has a new "Media" section to upload one MP3 (max 5 MB) and one MP4 (max 25 MB). When the ability fires, the MP3 plays inline and the MP4 takes over the entire screen with a fade in/out before returning to the match.
- Phase 3a of the Skill Builder: equipped abilities now actually do something during a match. The server evaluates each player's abilities at the end of every turn and fires their rewards when requirements are met. Working in this round: "no requirements" (fires every cooldown) and "Clash and Win" requirement; Stat Boost, Give Ball, and Teleport-to-Ball rewards; per-player per-ability cooldowns; on-ball vs off-ball gating. A toast and a gold flash appear when an ability fires.
- Zone-based requirements and rewards (Teleport-to-Zone, Auto-Clash) are recognized but won't fire yet — those land in Phase 3b along with zone visualization on the pitch.

### Changed
- The "Attack" and "Defend" labels now sit above and below the field instead of floating over the goal areas. They no longer block players or the ball near the goals.

### Added
- Server-side test harness (`npm test`) that spawns the game server, opens two WebSocket clients, and walks them through 17 multiplayer scenarios end-to-end. Catches regressions in the protocol before they reach a real match.

### Fixed
- Dribble/Kick mode selection and Lock In state no longer revert on their own. The game server now keeps WebSocket connections alive with a heartbeat, so cloud load balancers stop killing idle connections during long planning phases. As a safety net, if a connection does drop, the client preserves your mode + lock state on resume and re-sends your aims if the server is missing them.
- Clashes no longer get stuck with one player on the QTE screen and the other staring at the field. If your previous clash didn't fully dismiss (dropped packet, transient hiccup), the new clash now overrides and starts cleanly. If you reconnect mid-clash, the server includes the clash info in the resume so your QTE overlay rebuilds.
- You can no longer lock in twice on the same turn. The Lock In button now stays disabled the moment you commit, no matter what else refreshes the UI.
- Arrows you drew during planning no longer vanish if the connection briefly drops and reconnects. Resuming into the same turn now keeps your in-progress aims intact.

### Added
- Skill Builder editor expanded: each ability can now be marked On-Ball or Off-Ball, given a cooldown in turns, and configured with zones, requirements, and rewards. The list view shows a quick summary of each ability's setup. (These settings save to the database but don't yet affect gameplay — Phase 3 wires them into the simulation.)
- Zones live in a list on the ability. Each zone has a label, fixed-offset coordinates or a "Player Places" mode, a radius, a color picker, and a target type (teammate, enemy, ball, enemy with ball, or self).
- Requirements list lets you require a clash win or that a specific zone's condition is met. You can stack multiple requirements per ability.
- Rewards list supports stat boosts (any amount, can go past 5), give-ball, teleport-to-ball, teleport-to-zone, and auto-clash with the enemy in a zone. Multiple rewards per ability.
- Skill Builder is now its own admin sub-screen. Open it from a button in the admin panel.
- Abilities created in the Skill Builder are saved to the database and shared across all admins. They show up correctly on player cards from any browser or device.
- You can edit existing abilities (click Edit next to one in the list) and delete them. Player references to deleted abilities show as "?" until the player is replaced.
- Rarer players are now actually rarer in their stats. Each rarity has a fixed stat band: common 0-1, uncommon 0-2, rare 1-3, epic 2-4, legendary 3-5. A common can have one star in every stat, but never two in any one stat.
- Weapons only drop on epic and legendary pulls now, at a 25% chance. Lower rarities never roll weapons.
- Players who have a weapon are visually highlighted on the roster with a gold border and a gold "WEAPON" callout listing what they hold.
- Roster has sort buttons: "Best → Worst" and "Worst → Best" by rarity. Click again to clear and return to the default order.
- You can sell players from your roster for 50 keys each. Tap a player to select them, then tap the red Sell button. Confirms before selling. Equipped players are automatically unequipped first.
- Multi-select on the roster: tap as many players as you want and sell them all at once. The Sell button updates with the count and total payout.
- Rarity bulk-select: chips for Common / Uncommon / Rare / Epic / Legendary. Tap one to select every player of that rarity in your roster. Tap again to deselect them. Combine with single-tap to mix and match. A Clear button shows whenever you have anything selected.
- When your opponent quits a match, a popup appears explaining what happened and how many keys you won. The match automatically ends for you as well, then drops you back at the menu.
- Invite-by-name has autocomplete. Start typing a player name and a list of up to 10 matching players appears under the input. Click one to send the invite.
- Invite-created matches don't pay keys to either side — they're for friendly play. Queue matches still pay 200/25.
- In a multiplayer match, both players' usernames now show in the top-right with their team color (RED or BLUE) and any tag.
- Admins can gift keys to any player by username.
- Admins can give any player a custom tag, or use the default "ADMIN" tag. Tags appear next to that player's name in matches.
- Admins have a personal "Show my tag in matches" toggle and can rename their own tag to whatever they want.
- Granting Admin now also sets the new admin's tag to "ADMIN" by default.

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
