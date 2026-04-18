# CLAUDE.md — Frontend Agent Instructions

## Scope

The frontend is responsible for rendering a dark, Obsidian-inspired, 3D-capable geo graph for contagion simulation. It consumes binary updates from the backend and turns them into a clear, interactive visual experience.

The frontend does **not** own the simulation physics, pricing logic, liquidation logic, or contagion math. It only renders state and supports user interaction around that state.

---

## Core Frontend Goal

Build a desktop-first interface that lets the user:

- view the world state before a shock
- trigger a shock
- watch contagion propagate across the geo graph
- hover nodes to inspect local neighborhoods
- click nodes to pin focus
- use a lightweight chat or command panel to drive scenarios

The graph should feel:
- dark
- clean
- low-contrast at rest
- cinematic during simulation
- readable under rapid state change

---

## Required Stack

1. **Framework**: Next.js (App Router) + TypeScript
2. **Map / Geo Context**: MapLibre
3. **GPU Visualization**: deck.gl
4. **State Management**: Zustand
5. **Styling**: Tailwind CSS
6. **Transport**: WebSocket with raw `ArrayBuffer`
7. **Binary Parsing**: `DataView`, typed arrays, or shared decoder utilities

Do **not** replace this stack unless explicitly instructed.

---

## Product Model

There are two modes:

### 1. Pre-shock mode
- graph is mostly static
- user explores the map
- labels are quiet
- no unnecessary motion

### 2. Simulation mode
- a shock starts contagion
- updates can arrive quickly
- stressed and defaulted nodes become visually obvious
- edges in the active contagion path are emphasized
- the user should be able to follow the cascade without getting lost

The frontend should optimize for **simulation readability**, not dashboard density.

---

## Frontend Non-Negotiables

1. **No JSON parsing from the backend**
   - All backend messages are binary
   - Do not build message handling around JSON assumptions

2. **Do not put simulation logic in the frontend**
   - No contagion math
   - No default logic
   - No pricing logic
   - No liquidation logic

3. **Do not build a heavy analytics dashboard in V1**
   - No complex chart panel
   - No metrics-heavy workstation UI
   - Graph + chat + lightweight node summary is enough

4. **Do not use React DOM or SVG as the main graph renderer**
   - Main graph rendering must stay GPU-backed

5. **Do not build mobile-first**
   - V1 is desktop-first only

6. **Do not introduce clustering by default**
   - Only add clustering if density becomes a real blocker

7. **Do not overcommit edge semantics too early**
   - Treat edges as generic weighted dependency or contagion pathways until the economic model is finalized

---

## Visual Model

The graph is a **geo graph**, not a free-floating force graph.

### Typography and font rules
Use a clean, modern sans-serif stack that feels technical and understated.

#### Primary font
- **Inter** for almost all UI text
- fallback: `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`

#### Optional secondary font
- **JetBrains Mono** for:
  - tick counters
  - node IDs
  - binary / transport debug info
  - simulation status badges
  - command-style chat input if desired

Do not introduce decorative display fonts.  
Do not mix many font families.  
The UI should feel consistent, restrained, and legible on dense dark screens.

#### Font usage rules
- page and section labels: small, medium weight, slightly muted
- panel titles: medium to semibold, never oversized
- primary numbers or status values: semibold, compact
- body text: regular weight, highly readable
- monospace text: only where technical context helps

#### Default type scale
- app shell and small labels: `text-xs` or `text-sm`
- standard body copy: `text-sm`
- panel titles: `text-sm` to `text-base`
- important selection title: `text-base` to `text-lg`

Do not build the UI around oversized marketing-style headings.

### Design system rules
The design language should feel like:
- Obsidian-inspired
- dark
- precise
- cinematic but restrained
- technical rather than playful

#### Color behavior
Use a dark-first palette with strong contrast reserved for important events.

Suggested palette behavior:
- background: near-black or charcoal
- panel surfaces: slightly lifted dark gray
- borders: subtle, low-contrast
- default text: soft off-white
- muted text: cool gray
- idle nodes: muted white, gray, or desaturated blue
- stressed nodes: amber or orange
- defaulted nodes: red
- active or selected emphasis: cool blue, cyan, or white depending on context

Do not use too many saturated colors at once.  
Do not make the resting state loud.  
The graph should become dramatic only when contagion starts.

