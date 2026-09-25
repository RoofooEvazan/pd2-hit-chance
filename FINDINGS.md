# PD2 reverse-engineering findings

Binaries: stock Diablo II 1.13c `D2Game.dll` / `D2Common.dll` / `D2Client.dll` (timestamps 2010-03-08), with
PD2 changes applied at runtime by `ProjectDiablo.dll` (built 2026-05-13). Data: PD2 `data.zip` (launcher copy).
Your local `data/global/excel` has custom edits (extra `d1_*` monsters, changed Levels/Skills). The tools use `data.zip`.

Status key: **VERIFIED** = the game's own code was run natively in the harness and matched the formula on every
test input. **READ** = read from disassembly, not yet executed. **OPEN** = not solved yet.

## Tooling
- No Ghidra. Network installs are blocked in the workspace, so the work uses objdump + Python.
- `tools/pe.py` parses PE files (exports, imports, flat image). `tools/fn.py` extracts one function. `tools/txtdesc.py` recovers .txt column → struct offset tables from D2Common.
- `harness/`: loads the real DLL images at their base addresses inside a freestanding 32-bit Linux process and calls game functions directly on the CPU.
  - `driver.py` runs the hit roll. `monscale.c` runs the monster stat scaler.
- PD2 patch records in ProjectDiablo.dll `.rdata` are 20 bytes: `{module, rva, value, relative, size}`, where module 0=D2Client, 2=D2Common, 3=D2Game.
  - To check whether PD2 touches a function, scan these records for an RVA inside its range.

## Hit roll
**PD2 replaces the final chance (VERIFIED, 8,180 native cases of PD 0x10271470, 0 mismatches).** PD2's own roll PD 0x10271740 (called from PD 0x10270EB0 and ~6 other sites) computes AR/defense like the stock code (PD 0x10271620 mirrors 0x6FCFB1F0), then: ratio = 111·AR/(AR+Def) (100 when both 0); chance = ratio·2·aLvl/(aLvl+dLvl); < 5 → 5; > 95 → excess = ratio − 95·L/(2·aLvl), excess = (S·excess/111)·90/S, chance = 95 + excess·2·aLvl/L, capped at 100; hit if pdRand % 100 < chance. So 100% is reachable, e.g. Ignore Target Defense on normal monsters at equal level. The stock function below is what 1.13c does without PD2.

