# Pac-Man 25 — playable prototype

A 25-player, last-one-standing maze chase. Every player starts in their own maze on a
5×5 grid of mazes that wraps in both directions, and anyone can walk through the doors
into any neighboring maze. This prototype is single-player in the browser: you against
24 CPU players running the same rules the multiplayer version will use.

The in-game title is the placeholder **Maze Royale**, and the characters are original
stand-ins (diamond runners, shield-shaped ghosts, spiky raiders). Pac-Man and its ghosts
belong to Bandai Namco, so a public release needs its own name and art.

## Play

Open `dist/index.html` in a browser. No server or install needed.

| Key | Action |
| --- | --- |
| Arrow keys / WASD | Move (turns are buffered, so press a little early) |
| Space | Use your held power-up |
| P or Esc | Pause |
| M | Mute |
| Tab | Switch player while spectating |

On touch screens, swipe to move and tap the power-up slot.

## Rules

- **Start.** Every match opens with a 3-2-1 countdown. You can press a direction during
  it and you'll set off that way on GO.
- **Cornering.** Press a turn before you reach a corner and you cut it, throwing sparks.
  A clean corner also gives 0.3 seconds in which you pass straight through ghosts and
  raiders (at most once every 1.2 seconds). Pressing the turn right at the corner gives
  neither.
- **Lives and homes.** You have 3 lives and no extra lives. You respawn in your home maze,
  and its ghosts go back to their house. When a player loses their last life, their home
  maze counts down from 10 (red walls, a huge countdown, an alarm, and green EXIT
  doors) and then collapses: its doors seal, and anyone still inside
  loses a life.
- **The world.** Each maze has doors on all four edges leading to the neighboring maze,
  drawn as lit gates in the neighbor's colors with its name beside them. The grid wraps
  around. The side tunnels are violet warp portals that send you to the other side of the
  same maze.
- **Ghosts** use the classic chase/scatter targeting against the nearest Pac-Man in
  their own maze, and never leave it. Colors follow the classic roles: red chases you
  directly, pink aims ahead of you, cyan flanks using the red ghost's position, and
  orange chases from afar but retreats when close. They start slower than you, wait in the house for
  3–15 seconds at the start (5 seconds after being eaten), and crawl out slowly before
  speeding up. Power pellets turn every ghost in that maze around and frighten it for 5–7 seconds, and
  eating a ghost freezes that whole maze for a split second.
- **Raiders.** Eating a ghost outside your home maze sends one raider to each of the four
  neighboring mazes. Raiders can't be eaten. They spawn away from Pac-Men, can't use
  doors or tunnels, freeze while that maze's power pellet is active, and are all wiped out
  when someone eats that maze's fruit. They dissolve after 15 seconds.
- **Fruit and levels.** Clearing a maze spawns its fruit. Eating the fruit refills the
  maze and raises its level (faster ghosts, shorter fright, new wall colors). Eating a
  rival's fruit also reloads your own home power pellets without leveling your home.
- **Power-ups.** Pellets fill your charge meter (double away from home), and airdrops
  appear every 30 seconds. You hold one at a time:
  - **Blackout:** neighboring mazes go dark for 8 seconds.
  - **Frenzy:** ghosts in neighboring mazes chase nonstop and faster for 10 seconds.
  - **Daze:** after a 1-second charge, every rival in your maze freezes for 4 seconds.
- **Overtime.** From 7:00, every open maze levels up every 40 seconds. Once mazes are at
  max level, each overtime tick adds an extra ghost instead, so matches end in roughly
  9–12 minutes.

## Develop

```sh
npm install
npm run build      # bundles src/ into dist/index.html (and dist/embed.html)
npm run dev        # rebuilds on change; reload dist/index.html
npm run typecheck
npm run sim        # plays bot-only matches headlessly: node scripts/sim.mjs [matches] [seed] [--verbose]
```

`dist/` is committed so the game can be played without building. Rebuild before
committing changes to `src/`.

## Code map

| File | What it does |
| --- | --- |
| `src/config.ts` | Every tuning number: speeds, timers, levels, power-ups, colors |
| `src/maze.ts` | Procedural mazes: a mirrored lattice with random edges removed, validated for connectivity, no dead ends and pellet count |
| `src/movement.ts` | Tile movement with buffered turns and the tunnel warp |
| `src/game.ts` | The simulation: rules, collisions, raiders, fruit, collapse, power-ups. Runs at a fixed 60 Hz with no DOM access |
| `src/ghosts.ts` | Classic ghost targeting and raider steering |
| `src/bots.ts` | CPU players: a search over tiles they can reach before any threat, scored by nearby value |
| `src/render.ts`, `src/walls.ts` | Canvas renderer: neon gradient walls drawn through the middle of wall tiles, snapped camera with neighbor strips |
| `src/hud.ts`, `src/audio.ts`, `src/main.ts` | HUD and minimap, synthesized sound and music, input and the main loop |

## Toward multiplayer

`game.ts` is deterministic given its seed and inputs, which is what the planned
multiplayer build needs: move the simulation to an authoritative server (Rust, compiled
to WebAssembly for client prediction), send only inputs from clients, and stream state
over WebTransport with a WebSocket fallback.