#### Surface and spacing rules
- prefer soft layering over hard boxes
- use subtle borders and translucent dark panels where helpful
- keep generous spacing between controls
- avoid cramped dense dashboards
- use rounded corners conservatively, modern but not playful

Recommended feel:
- panels: dark glassy or matte surfaces
- borders: faint
- shadows: soft and limited
- spacing: clean enough for fast scanning

#### Layout rules
- the map is the hero
- panels should support the scene, not dominate it
- keep the chat panel visually secondary to the graph
- selected node info should be lightweight and fast to scan
- avoid too many simultaneous panels competing for attention

#### Motion rules
- motion should communicate state change, not decoration
- camera motion should be smooth and intentional
- node pulses should be subtle
- edge activation should be readable, not flashy
- avoid constant glow flicker or excessive particle effects

#### Label rules
- labels should be sparse at wide zoom
- labels can increase with focus, zoom, or event importance
- use muted text for passive labels
- use brighter labels only for selected, hovered, or critical entities

#### Icon and UI chrome rules
- use simple line icons only
- avoid bulky colored buttons everywhere
- controls should feel like operator tools, not consumer app cards
- top controls should be compact and practical

### Tailwind design defaults
Use these as the default visual direction unless a more specific design token system is introduced later.

#### Font families
- sans: `Inter, ui-sans-serif, system-ui, sans-serif`
- mono: `JetBrains Mono, ui-monospace, SFMono-Regular, monospace`

#### Radius
- default panels and controls: `rounded-xl`
- smaller pills or badges: `rounded-full` only when appropriate

#### Borders
- use low-contrast border colors
- prefer `border-white/10` or similarly subtle dark-theme borders

#### Background treatment
- app background: deep charcoal or black
- panel background: dark neutral with slight transparency where it improves layering

#### Preferred feel for common elements
- buttons: compact, dark, slightly elevated, clear hover states
- inputs: understated, technical, no bright outlines unless focused
- badges: minimal, semantic color only when state matters
- tooltips: dark and compact

### Desired visual behavior
- dark basemap
- low-noise background
- dim edges by default
- subtle labels
- brighter local neighborhoods on hover
- strong stress/default visuals during contagion
- smooth camera movement
- slight 3D feel through pitch and bearing

### Visual state semantics
- **idle**: dim, quiet, low contrast
- **stressed**: clearly highlighted
- **defaulted**: unmistakable failure state
- **active edge**: visually emphasized, optionally animated
- **selected node**: pinned highlight
- **hovered node**: temporary emphasis

### What to avoid
- bright noisy UI everywhere
- constant decorative animation
- full label visibility at all zoom levels
- spaghetti-edge overload at world view
- a pure globe aesthetic that loses geographic precision

---

## Data and Transport Rules

### WebSocket rules
- consume raw `ArrayBuffer`
- parse via `DataView` or typed arrays
- isolate binary parsing in dedicated modules
- do not mix binary decoding with React component code

### Data model expectations
The frontend should be prepared to receive binary payloads representing:
- full snapshots
- per-tick deltas
- node state changes
- edge state changes
- simulation phase
- event records
- tick number

### Conceptual frontend states
These are conceptual categories, even if backend encoding differs:

#### Node states
- `idle`
- `stressed`
- `defaulted`
- `critical`

#### Edge states
- `idle`
- `stressed`
- `active`

#### Simulation phases
- `pre_shock`
- `shock_triggered`
- `cascade_running`
- `cascade_complete`
- `paused`

Keep the decoder flexible, but keep the app state typed.

---

## State Architecture

Use Zustand and keep state domains separate.

### Required state domains

#### 1. Connection state
- websocket status
- reconnect status
- last message time
- transport errors

#### 2. Graph state
- nodes
- edges
- indices for quick lookup
- changed entities from latest tick

#### 3. Simulation state
- phase
- current tick
- active events
- paused/running
- shock origin if present

#### 4. Viewport state
- longitude
- latitude
- zoom
- pitch
- bearing
- camera transition status

#### 5. Interaction state
- hovered node
- selected node
- focused region
- highlighted neighborhood

#### 6. Chat / command state
- messages
- current input
- sending state
- command history if needed

### State design rules
- keep binary decode output separate from React view logic
- keep frequently changing simulation state isolated from general UI state
- do not cause full app rerenders on every tick
- do not couple chat rerenders to graph playback rerenders

---

## Rendering Architecture

### Core principle
React manages app structure. deck.gl renders the graph. MapLibre provides geographic context.

