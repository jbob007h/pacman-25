# Pac-Man 25 — playable prototype

A 25-player, last-one-standing maze chase. Every player starts in their own maze on a
5×5 grid of mazes that wraps in both directions, and anyone can walk through the doors
into any neighboring maze. Play solo in the browser against 24 CPU players, or online:
quick play or a private room with friends, with CPU players filling the empty mazes.

The in-game title is the placeholder **Maze Royale**, and the characters are original
stand-ins (diamond runners, shield-shaped ghosts, spiky raiders). Pac-Man and its ghosts
belong to Bandai Namco, so a public release needs its own name and art.

## Play

**Solo:** open `dist/index.html` in a browser. No server or install needed.

**Online:** run the game server (below) and open its address. The start screen then
offers **Quick Play** (joins the next public match; it starts 20 seconds after the first
player arrives, or as soon as 25 are in) and **Create Room** / **Join** (a private room
with a 4-letter code that the host starts). Up to 25 people per match; CPU players take
the rest of the mazes, and take over for anyone who disconnects until they come back
(within 60 seconds, by reloading the page).

| Keyboard | Controller | Action |
| --- | --- | --- |
| Arrow keys / WASD | D-pad or left stick | Move (turns are buffered, so press a little early) |
| Space | A, X, RB or RT | Use your held power-up |
| P or Esc | Start | Pause (online: open the menu; the match keeps running) |
| M | Back / Select | Mute |
| Tab | LB / RB | Switch player while spectating |

Controllers also drive the menus (d-pad to move, A to press, B to go back) and rumble
when you lose a life, phase through an enemy, eat a ghost, get dazed, or your maze is
about to collapse. Any controller the browser recognizes with the standard layout works
(Xbox, PlayStation, Switch Pro and most others). On touch screens, swipe to move and tap
the power-up slot.

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
- **Pellet boards.** Each time a maze fills with pellets (match start and after every
  fruit), it rolls a layout: usually (80%) one random quadrant has no pellets, otherwise
  all four do. Right after a board with all four quadrants, there's a 50% chance the next
  board has no pellets at all, and its fruit appears after 2 seconds. Power pellets always
  spawn.
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
npm run build      # bundles src/ into dist/index.html (and dist/embed.html), and the server into dist/server.mjs
npm run dev        # rebuilds on change; reload dist/index.html
npm start          # runs the game server on http://localhost:8080 (serves the game too)
npm run typecheck
npm run sim        # plays bot-only matches headlessly: node scripts/sim.mjs [matches] [seed] [--verbose]
```

Server settings (environment variables): `PORT` (8080), `MAX_ROOMS` (16 matches at
once; each uses about 5% of a CPU core), `CLIENT_FILE` (the page to serve,
`dist/index.html`). For testing, `SPEED=10` runs matches ten times faster.

`dist/` is committed so the game can be played without building. Rebuild before
committing changes to `src/`.

## Code map

| File | What it does |
| --- | --- |
| `src/config.ts` | Every tuning number: speeds, timers, levels, power-ups, colors |
| `src/maze.ts` | Procedural mazes: a mirrored lattice with random edges removed, validated for connectivity, no dead ends and pellet count. Anti-trap rules: the maze's 2×3 sectors must stay connected to each neighbor, and every corridor must have a way around it of at most 30 tiles inside the maze (`MAX_ESCAPE_LOOP`; doors don't count) |
| `src/movement.ts` | Tile movement with buffered turns and the tunnel warp |
| `src/game.ts` | The simulation: rules, collisions, raiders, fruit, collapse, power-ups. Runs at a fixed 60 Hz with no DOM access |
| `src/ghosts.ts` | Classic ghost targeting and raider steering |
| `src/bots.ts` | CPU players: a search over tiles they can reach before any threat, scored by nearby value |
| `src/render.ts`, `src/walls.ts` | Canvas renderer: neon gradient walls drawn through the middle of wall tiles, snapped camera with neighbor strips |
| `src/hud.ts`, `src/audio.ts`, `src/main.ts` | HUD and minimap, synthesized sound and music, input, menus and the main loop |
| `src/gamepad.ts` | Controller input (Gamepad API), menu focus navigation, rumble |
| `src/net/` | Online client and the wire protocol |
| `server/` | The game server: rooms, matchmaking, the authoritative match loop |

## Online play: how it works

The server (`server/main.ts`, Node + [`ws`](https://github.com/websockets/ws)) runs the
real match with the same `src/game.ts` at 60 Hz and is the only authority.

- **Same world everywhere.** A match starts by sending every client the seed and the list
  of human players. Each client builds an identical "mirror" game from that, so the mazes
  never need to be sent.
- **Snapshots.** 30 times a second each client gets a compact snapshot of what it can see
  (its maze and the eight around it in full, a position for everyone else for the
  minimap), maze state that changed, full pellet layouts for mazes coming into view, and
  the events that drive effects and sounds.
- **Your Pac-Man is predicted.** The client moves you immediately and sends one steering
  frame per tick. The server moves you by exactly those frames, so when a snapshot
  confirms a frame, the client replays the frames still in flight on top of it and
  usually lands on the same spot. Small differences are eased out; big ones (you got hit)
  snap.
- **Everyone else is drawn 100 ms in the past,** interpolated between snapshots, and
  events are released on that same clock so effects line up with what you see.
- **Disconnects.** A dropped player's Pac-Man is handed to a CPU, and the seat is held
  for 60 seconds for them to reconnect.

Files: `src/net/protocol.ts` (messages and snapshot format), `src/net/client.ts`
(connection, prediction, interpolation), `server/main.ts` (rooms, matchmaking, the match
loop), `src/gamepad.ts` (controller input and menu navigation).

## Deploy to Fly.io

The repo includes a `Dockerfile` and `fly.toml`. Matches live in the server's memory, so
run a single machine.

```sh
fly auth login
fly launch --no-deploy --copy-config   # pick an app name; keep the existing fly.toml
fly deploy --ha=false                  # one machine, never auto-stopped
fly open                               # the game, with online play enabled
```

Choose `primary_region` in `fly.toml` near your players: the game feels best under
about 120 ms round trip. The page served by the server enables the online buttons; a
copy of `dist/index.html` opened from disk (or anywhere else) is solo only.