### Stock: D2Game 0x6FCFDE90 (VERIFIED, 200k random cases × 100 rolls)
`int __stdcall(eax=attacker, defender, arg2, isMissile)`, called from:
- melee: 0x6FCFE5A0 (arg2 = skill ToHit via D2Common #10653)
- missiles: 0x6FC5B040, 0x6FC5EF4E (arg2 = missile's stat 19)

1. **Defense** = D2Common #10672(defender) + stat 33 (`armorclass_vs_hth`), or stat 32 (`armorclass_vs_missile`) for missiles.
   - #10672: base = stat31 + trunc(dex/4); pct = stat16 + stat171; def = base + trunc(base×pct/100). When base ≤ 0 the % is mirrored: base − trunc(base×pct/100).
   - Holy Shield adds its bonus through state 101 (skill calc).
   - Then stat 182 `armor_override_percent`: def += trunc(def×v/100).
2. **Player attacker (unit type 0)**
   - AR = #10621 = stat19 + 5·dex − 35 + CharStats.ToHitFactor (+0x3C, VERIFIED offset).
   - Then 0x6FCFB1F0 adjusts AR and defense against the target:
     - stat115 `ignoretargetac`: defense = 0 if the target is a monster that is not superunique or unique (MonsterData+0x16 & 0xA), not an act boss (MonStats `boss`), and not a mercenary.
     - stat116 `fractionaltargetac`: halved (toward zero) against players, act bosses, superuniques (flag 0x2) and mercs; capped at 100; defense −= trunc(def×v/100).
     - stat123 `item_demon_tohit` is added to AR against a MonStats `demon`. stat124 `item_undead_tohit` against `lUndead`/`hUndead`.
   - pct = weapon mastery (#10804, stat 342 melee only) + stat119 + arg2 + stat179 `attack_vs_montype`. AR += trunc(AR×pct/100).
3. **Monster / merc attacker**: AR = stat19 + 5·dex + arg2; pct = stat119 only. Step 2's target adjustments are **skipped**.
4. If def < 0: AR −= def, def = 0. If AR < 0: def −= AR, AR = 0.
   - ratio = trunc(AR·100/(AR+def)), or 100 when the sum is 0.
   - chance = trunc(ratio·aLvl·2/(aLvl+dLvl)), clamped to 5–95.
5. RNG: seed at attacker+0x20/0x24, new = lo·0x6AC690C5 + hi (64-bit), roll = low32 % 100. Hit if roll < chance.
- Caller 0x6FCFE5A0: a player defender in mode 3 (Run) is hit without an AR roll. After a hit, 0x6FCFB790 checks block/avoid/evade (PD2 patches around 0xDE661).
- MonStats flag dword +0xC (VERIFIED via the column table): bit2 noRatio, bit6 boss, bit11 lUndead, bit12 hUndead, bit13 demon.
- Mercenary classes (D2Common #11104): 271, 338, 359, 560, 561, plus PD2 hook 1056 (act4hire) → type 2.
- MonsterData+0x16 flags: 0x2 superunique (stored alongside the SuperUniques id at +0x26), 0x4 champion, 0x8 unique, 0x10 minion (READ).

### PD2 pipeline in full (added; details, addresses and confidence in `adv/re/hit_pd2.md`, code `adv/re/hit.js`)
- **VERIFIED as a whole** (`harness/hitpd.c` + `hitpd.py`, 30,000 random cases, 0 mismatches in AR, Def, chance, hit/miss, post-hit call and RNG state).
  - It ran PD 0x10271740 with its helpers 0x10271620, 0x102727D0 (mastery choice), 0x102CE840, 0x10271470 and pdRand 0x102C5D10.
  - Only the D2Common/D2Game imports were stubbed, by pre-filling PD's lazy-import slots.
  - `node adv/re/test_hit.js` replays 2,534 of these cases through `hit.js`.
- **Callers**:
  - 31 of the 34 stock `call 0x6FCFE5A0` sites are redirected at runtime to wrapper 0x102EEDA0 → resolver **PD 0x10270EB0**.
  - The 3 left alone are unreachable in practice: srvstfunc 16 (no skill uses it), 0x6FC97788 and 0x6FCC1185 (no references).
  - All 12 callers of stock missile collision 0x6FC5EDE0 → PD 0x102723E0. It rolls only for Missiles.txt `ToHit`=1 (108/1057 missiles), with isMissile=1.
  - The stock roll 0x6FCFDE90 is therefore effectively dead.
- **No running auto-hit**: PD 0x10270EB0 always rolls. Stock skipped the roll for a player defender in mode 3 (READ).
- **Mastery**: PD 0x102727D0 uses stat 345 `passive_mastery_throw_th` when the weapon's ItemTypes.Throwable and the used skill's itypea1 are both throwable, otherwise 342. It is not used for missiles.
  - The missile path passes skill ToHit (#10653 of MissileData skill/level) + stat 345 as the to-hit argument, instead of the missile's stat 19 (READ).
- **AR%** is applied in double math: bonus = trunc(AR·pct/100.0), clamped to 0x7FFFFFFF. Same as stock in normal ranges.
- The chance function works in 32-bit int and wraps for AR above about 19M (modelled).
- **RNG PD 0x102C5D10 is not the stock LCG**. new lo = hi + low32(lo·0x6AC690C5); new hi = low32((lo·A) >> 20) + carry. The output formula is the same; the next state differs.
- **Area callbacks**:
  - Splash (proc_SplashDamage / Golem / Skeleton Splash) never rolls.
  - Leap Attack and the Blade Creeper AI roll with to-hit arg = stat119 + skill ToHit, so AR% counts twice (PD 0x1026F8F0).
  - Blade Shield: roll only, no block and no range check (PD 0x1026FFE0).
  - Smite ORs the hit bit (always hits) (READ).
- **Block/avoid PD 0x1026FB60 → 0x1026FCF0: VERIFIED** (8,000 native cases).
  - Shield block = #10212 (cap 75). No moving penalty; ÷3 vs wraithMapMod. There is no 90 cap: the 90 / PvP 75/80 caps belong to resistances.
  - Then weapon block (stat 348, cap 75, wclass 2hs/ht2) → evade if moving → dodge/avoid.
  - A moving defender with no evade gets nothing; a failed evade still tries dodge/avoid.
  - PvP maps (157/159/166) halve each avoid chance. There is a 4-frame lockout.
- **Post-hit** 0x102EFAF0 → stock 0x6FCFCE70: `item_preventheal` (117) applies state 52 to monsters except classes 704–709.
- **Audit (complete factor list, `adv/re/hit_pd2.md` §7, `adv/re/hit_factors.json`)**:
  - ITD has **no level condition**. The calls are D2Common #10064 (MonStats boss bit) and #11104 (hireling). Champions and minions are affected; this is VERIFIED on 106 native cases.
  - PD2 map mods are routed by the ItemStatCost `Divide` column: map_mon_ac% → monster stat 16; map_mon_tohit/att → monster stat 119; map_glob_arealevel → game key 1, added to the monster level in Levels 137–201 (PD 0x10268D00).
  - Hell 'desecrated' areas spawn normal monsters at level 85.
  - Stat 120 (−def per hit) is stock and unpatched. It bakes active flat armorclass curses into the base on every hit.
  - Negative defense (stacked −% ≤ −100) is added to AR.
- The "PD2 patches checked" list below predates this. PD2 does replace the hit roll and resolver, through runtime-built patch records rather than static `.rdata` records.

## Monster stats
- Scaler D2Common #11089 (0x6FDA4A00), VERIFIED 20k cases with the real MonLvl.txt:
  - out.AC = trunc(MonStats.AC[d] × MonLvl[lvl].(L-)AC[d] / 100); out.TH likewise with A1TH / A2TH / S1TH and (L-)TH.
  - noRatio uses the raw values. Level index is clamped to the last MonLvl row.
- "L-" columns are used when game+0x6A (game-type byte from the create-game packet) ≠ 0 or the game is ladder (READ).
  - The client sends 0 for connection types other than 0/6/8. Single player probably uses the non-L columns (OPEN: confirm).
- Level at spawn (0x6FCCFDB0, READ): Normal uses MonStats Level. In NM/Hell (expansion), non-noRatio, non-boss monsters use Levels.txt MonLvl{2,3}Ex (Levels +0x16).
  - Mercenaries use difficulty 0.
- Monster AR (0x6FC97240, READ): computed at attack time from the current level with flag A1 (0x8), A2 (0x10) or S1/SC (0x20), then set as stat 19.
  - In NM/Hell with p ≥ 2 players: AR += trunc(AR × f/128), where f = [0,0,8,16,24,32,40,48,56][p], or 8p−16 for p ≥ 9.
- Champion / unique / minion adjustments (READ, added; see `adv/re/hit_pd2.md` §4):
  - Uniques, superuniques and their minions: umod 4 leveladd → **+3 levels**.
  - Champions: +3, then −1 in the champion handler → **+2 levels**.
  - Champion stat119 += tdiv(CDB·75, 100), where CDB = DifficultyLevels ChampionDamageBonus 90/75/66.
  - `strong`: unique +CDB, minion +CDB/2. `berserk`: +3·CDB AR%.
  - Fanatic: stat16 = −70 (defense −70%). Stone skin: stat31 × 2.
  - AR is recomputed at attack time from the boosted level. Defense stays at its spawn-level value.
- (was OPEN) champion / unique / minion adjustments.
  - The MonUMod handler table is at 0x6FD2E550, indexed by mod id: 4 leveladd → 0x6FC41E80 (+3 lvl, ×5 exp); 16 champion → 0x6FC42DA0 (level −1? exp adjust).
  - Still need the spawn-time level bonus and whether defense is recomputed after level changes.

## Client display (D2Client 0x6FADC2D0, READ)
- Character screen AR = #10621 base + trunc(base × (mastery + stat119 + selected skill ToHit)/100). This matches the server for the same skill, excluding target-specific bonuses.
- PD2 replaces the display mastery call (D2Client +0x2C348 → PD 0x102728B0) to choose melee vs throw masteries.

## PD2 patches checked
None touch the hit roll, AR/defense (#10621/#10672), the scaler, or the monster level/AR code, apart from:
- the merc-type hook (D2Common +0x1A2E2 → PD 0x10268E40, adds class 1056)
- the moninit stat callback pointer (D2Game +0xAFF16)
- block/evade handling after the hit (D2Game +0xDE661…)

Caveat: PD2 realm servers could run different server code. This only covers the client install.

## Attack speed (added)
### Animation rate: D2Common 0x6FD83110 (VERIFIED, 60k cases, incl. EIAS helper 0x6FD823E0)
- Diminishing-returns table 0x6FDE4608, rows {type, k, stat}:
  - IAS(93) k=120, FHR(99) 120, FCR(105) 120, FBR(102) 120, FRW(96) 150.
  - E = k·v/(k+v), with idiv (truncates toward zero). v = −k divides by zero.
- Attack modes: s = stat68 `attackrate` + EIAS.
  - Player in mode SQ (18): −30.
  - Clamp 15..175.
  - rate = animSpeed·s/100, unsigned floor, capped 0x7FFF. Stored at unit+0x4C (and unit+0x3C).
- attackrate: base 100 (set when the character loads, D2Game 0x6FC760C6). Weapons carry stat68 = −Weapons.txt `speed` (D2Common 0x6FD7AEB6, column at item record +0xD8). Skill auras add `attackrate` (SIAS).
- Other modes: cast min(100+EFCR,175); hit recovery 50+EFHR; block 50 (100 with Holy Shield) + EFBR; walk/run velocitypercent + EFRW (min 25).
- Vanilla dual wield (both items type 0x2D): s += (w1.stat68 + w2.stat68)/2 − w1.stat68.
- **PD2 replaces the dual-wield block** (D2Common +0x334AC → PD 0x10268A90) for players:
  - Picks the weapon with the larger (stat68 + its own stat93).
  - Temporarily detaches the other weapon's stats, then s = attackrate + EIAS computed with only the faster weapon attached.
- Shapeshift override (0x6FD83C20 / 0x6FDA0CE0), when the unit has a transform state and player flag +0xC8 bit3:
  - base = (current anim length & ~0xFF) / H.
  - H = (humanA1frames·256) / trunc((100 − WSM + weaponIAS)·humanSpeed/100). This is D2Common 0x6FD767F0 on the right-hand weapon. It uses the weapon's own stat93, not the total.
  - With no weapon, H = 19.
  - Wolf = MonStats 430 token `40`. Bear = 431 token `TG`.
### Animation length
- unit+0x44 = position (8.8 fixed point), +0x48 = length = AnimData frames<<8, +0x50 = AnimData record.
- AnimData.d2 format: 256 buckets × {count, records of 160 bytes: name[8], frames, speed, events[144]}. A missing key uses the default record at table+0x404 (frames 2048, speed 256), which is what SQ mode gets.
- Start frame (#10031, 0x6FD82220) applies to players in A1/A2 only. Table 0x6FDE4480[weaponIdx][class]:
  - Amazon and Sorceress: 1 unarmed, 2 with 1hs/1ht/stf/2hs/2ht.
  - Weapon index from 0x6FDEF028: bow 1, 1hs 2, 1ht 3, stf 4, 2hs 5, 2ht 6, xbw 7, ht1 12, anything else 0.
- Sequences:
  - Skills.txt `seqnum` (+0x13) indexes 0x6FDECF40[1..23]. Each entry is 14 records of {ptr, frames, frames2}, in the order hth 1ht 2ht 1hs 2hs bow xbw stf 1js 1jt 1ss 1st ht1 ht2 (map 0x6FDECFA0).
  - Rate uses base 256 with −30. Length = frames<<8. Start 0.
- Weapon class for the animation (0x6FD93860):
  - Barbarian dual: primary 1hs + other 1ht → 1js, 1ht+1ht → 1jt, 1ht+1hs → 1st, anything else 1ss. The primary is whichever weapon is swinging now (inventory +0x1C).
  - Assassin with two claws → ht2.
  - Two-handed grip → 2handedwclass.
  - Otherwise the weapon's wclass.
### Frame count (READ, not executed)
- Server: D2Game 0x6FCFF7B0 (PD2 reimplements it at 0x102CCC30 with the same logic) schedules events when the mode starts at frame F:
  - n = #{k≥1 : start·256 + k·rate < length}.
  - The END timer (type 1) is at F+n+1.
- Single-player loop order (D2Client 0x6FAF4B50): held-button repeat (0x6FAF46B0), then server ProcessPackets (#10040), then server frame (#10008 → timers), then the client unit update.
  - The client's copy ends when pos+rate ≥ len, after n advances. It re-issues on the next loop, which the server processes before its END timer.
  - The attack command is accepted while in A1/A2/SC/TH (0x6FC98340 → 0x6FC97E00: cur ≤ END+5). The same-mode SetMode does nothing and the scheduler restarts from the current frame.
  - Held attacks therefore repeat every **n = ⌈(len − start·256)/rate⌉ − 1** frames.
- PD2 changes command acceptance for GH/BL (cur+2 ≥ END), not for attacks.

## Wereform speed (added)
- **VERIFIED (60k cases):** the override 0x6FDA0CE0 / 0x6FD767F0 plus rate 0x6FD83110 match the page's formula exactly. Two fallbacks are included:
  - The human animation lookup fails → H = 45 (0x6FD768B7).
  - The override is 0 → the animation's own speed is used.
  - A wrong-rule check (gear IAS or EIAS in the override, or WSM counted once) mismatched in 30–44k cases.
- The human animation uses the character's own class token (0x6FD93C30 takes the unit's class), so item-granted forms on any class use that class's A1 animation.
- **VERIFIED (20k cases), stale length:** D2Common SetMode #11090 → 0x6FD835F0 calls the rate function *before* storing the new length (+0x48). The first rate therefore uses the previous animation's length. In human form the override is unused, so this doesn't matter. In form, the base = previous length / H.
- Server: attack start 0x6FC987C0 → 0x6FCFFF10 calls #10819 again after SetMode, so it uses the correct length.
- Client (READ): attack start 0x6FADA750 → 0x6FAFDC70 → 0x6FADA6C0 → SetMode, with no later recalculation on that path (searched 5 calls deep).
  - The client ends a local attack by setting neutral (0x6FACC4AC). The next held attack therefore starts with the NU length: wolf `40NUHTH` = 9 frames, bear `TGNUHTH` = 10.
- **RESOLVED (READ): held attacks in form follow the client count.**
  - Server END: timer → 0x6FC99850 → 0x6FC982F0 → SetMode(neutral) + timer cleanup. No packet is built or sent on this path. SetMode #11090 has no callbacks (direct calls only) and only sets unit+0xC4 bit 0.
  - The only reader/clearer of +0xC4 bit 0 in D2Game is 0x6FCC2F90 (clears at 0x6FCC307B), and it exits unless the unit type is 1 (monster). Nothing reacts to a player's mode change by sending a packet.
  - PD2's scheduler (0x102CCC30) only adds 0x102CD360, which stores the start frame in playerdata+0x198 instead of unit+0x44 for players. No network code.
  - Client packet table: D2Client 0x6FB8DE60, 12-byte entries {handler, size, unit handler}, opcodes 0x00–0xAE. Dispatcher 0x6FB5CE20; unit packets are queued on unit+0xD8 (0x6FB5C630) and run by 0x6FB5BC20.
  - Packets that can reach SetMode: unit commands 0x0C–0x10, 0x17, 0x4C/0x4D, 0x67–0x6D (all via 0x6FADA750; player branch 0x6FAC9830 applies them to the local player too), life/mana 0x18/0x95 (death only), plus unrelated ones (0x01, 0x09, 0x19–0x1F, 0x3F, 0x58, 0x61, 0x62, 0x77, 0x9C, 0xA9). None is sent by the END path.
  - So the client ends its copy on its own schedule and only then re-issues. If the server finished first it idles in neutral; if the client is faster (e.g. S4 7 frames vs NU 9), the server accepts the new command mid-mode (0x6FC98340 table 0x6FC98410: A1/A2/SC/TH accept while cur ≤ END+5, S2/S4 always) and restarts. Either way the period is the client count.
  - First swing straight out of a run/walk uses the RN/WL length (8 frames for both forms) instead of NU.
  - PD2 patch records near these sites: D2Client 0x6FAD4555/0x6FAD4564 (sound call wrapper 0x102F0A70), D2Game 0x6FC97EF8 (player lookup callback) and 0x6FC981A6/0x6FC98216 (GH/BL acceptance). None touches attack timing.

## Native verification round 2 (harness/start.c, wclass.c, seq.c, pdual.c, sched.c, accept.c)
- **Start frame #10031 0x6FD82220 — VERIFIED (7,980 cases).** Players only. Modes A1/A2 always use the table; S3/S4 use it only when 0x6FD80530 is true (class Barbarian or Assassin, whose entries are 0). Row = index of the item record's `wclass` (+0xC0) in 0x6FDEF028, else 0.
- **Weapon class 0x6FD93860 — VERIFIED (6,776 hand combinations), with one correction.**
  - Hand choice: right item if its `component` (+0x115) is 5/6, else left; neither, or modes DT/DD → CharStats baseWClass (+0x4C, `hth`).
  - Two weapons: Barbarian → 1js/1jt/1st/1ss rules by primary (inventory +0x1C); Assassin → ht2.
  - Grip 0x6FD6FB80: one hand occupied → `2handedwclass` if the item is `2handed` (+0x11C), or `1or2handed` (+0x13D) and the unit is a Barbarian. Both hands occupied → one-handed if a Barbarian holds a `1or2handed` item; otherwise `2handedwclass` if either item is `2handed`.
  - **Correction:** two-handed swords (wclass 1hs / 2handedwclass 2hs, 18 bases) swing with 2HS for every class, and for a Barbarian unless the other hand holds something. The calculator previously used 1HS for non-Barbarians. Fixed; the "Wield two-handed" option became "Shield in the other hand".
- **Sequence setup #10099 0x6FD82820 — VERIFIED (23 seqnums × 14 classes).** +0x34 = frames<<8, +0x38 = 0, +0x3C = 0x100, +0x48 = frames2<<8 (equal to frames in PD2 data). Class slot via map 0x6FDECFA0 from the chooser's COF index.
- **PD2 dual wield 0x10268A90 (via wrapper 0x102EEBF0) — VERIFIED (60,000 cases, PD2's own code).** PD lazy imports for 1.13c resolve to D2Common #10973 (0x6FD88B70, stat getter) and #10164 (0x6FD8AC90, attach/detach item stats); pointer 0x104E50F4 = EIAS helper 0x6FD823E0. Players: s = attackrate + EIAS with only the faster weapon (larger −WSM + own IAS; tie → second/left weapon) attached. Others: stock average. Afterwards the first weapon is attached and the second detached. Stub: #10164 only.
- **Server scheduler — VERIFIED (20,000 setups).** Stock 0x6FCFF7B0 and PD2 0x102CCC30 produce identical timer lists (72k event timers). END at F + max(n,1) + 1. PD2 stores F·256 in playerdata+0x198. Stubs: timer insert 0x6FCAEA80 (recorder), start-frame lookup.
- **Command acceptance 0x6FC98340 — VERIFIED (100,000 cases, no stubs; real timer lookup 0x6FCAE490).** Commands 0/1/5/17 always; else by mode: NU WL RN TN TW S2 S4 yes; A1 A2 SC TH if cur ≤ END+5 or command 4/9; KK if cur ≤ END+5; S1 unless Amazon; S3 unless Druid; DT GH BL DD no; SQ → 0x6FC98100 (PD2-patched, not run).
- Still READ: client attack loop and held-button repeat, client packet handling, server attack start/recalc path, server END path.

## Correction: corruption sockets (CubeMain.txt rows 420–494)
- White/superior/low-quality weapons (`weap,nos,nor|hiq|low`): outcomes are only "destroyed (rare)" or "+1–6 sockets" — never IAS.
- Other qualities (`weap,nos`, first matching row wins): bows/crossbows/two-handers (`bow`/`xbow`/`2han`) +3/4/5/6 sockets; other weapons +2/3/4; or the IAS/other mod outcomes.
- Socket cap D2Common 0x6FD74610 (READ): min(Weapons.txt gemsockets, ItemTypes MaxSock1/25/40 by item level ≤25/≤40/>40).
- Consequence: a crafted/rare one-hand Phase Blade tops out at 140 weapon IAS, so Paladin/Assassin cannot reach 2-frame werebear; only Amazon with bows can (crafted bow 171 needed/180 max, Cliffkiller 191/200).

## Speed skills in the calculator

Skills.txt aura stats that write `attackrate` (added straight to speed, not through EIAS):
- Fanaticism `dm34` (Param3 10 → Param4 40), Wearwolf `dm34` (10 → 80), Frenzy `dm56` (0 → 50).
- Quickness (PD2 Assassin): `((110*blvl)*(par4-par3))/(100*(blvl+6))+par3`, par3 15, par4 60; base level only.
- Increased Speed: passive `item_fasterattackrate = blvl*2` — ordinary IAS (stat 93), goes through EIAS; in form it is gear IAS.
- `dm(lvl,a,b)` = D2Common 0x6FD9DC30, verified natively (harness/dm.c, 20,792 cases, 0 mismatches).
- Feral Rage and Hunger write only velocitypercent. Holy Freeze and Decrepify subtract attackrate (entered manually).
- Sources: The Beast aura Fanaticism 8–10; Wolfhowl +4–6 Werewolf (gives non-Druids the Werewolf bonus in wolf form).
The Fastest Frames tab's IAS figures assume no skill speed; tiers are unchanged because they are set at the 175 cap.

## Follow-up swings (Zeal, Fury, Fend, Strafe, Dragon Talon)
- Not SQ skills: anim A1 (KK for Dragon Talon). srvdofunc 13 (Zeal/Fury/Fend, p = Param2), 12 (Strafe, p = Param6), 42 (Dragon Talon, p = 100). Tables: srvstfunc 0x6FD27338 (<0x5B, record +0x2C), srvdofunc 0x6FD274A8 (<0xBF, +0x2E); client cltstfunc 0x6FB8E928 (+0xF2), cltdofunc 0x6FB8EA48 (+0xF4).
- Hit count: start func sets calc1 (+0x138); do-func decrements; restart while count > 0. Zeal/Fury min(par5+lvl-1, par6) = 3; Fend 3; DT min(lvl/6+1,3); Strafe min(max(targets, min(calc3, calc1)), calc1).
- Server restart 0x6FCC35D0 → 0x6FD02600 (PD2 replaces the call at 0x6FCC3602 with 0x102ED250 → 0x102CD0B0, same logic using playerdata+0x198): removes pending timers, k0 = tdiv((F − start)·(100−p),100), start = F − k0, events from position k0·256 checking frames from k0−1, END at F+n+1. **VERIFIED natively (harness/fup.c, 40,000 setups stock+PD, 0 mismatches).**
- Client restart D2Client 0x6FB505F0: pos = tdiv((pos>>8)(100−p),100)<<8 (READ). Dragon Talon client sets pos = 0.
- Client step D2Common #10853 0x6FD82460: j0 = (pos>>8) + (rate ≥ 256); pos += rate; events for frames j0..pos>>8. **VERIFIED natively (20,000 swings).**
- Server first-swing events (0x6FCFF7B0): frames from the start frame, events only while pos < len. **VERIFIED (harness/schev.py, 20,000 setups).**
- Event frames: first AnimData event 1–4; every player attack anim has exactly one.
- Calculator: client swing lengths pace the repeat; server hit times shown when they differ (form, p < 100); server hits after the client's repeat are dropped.

## Speed skills from equipment (any class)
- Scanned every excel table for skill parameters naming a speed skill. Wearer-side sources: The Beast (Fanaticism aura 8–10), Wolfhowl (Werewolf oskill 4–6), Hustle (armor, `equipped-skill` Quickness SelfAura 6, plus 20 IAS), Fury runeword (+5 Frenzy, Barbarian only). Chaos +2 Blade Dance is Assassin-only and a sequence. Holy Freeze auras (Doomsayer, Ice, Shattered Wall) and Confuse/Decrepify procs act on enemies. No mercenary has a speed aura.
- Hustle: stat 191 item_skillonequip handled by PD 0x102C6030 → D2Common #10302(unit, 556, 0, …) sets skill base level (+0x28) = 0, then D2Game 0x6FCCDB30 starts the aura at level 6. Calc `blvl` = skill+0x28 clamped (D2Common 0x6FDA14C6). So Hustle attackrate = 15 on any class (READ).
- Same state `quickness` as the Assassin skill; do-func 18 (0x6FC628F0) replaces the state on each application and the aura repeats every 25 frames, so an Assassin with Hustle keeps +15 (READ).

## Advanced Stats page (added)
Details and JS for each item are in adv/re/*.md / *.js.
- Item stat values for ValShift stats (7/9/11 life/mana/stamina, 216/217) are whole points in saves and the Armory; the game keeps them << 8. Engine now shifts item and set-bonus lists.
- Passive stats: D2Common #10056 (0x6FDA2480) is gated on passivestate > 0, not the `passive` column (Paladin aura passives such as Prayer hpregen blvl, Vigor FRW blvl, resist-aura max resist apply always).
- Auras (adv/re/auras.md, READ): do-func 65 owner gets aurastats + passivestats (PD2 NOPs the stock passivestate test at D2Game 0x6FCBAA75); party/mercs get aurastats only; 66/81 owner passivestats only; 18 aura+passive; 68/25/116/120/9 aurastats; aurafilter never decides the owner. blvl = hard points in that exact skill id (item copies 0).
- Character screen (adv/re/charscreen.md, VERIFIED 30k): AR = base + base*(119 + mastery 342 + skill ToHit)/100, base = T19 + 5*dex − 35 + ToHitFactor; defense #10672; damage 0x6FAE1220/0x6FAE0E30; an item's own ED stays in the item when it has damage/defense (0x6FD89E5F). PD2 mastery lookup 0x102728B0.
- Block (adv/re/block_regen.md, VERIFIED): #10212 (toblock + BlockFactor)*(dex−15)/(2*clvl) ≤ 75, shield only; PD2 roll 0x1026FB60 has no running penalty. FBR base 50/100 (Holy Shield), no 175 cap. Regen: life T74/256 per frame; mana max(1, maxmana/(ManaRegen*25))*(100+T27)/100 + T26.
- MF/GF/XP/FRW (adv/re/mf_misc.md, VERIFIED): dim(mf,f) = mf ≤ 10 ? mf : mf*f/(mf+f), f = 250/500/600; GF ×(100+gf)/100; FRW max(25, vel% + 150*frw/(150+frw)).
- Skill attack-rate terms (adv/re/skill_speed.md, READ): Dragon Tail Param4 (−20) server+client; Double Swing par5 (+50) client only; Berserk calc3 server only. BH's IAS list includes the Dragon Tail term (adv/re/bh_ias.md) and matched: 0/4/11/23/39(10)/63/102/187.
- Cast in SQ uses FCR when the skill's seqtrans is SC (0x6FD80B80): Chain Lightning / Frozen Orb 19-frame sequence at speed 256.

## Combat additions (Advanced Stats page)
Details in adv/re/damage.md, defense.md, skilldmg.md, minions.md.
- Player → monster (VERIFIED): server adds stat 111 before the percent; crit then DS, only one (PD 0x10270E00); pierce ignored at resist ≥ 100, negative resist halved for player-owned attackers, floor −100 (PD 0x1026F410); CB 1/8 normal, 1/10 players/mercs, prime evils 1/(70+10·(100−life%)) (PD 0x102AF610); OW (PD 0x102AF060); leech physical only ÷ difficulty × Drain (PD 0x102700F0).
- Monster → player (VERIFIED per-type step): flat DR → resist/%DR (cap 50) → absorb % (cap 40) → absorb flat; PD2 clamps each type at 0; caps min(75+max,90).
- Skill damage (VERIFIED 58k + calc VM 24k): mastery multiplies the synergised value; Fog ternary precedence differs from C.
- Summons/mercs (VERIFIED building blocks): summon level min(clvl, 3·clvl/4 + lvl); merc per-level /8 (str/dex), /4 (res).

## Item drops (added, adv/re/drops.md, drops.js)
- VERIFIED natively (harness/tcq.c, 20k cases on the full PD2 TC table, 0 mismatches): TC wrapper 0x6FC32D60 + #10634 upgrade, TC routine 0x6FC32380 (NoDrop with players, picks, quality-word max along the chain, 6-item cap, gold mul, GF), quality roll 0x6FC2FC40 incl. the always-magic shortcut. harness/upq.c (30k, 0 mismatches): unique picker 0x6FC2F370 (+PD patch 0x6FC2F5CE: no min-1 rarity) and set picker 0x6FC33C20.
- Normal map monsters: `Map H2H t1/t2/t3` share a group at level 85, so all upgrade to t3. Uniques are once per game (game+0x1B24); a repeat becomes rare.
- PD death handler 0x102C11F0: specials (keys, sigils, unique maps), extra full drops (T4 maps, levels 197-199, dropbonus, skirmish), map-stat TCs, then the stock drop.

