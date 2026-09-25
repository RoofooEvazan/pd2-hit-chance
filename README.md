# PD2 Hit Chance

Chance to hit for **Project Diablo 2**, both ways: your attacks on monsters, and monsters' attacks on you, with block, dodge, avoid and evade. Computed with PD2's own hit roll, recovered from the game code.

**Live site:** https://roofooevazan.github.io/pd2-hit-chance/

Companion sites: [PD2 IAS Calculator](https://roofooevazan.github.io/pd2-ias-calc/) · [PD2 Advanced Stats](https://roofooevazan.github.io/pd2-advanced-stats/)

## How the numbers were established

The hit roll was recovered from the Diablo II 1.13c DLLs that PD2 uses (`D2Common.dll`, `D2Game.dll`), with PD2's changes from `ProjectDiablo.dll` applied. The research log, including which rules were verified by running the game's own code, is in [`FINDINGS.md`](FINDINGS.md).

Everything runs in your browser. The whole site is one file (`index.html`) with no server, build step or tracking.

## Updating the site

Replace `index.html` with a new version, then commit. GitHub Pages republishes automatically within a minute or two.

## Disclaimer

This is a fan-made tool. It is not affiliated with or endorsed by Blizzard Entertainment or the Project Diablo 2 team. Diablo is a trademark of Blizzard Entertainment. No game assets are included.
