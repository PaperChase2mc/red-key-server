# Changelog

All notable changes to Red Key. Most recent first.

## 2026-05-12

### Changed
- New player drop rates: Common 49.5%, Uncommon 25%, Rare 20%, Epic 5%, Legendary 0.5%. Rares are more common; Legendaries are much rarer.
- Once you lock in for a turn, you can no longer drag players, drag the ball, or change Kick/Dribble mode until the next turn starts. The plan is committed.

### Fixed
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