### Scene requirements
The main scene must support:
- pan
- zoom
- pitch
- bearing
- smooth focus and fly-to
- reset camera

### Recommended layer model
Use separate layers for separate responsibilities.

#### Base map
- dark map style
- minimal labels
- low visual noise

#### Node layer
- all banks, firms, sectors
- size can depend on importance or state
- color can depend on type or state
- picking enabled

#### Edge layer
- render relationships
- inactive edges stay faint
- active or stressed edges become visible
- use arc or line rendering depending on readability

#### Label layer
- progressive reveal only
- important nodes at wider zooms
- hovered and selected nodes always eligible

#### Highlight layer
- selected node emphasis
- defaulting node emphasis
- optional active path emphasis

### Rendering rules
- keep base layers stable
- isolate high-frequency highlight changes when possible
- only animate meaningful transitions
- optimize for clarity, not visual spectacle alone

---

## Interaction Rules

### Hover
Hovering a node should:
- highlight the node
- reveal or strengthen its label
- emphasize connected neighborhood
- dim unrelated context if helpful

### Click / Select
Clicking a node should:
- pin focus
- keep neighborhood emphasized
- optionally fly camera toward the node
- update the lightweight info surface

### Shock trigger
The UI must support a clear shock trigger path, either:
- direct control button
- command in chat interface
- preset scenario selector

### Simulation playback
The user should be able to:
- see when a shock starts
- follow defaults as they happen
- understand which edges are participating in contagion
- reset when the run is over

### Labels
- labels should not all appear at once
- reveal should depend on zoom, hover, selection, and event importance

---

## Performance Rules

This project may have a mostly static starting graph, but simulation playback can update frequently. Build for that.

### Required behavior
- avoid full recomputation on hover
- avoid rebuilding huge arrays unnecessarily
- update only changed nodes and edges when possible
- use adjacency indices for neighborhood lookup
- keep tick handling lightweight

### Anti-patterns
- decoding binary data inside render functions
- full-scene React rerenders every tick
- storing massive redundant derived arrays in many components
- mixing websocket plumbing directly into view components

### Priority order
1. responsiveness
2. contagion readability
3. stable interaction
4. cinematic polish

---

## File / Module Guidance

Use a structure similar to this:

```text
src/
  app/
  components/
    map/
      GeoGraphScene.tsx
      MapContainer.tsx
      layers/
        nodeLayer.ts
        edgeLayer.ts
        labelLayer.ts
        highlightLayer.ts
      interactions/
        hover.ts
        selection.ts
        camera.ts
    chat/
      ChatPanel.tsx
      CommandInput.tsx
    panels/
      NodeInfoCard.tsx
      TopControls.tsx
  hooks/
    useSimulationState.ts
    useViewportState.ts
    useSelectionState.ts
  lib/
    binary/
      decodeSnapshot.ts
      decodeDelta.ts
      schema.ts
    graph/
      selectors.ts
      indexing.ts
      transforms.ts
    simulation/
      eventReducer.ts
      tickAdapter.ts
  store/
    connectionStore.ts
    graphStore.ts
    simulationStore.ts
    uiStore.ts
  types/
    graph.ts
    simulation.ts
  services/
    websocket.ts
```

### File conventions
- components: PascalCase `.tsx`
- hooks: `use*.ts`
- stores: `*Store.ts`
- binary decoder files: descriptive `.ts`
- avoid dumping large unrelated utilities into one file

---

## Recommended Build Order

1. binary websocket connection
2. binary decode path
3. Zustand stores
4. base MapLibre scene
5. deck.gl node rendering
6. edge rendering
7. hover + selection
8. shock trigger wiring
9. simulation tick playback
10. lightweight chat panel
11. visual polish

Do not start with fancy effects before the decode-to-render pipeline works.

---

## Good Defaults for V1

- desktop only
- dark basemap
- banks, firms, sectors only
- lightweight node info card
- no heavy charts
- no clustering unless needed
- progressive labels
- strong stressed/defaulted state visuals
- camera fly-to for selected entities
- binary snapshot + delta support

---

## Success Criteria

The frontend is successful if:

- the websocket pipeline works reliably
- the user can see the initial graph clearly
- a shock visibly triggers contagion playback
- stressed and defaulted nodes are obvious
- active contagion paths are understandable
- the scene stays usable during updates
- the app feels focused rather than bloated

---

## Final Principle

If forced to choose, always prioritize:

**clarity of contagion over visual complexity**

