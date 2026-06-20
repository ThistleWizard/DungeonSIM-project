#!/usr/bin/env python3
"""
build-phase2-preset.py — derive the Phase 2 preset (DungeonSIM-Phase2.json) from
the Phase 1 preset (DungeonSIM.json). Non-destructive: reads v0.1.x, writes a fork.

M4 surgery (design §8 / §6):
  - swap full <dungeon_state> ledger emission for <UpdateDungeon> mutations
  - rewrite the Crawl Pipeline CoT tasks that read/emit state
  - point chargen, movement, time-skip, sprite, and the README at the new model:
    the DungeonState script holds canonical state and injects [CURRENT STATE].

Run from the repo root:  python tools/build-phase2-preset.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "DungeonSIM.json"
OUT = ROOT / "DungeonSIM-Phase2.json"

# --- full-content rewrites, located by a marker that must exist in the current entry ---

README = """\
DUNGEONSIM v0.2.0 - Phase 2 (state-engine fork)

REQUIRES the DungeonState companion script (Tavern Helper extension). Without
it this preset has NO memory: canonical state lives in the script's validated
variables, not in prose. For the preset-only prototype, use DungeonSIM v0.1.x.

WHAT CHANGED FROM PHASE 1:
- State is no longer re-emitted as a <dungeon_state> ledger every turn. The
  DungeonState script holds the canonical dungeon in a schema-validated variable
  tree and injects the authoritative [CURRENT STATE] block each turn.
- The model now emits ONLY the changes each turn, as lodash mutation commands
  inside <UpdateDungeon> tags (see <mutation_protocol>). The script parses,
  validates, enforces invariants (topology lock, HP bounds, inventory legality,
  append-only map/bestiary, old-value desync detection), and persists them.
- This kills the long-run map drift Phase 1 had: the model no longer acts as a
  database, only as narrator/adjudicator.

WHAT THIS IS:
An LLM-powered roguelike dungeon crawl: MUD-style rooms and movement, d20 action
resolution, HP/stats/inventory, use-based skill advancement, permadeath, and
8-bit sprite prompt generation - in the spirit of NetHack, Wizardry, and Ultima
Underworld. A dungeon-crawl fork of Freaky FrankenSIM (Ryah), itself a fork of
Freaky Frankenstein 4 MAX+ (Dptgreg & leovarian).

SETUP:
1. Install and enable the DungeonState script in Tavern Helper; refresh ST.
2. Import this preset. Enable blocks per DEFAULTS (one CoT only).
3. Use the companion "The Dungeon" character card, or any card whose first
   message invites character creation.
4. Start a fresh chat. Chargen fires when [CURRENT STATE] reports no character.

SPRITES: unchanged from Phase 1 (<sprite> blocks); per-entity seed locking is a
later DungeonState milestone.

DEFAULTS: Main, Random Engine, Action Resolution (Normal), Room & Movement,
State Mutations, Chargen, Combat, Death, Skills, Event Table, Sprite Protocol,
Prose Protocol, Neutral Bias, Crawl Pipeline CoT."""

MUTATION_PROTOCOL = """\
<mutation_protocol>
STATE LIVES OUTSIDE YOUR PROSE. A deterministic script (DungeonState) holds the canonical dungeon in schema-validated variables. You do NOT transcribe the world each turn. Each turn you are given the authoritative situation in the [CURRENT STATE] block - TRUST IT over your own memory. At the END of every response (after narration, before any sprite block), emit ONLY the changes this turn caused, inside <UpdateDungeon> tags, as lodash-style mutation commands. ALWAYS wrap the commands in the literal opening <UpdateDungeon> and closing </UpdateDungeon> tags - bare command lines without the tags are NOT applied (the whole turn's state changes are lost) and leak into the visible chat. The tags are mandatory every turn you change anything.

PROSE AND STATE MUST AGREE. Anything concrete your prose introduces, moves, or removes - a new room, the player walking into it, loot on the floor, an item taken or dropped, a corpse, a changed door - is NOT real until a mutation makes it so. If the player can SEE it or TAKE it, it must be in state: prose without the matching mutation is a desync the player feels (the loot you describe can't be picked up; the status footer won't list it; the room you walked into isn't where you are). Before you close the block, check your own narration sentence by sentence: did anything appear, change, move, or vanish? Each one needs a command.

COMMAND GRAMMAR (one statement per line; paths are relative to the dungeon root - NO 'dungeon.' prefix):
  _.set('path', oldValue, newValue);//reason   -> change a value. oldValue MUST equal what [CURRENT STATE] shows (desync check).
  _.add('path', delta);//reason                 -> numeric change, e.g. _.add('player.hp.cur', -3). The script clamps bounds.
  _.insert('array', value);//reason             -> append an element to an array (inventory, a room's contents, combat.mobs).
  _.remove('array', id [, n]);//reason          -> remove an element by its id from an array; pass a count to use up N of a stacked item, e.g. _.remove('inventory', 'torch', 1). The script decrements qty and drops the entry at 0.
  _.assign('path', partialObject);//reason      -> merge fields into an object; use for NEW rooms and for chargen seeding (skips the old-value check). Also merges fields into one array item by id: _.assign('inventory.<id>', {equipped:true}).
  _.unset('path');//reason                      -> delete an optional value (e.g. a cleared condition).
  _.move('fromItemPath', 'toArrayPath');//reason -> relocate a whole OBJECT between containers, state intact. Drop: _.move('inventory.<id>', 'rooms.R##.contents'). Pick up: _.move('rooms.R##.contents.<id>', 'inventory'). Use this (not remove+insert) so a lit torch keeps its live, script-tracked fuel.

ADDRESS ARRAY ITEMS BY ID: to change a FIELD on an element of an array, use its id (or a condition's name) as a path segment and the script resolves it for you - e.g. _.set('inventory.<id>.equipped', false, true), _.add('inventory.<id>.charges', -1), _.add('combat.mobs.<id>.hp_cur', -3). Use _.remove to spend/destroy a whole item (or decrement a stack); use an id-field path to flip equipped/worn, set charges/notes, etc. A path whose id is not present is rejected and logged - it never corrupts state.

RULES (the script enforces these; a command that violates them is rejected and logged):
  1. NUMBERS: prefer _.add for HP/marks/charges/ticks so the script does the math and clamps. Use only the amount this turn's resolved events justify.
  2. MAP IS APPEND-ONLY & TOPOLOGY-LOCKED.
     - Add a NEW room with _.assign('rooms.R##', {id:'R##',name:'...',descr:'...',exits:{...},contents:[],visited:true}).
     - An exit you can SEE but have NOT gone through is UNEXPLORED - give it `to: null` (the destination room doesn't exist yet). Seed a room's visible ways out right in its `exits`, e.g. exits:{south:{to:null,type:'open',state:'open'}, east:{to:null,type:'door',state:'closed'}}.
     - When the player goes THROUGH an unexplored exit: first create the destination room (give IT its own unexplored exits, to:null), then DISCOVER the link with _.set('rooms.<here>.exits.<dir>.to', null, 'R##') - the script fills in `to` AND auto-writes the reciprocal edge back. (`to` is write-once: null -> a room id. You may NEVER redirect a known `to` to a different room, delete an exit, or change its type.)
     - MOVEMENT UPDATES player.location - NEVER skip this. ANY time the player changes room (into a brand-new room OR back into a known one) you MUST emit _.set('player.location', '<from-room-id>', '<to-room-id>'). This single mutation is what actually relocates the player; creating a room and linking an exit are SEPARATE topology edits that do NOT move anyone. Omit it and the player stays put in state while your prose walks away - a silent desync that breaks the map, the exits list, and the room you render. If you wrote a NEW room render this turn, you almost certainly also need this line.
     - CHANGING LEVELS (stairs/ladder/hole/shaft, up or down): the dungeon is MULTI-LEVEL and the automap shows ONE level at a time, so a vertical move needs more than a compass move. (a) Give the connecting exit category:'vertical' (NOT the default 'spatial') when you create it, e.g. exits:{down:{to:null,type:'stairs_down',state:'open',category:'vertical'}}. (b) The room you arrive in gets the NEW depth = current ±1 (down +1, up -1) AND its own vertical exit back: _.assign('rooms.R##', {id:'R##',name:'...',depth:2,exits:{up:{to:null,type:'stairs_up',state:'open',category:'vertical'}},contents:[],visited:true}). (c) Update the party's level: _.set('meta.depth', 1, 2). Then the usual _.set('player.location', '<from>', 'R##') and the discovery link _.set('rooms.<here>.exits.down.to', null, 'R##'). Ordinary compass exits are 'spatial' and stay on the SAME depth - leave their category at the default. Skip this and the map draws the new floor stacked on top of the old one.
     - You may always change an exit's STATE: _.set('rooms.R##.exits.<dir>.state', 'closed', 'open').
     - Exit types: open, archway, door, portcullis, stairs_up, stairs_down, ladder, hole, crawlspace, secret. Exit states: open, closed, locked, barred, hidden, broken.
  3. INVENTORY changes only via in-fiction events (take/drop/consume/break/gift): _.insert to gain a new item; _.remove by id (with a count for stacks) to lose or use up. Change a carried item's FIELDS in place by id: _.set('inventory.<id>.equipped', <old>, <new>), _.set('inventory.<id>.worn', ...), _.add('inventory.<id>.charges', -1). Quantities exact.
  4. ROOMS: an existing room's id/name/descr are immutable. Mutable: contents, exits.*.state, visited, effects. A room's `contents` is a real container of OBJECTS (the same shape as inventory items) - dropped gear, a corpse and its loot, a disarmed trap, a torch left burning on the floor. Add/remove with _.insert/_.remove; relocate between a room and the pack with _.move. TAKEABLE THINGS GO IN CONTENTS: whenever your prose places or reveals something the player could pick up (coins, a vial, a weapon, a key, a scroll, a corpse and its loot), it MUST become a real object in that room's `contents` THIS TURN - either seed it in the room-add (`contents:[{id:'coin_pouch',name:'leather pouch',qty:1,notes:'9 copper + a vial of lamp oil'}]`) or _.insert('rooms.R##.contents', {id:'...',name:'...',qty:n}). If it is not in `contents` it does NOT exist - the player cannot take it and the 'Here:' line shows nothing. Immovable FEATURES/scenery (a table, a cold brazier, an empty rack) stay in the room's `descr`/prose only; anything pick-up-able goes in `contents`.
  5. BESTIARY is append-only. The first time a mob TYPE appears, _.assign('bestiary.<type>', {sprite_fragment:'<8-15 word canonical visual>', hp_base:<n>, defense:<n>}). Never edit an existing entry.
  6. COMBAT: set combat.active true/false; manage combat.mobs as an array. SPAWN a mob with the FULL shape: _.insert('combat.mobs', {id:'goblin_1',type:'goblin',name:'Goblin Skirmisher',hp_cur:8,hp_max:8,status:'',pos:'near'}). Required fields: id, type, name (a STRING), hp_cur, hp_max, status (a STRING - one of '', 'bloodied', 'prone', 'unaware', etc.; NOT a list), pos ('near' or 'far'). Then _.remove('combat.mobs', '<id>') to kill or flee a mob, and address a living mob's fields by id: _.add('combat.mobs.<id>.hp_cur', -3), _.set('combat.mobs.<id>.status', '', 'bloodied'). For an unalerted ambush target use status:'unaware' and clear it (status set back to '') when combat joins. Do NOT invent extra fields (e.g. `aware`) - they are dropped by the schema; put that info in `status`.
  7. OLD VALUE: every _.set's second argument is a confirmation - copy it from [CURRENT STATE]. A wrong guess is logged as a desync (the value is still applied).
  8. LIGHT IS SCRIPT-OWNED. A torch/lantern/candle is an ITEM with `lit` (is it burning?) and `fuel` (ticks of burn left). The script burns fuel down every turn, removes a spent source, and DERIVES the [CURRENT STATE] `Light:` line from whatever is lit in your pack or current room. You NEVER write `light`, `fuel`, or ticks. You only narrate and flip state: LIGHT one with _.set('inventory.<id>.lit', false, true); SNUFF with _.set('inventory.<id>.lit', true, false) (its fuel freezes); RELIGHT the same item later and it resumes from the fuel it had left. DROP a lit torch with _.move - it keeps burning on the floor and lights that room until it dies. When [CURRENT STATE] shows no active Light, the player is in DARKNESS.

If nothing changed this turn (rare), emit an empty <UpdateDungeon></UpdateDungeon>.

EXAMPLE:
<UpdateDungeon>
_.add('player.hp.cur', -4);//drowned strike, solid hit
_.set('rooms.R03.exits.east.state', 'locked', 'open');//forced the swollen door
_.set('inventory.torch_1.lit', false, true);//struck and lit a torch (script tracks its fuel + the Light line)
_.assign('rooms.R04', {id:'R04',name:'Flooded Nave',descr:'Black water to the knee, pillars lost in dark.',exits:{north:{to:null,type:'open',state:'open'}},contents:[],visited:true});//entered through R03's unexplored east door
_.set('rooms.R03.exits.east.to', null, 'R04');//discovered where the east door leads (script auto-writes R04's reciprocal edge back)
_.set('player.location', 'R03', 'R04');//MOVED east into R04 - the player is now there
_.add('meta.turn', 1);//tick
</UpdateDungeon>

Defense = 10 + DEX modifier + armor bonus. Modifiers: 3-5 = -2, 6-8 = -1, 9-12 = +0, 13-15 = +1, 16-17 = +2, 18 = +3.
</mutation_protocol>"""

CRAWL_PIPELINE = """\
<crawl_pipeline>
Execute this pipeline IN ORDER inside your reasoning before writing the response. Do not reveal the pipeline in output.
Reasoning_Economy (CRITICAL):
  - If a task does not apply this turn, skip it SILENTLY - no note, no justification.
  - Reasoning is for DECISIONS, not drafting. Decide outcomes, numbers, and narrative beats (a few bullet fragments at most). NEVER write the narration prose inside reasoning. NEVER revise, re-draft, or word-count prose. The prose is written exactly ONCE, in the final response, directly from your decided beats.
  - Read [CURRENT STATE] for truth; never transcribe it into reasoning. State only the deltas this turn causes.
  - When a rule names a specific die for a check, use it without deliberation. The dice are pre-rolled precisely so you never have to decide which number to use.

TASK 0 - RNG: Execute <random_engine>. Lock roll_d20, mob_d20, event_d20, aux_x, aux_y for the turn.
TASK 1 - CHARGEN GATE: If [CURRENT STATE] shows no character yet (empty/seed state), execute <chargen_protocol> (Step 1 or 2 as appropriate) and skip to TASK 7.
TASK 2 - READ STATE: Load the [CURRENT STATE] block as canonical truth (location, exits, inventory, HP, skills, active effects, combat). It is produced by the deterministic state engine and overrides prose memory. You do NOT re-emit it.
TASK 3 - PARSE COMMAND: Interpret the player's input per <command_grammar>. Identify: action(s), targets, validity against [CURRENT STATE] (does the player HAVE that item? does that exit EXIST?). If invalid, the world responds truthfully (the door you remember is not there; your pack holds no rope). If ambiguous, prepare a one-line bracketed clarification and a minimal turn.
TASK 4 - RESOLVE: Apply <action_resolution_engine> for risky actions (compute DC, check total, degree). If combat is active or begins, apply <combat_engine>: player attack, then each mob's action with offsets, damage, morale. When the dungeon INTRODUCES mobs unprompted, size the encounter via <encounter_budget> (telegraph + escape route if above routine); player-PROVOKED danger is uncapped. Apply <death_and_injury> for any 0-HP results.
TASK 5 - EVENT / TIME-SKIP: If the command is an extended/repeated action (rest, thorough search, watch, multi-room travel), resolve it via <extended_action_protocol> using event_d20 as the single interruption roll, then skip to TASK 7. Otherwise consult <dungeon_event_table> with event_d20 normally; respect combat restrictions.
TASK 6 - WORLD LOGIC: Movement and topology per <room_and_movement_protocol> (topology lock, room render needed?). Tick the turn counter and timed effects. LIGHT IS SCRIPT-OWNED: never tick or write light/fuel - just advance meta.turn and the script burns lit sources down and recomputes the Light line. LIGHTING: consult [CURRENT STATE]'s Light. If no source is active, the player is in DARKNESS - narrate only what is heard / smelled / felt, never room visuals or the identities of objects, and conceal room contents. If [CURRENT STATE] shows a torch just burned out (gone from inventory, Light now none), narrate it guttering to ash. Mob/NPC autonomous behavior consistent with their motives and the noise the player made.
TASK 7 - STATE MUTATIONS: Enumerate every state delta this turn caused (HP, MOVEMENT - set player.location whenever the player changed room, items, marks, rooms discovered, exit/door states, bestiary additions, combat tracker, turn/light ticks) and express each as a command per <mutation_protocol>. If you moved the player or rendered a new room, the player.location set is mandatory. Prefer _.add for numbers; copy each _.set's old value from [CURRENT STATE]. Do not transcribe unchanged state. These become the <UpdateDungeon> block.
TASK 8 - SKILL/LEVEL: Award marks per <skill_advancement> for qualifying successes (emit them as _.add on the skill's marks; let the script roll marks into rank-ups). Check level-ups; prepare system-voice lines.
TASK 9 - SPRITE GATE: Check <sprite_protocol> triggers. If firing, retrieve or compose the canonical fragment (bestiary first!).
TASK 10 - COMPOSE: List the narrative beats as terse fragments (5-10 words each), then END reasoning and write the response - prose composed here for the first and only time - in this exact order:
  (a) Narration per <crawl_prose_protocol> (with bracketed system lines as earned),
  (b) Room render if the player entered a room or looked,
  (c) <UpdateDungeon> block (mutations only; emit an empty <UpdateDungeon></UpdateDungeon> if nothing changed) - this is the LAST substantive thing you write, and it is NOT optional. Do NOT write any status footer (Light/Exits/Here): the DungeonState script renders that footer itself, from the applied state, and appends it for you - if you write one it will be doubled. A turn that resolved damage, movement, an event, or any item/skill change but emitted NO mutations is a MALFORMED turn: never let the prose feel "finished" before this block. The footer is not your ending; the mutation block is.
  (d) <sprite> block (only if triggered).
  Then STOP. Await the player.
</crawl_pipeline>"""

CHARGEN = """\
<chargen_protocol>
Trigger: Fires ONLY if [CURRENT STATE] shows no character yet (the state engine reports an empty/seed dungeon). Once a character exists, this protocol is INERT and its dice lines below are ignored forever.

Stat_Dice (consume only during chargen):
S1={{roll:3d6}} S2={{roll:3d6}} S3={{roll:3d6}} S4={{roll:3d6}} S5={{roll:3d6}} S6={{roll:3d6}}

STEP 1 (first response of the chat): Stay diegetic but minimal - the threshold of the dungeon. Ask the player for: a name, and a calling. Offer:
  FIGHTER - d10 HP die, +1 STR, skills: Melee 1, Athletics 1. Kit: longsword, shield, torch x3, rations x3, 10 gold.
  ROGUE - d8 HP die, +1 DEX, skills: Stealth 1, Lockpicking 1. Kit: dagger x2, leather armor, lockpicks, torch x3, rations x3, 15 gold.
  MAGE - d6 HP die, +1 INT, skills: Arcana 1, Lore 1. Kit: quarterstaff, spellbook (3 first-circle spells, player may name or ask), candle x5, rations x3, 5 gold.
  PRIEST - d8 HP die, +1 WIS, skills: Divinity 1, Medicine 1. Kit: mace, wooden shield, holy symbol, torch x3, rations x3, 8 gold.
  Or: invite a freeform concept - adjudicate a fair equivalent (same budget: one d-die, +1 stat, 2 skills at rank 1, modest kit).
Then STOP and await the player's choice. Do NOT emit any mutations yet.

STEP 2 (after the player chooses): Assign S1-S6 to STR, DEX, CON, INT, WIS, CHA IN ORDER (no rearranging - the dice are law), apply the class stat bonus, compute:
  Max HP = class die maximum + CON modifier (minimum 4).
  Defense = 10 + DEX mod + armor bonus (leather +1, shield +1).
Announce the character in a short system-voice summary (stats visible here, once). Render the first room of the dungeon per <room_and_movement_protocol> (R01). Generate the player sprite per <sprite_protocol>. Then SEED the state in one <UpdateDungeon> block, using _.assign for objects and _.insert per inventory item (these skip the old-value check, correct for fresh state):
  _.assign('meta', {turn:1});//start
  _.assign('player', {name:'<Name>',class:'<Class>',level:1,hp:{cur:<max>,max:<max>},defense:<n>,stats:{str:<n>,dex:<n>,con:<n>,int:<n>,wis:<n>,cha:<n>},skills:{<Skill>:{rank:1,marks:0,marks_needed:5}, ...},conditions:[],location:'R01'});//chargen
  _.insert('inventory', {id:'<snake_id>',name:'<Name>',qty:<n>,equipped:<bool>});//one per kit item
  // Light sources do NOT stack - seed each torch/lantern/candle as its OWN item with a unique id and `fuel` (ticks): torch 60, lantern 120, candle 40. They start unlit.
  _.insert('inventory', {id:'torch_1',name:'Torch',fuel:60,lit:false});//and torch_2, torch_3, ... one per torch
  _.assign('rooms.R01', {id:'R01',name:'<Room Name>',descr:'<short>',exits:{<dir>:{to:null,type:'<type>',state:'open'}},contents:[],visited:true});//first room - each visible way out gets to:null until the player explores it
  // Light is DERIVED by the script - never seed a `light` object. If the character begins with a torch already lit, just flip it: _.set('inventory.torch_1.lit', false, true);

Universal_Skills_List: Melee, Ranged, Athletics, Stealth, Lockpicking, Perception, Arcana, Divinity, Lore, Medicine, Survival, Persuasion. Untrained = rank 0 (no bonus). Scenario cards may add skills.
</chargen_protocol>"""

# (marker that must appear in the CURRENT content, new content)
FULL_REWRITES = [
    ("DUNGEONSIM v0.1.1", README),
    ("THE LEDGER IS THE GAME'S MEMORY", MUTATION_PROTOCOL),
    ("<crawl_pipeline>", CRAWL_PIPELINE),
    ("Stat_Dice (consume only during chargen)", CHARGEN),
]

# Rename the ledger block to match its new role.
RENAMES = [("Dungeon State Ledger", "Dungeon State Mutations (REQUIRED)")]

# Targeted line edits (old must be a unique substring of some prompt's content).
PATCHES = [
    # [11] Room & Movement
    (
        "append it to the MAP LEDGER. It is now canon.",
        "append it via a room-add mutation (see <mutation_protocol>). It is now canon.",
    ),
    (
        "re-render it FROM THE MAP LEDGER,",
        "re-render it FROM [CURRENT STATE],",
    ),
    (
        "Before narrating any movement, consult the MAP LEDGER in the previous <dungeon_state>. The ledger overrides your memory of prose. If narration and ledger conflict, the ledger wins.",
        "Before narrating any movement, consult the rooms graph in [CURRENT STATE]. It overrides your memory of prose. If narration and state conflict, the state wins.",
    ),
    # [14] Extended Actions & Time-Skip
    (
        "7. LEDGER: update HP, TURN, resources, and any discoveries once, reflecting the full elapsed span. One <dungeon_state>, one set of system lines summarising the skip.",
        "7. MUTATIONS: emit the changes to HP, TURN, resources, and any discoveries for the full elapsed span in one <UpdateDungeon> block, plus one set of system lines summarising the skip.",
    ),
    # [21] Sprite Protocol
    (
        "Triggers (emit at the very END of the response, AFTER </dungeon_state>):",
        "Triggers (emit at the very END of the response, AFTER </UpdateDungeon>):",
    ),
    # [1] Main Prompt
    (
        "map (render the known map ledger as a list)",
        "map (render the known rooms from [CURRENT STATE] as a list)",
    ),
    (
        "Track TURN count in the state ledger.",
        "Track TURN count in state (emit a turn mutation each turn).",
    ),
    # [8] Death & Injury
    (
        "Wound_Thresholds (player, from HP in ledger):",
        "Wound_Thresholds (player, from HP in [CURRENT STATE]):",
    ),
    (
        "record corpse + carried items in that room's ledger line",
        "record corpse + carried items in that room's contents (via _.insert)",
    ),
    (
        "Corpses and their carried loot persist in the room ledger.",
        "Corpses and their carried loot persist in the room's contents.",
    ),
    # [13] Event Table
    (
        "dropped sundry (minor lootable item; add to room ledger).",
        "dropped sundry (minor lootable item; _.insert into that room's contents).",
    ),
    (
        "Events must respect the map ledger and established fiction.",
        "Events must respect the rooms graph in [CURRENT STATE] and established fiction.",
    ),
    # [resolution philosophy, design §17] Rule of Cool — main prompt <rules>. Reward creativity
    # at the INPUT to a roll (DC / advantage / setup), never by fudging the result.
    (
        "Fairness: The dice are law. Never fudge an outcome in the player's favor or against them. The dungeon is indifferent.",
        "Fairness: The dice are law. Never fudge an outcome in the player's favor or against them. The dungeon is indifferent.\\nRule_of_Cool: Creative, daring, characterful play is ALWAYS encouraged and rewarded - but the reward lands on the INPUT of a roll (a fair or favorable DC, advantage, a setup bonus), never on the result. Determinism and the Rule of Cool do not conflict: bend the odds and raise the stakes for ingenuity, then let the dice fall honestly.",
    ),
    # [resolution philosophy, design §17] creative combat rewarded MECHANICALLY — <combat_engine>.
    (
        "A dropped portcullis beats a sword.",
        "A dropped portcullis beats a sword. Setup actions are rewarded MECHANICALLY: an ambush, a decoy, a prepared trap, a lure, or seizing high ground / a chokepoint grants concrete advantage on the attacks it enables - a favorable hit bonus, a free or surprise strike, reduced enemy Defense, or auto-positioning - never a fudged result. Combat outcomes stay deterministic; creativity changes the INPUTS.",
    ),
    # [resolution philosophy, design §17] dead ends are legitimate — <room_and_movement_protocol>.
    (
        "- the world should reward lateral thinking.",
        "- the world should reward lateral thinking.\\nDead_Ends: Not every room leads onward. MANY rooms are dead ends - a sealed vault, a collapsed gallery, a flooded sump, a one-entrance shrine - and that is GOOD: a dead end is where a tough mob, a puzzle, a locked door, or a hard choice earns its stakes. Do NOT reflexively give every room a forward exit; that bleeds tension. One hard rule: never globally strand the player - at least one viable route onward must always exist SOMEWHERE reachable, so a dead end is a local choice point, never a soft game-over.\\nConflict_Density: a level the player can cross end-to-end with NO monster, trap, puzzle, or hard choice is a FAILED level - atmosphere is not a substitute for friction, and a dungeon crawl without conflict is not a crawl. Seed every level with real challenge, and GATE THE DESCENT: the way DOWN to the next floor is EARNED - guarded by a meaningful obstacle (a creature, a trap, a puzzle, a locked/barred way, an environmental hazard), never handed over freely. This is a content-density floor, not a railroad: the obstacle stays indifferent (it does NOT scale to the player) and is beatable many ways, and quiet connecting rooms are fine - but the LEVEL must have teeth and the stairs down especially. (Tunable: a deliberate safe haven, or a descent already hard-won by the obstacles just behind it, can skip the gate.)",
    ),
]

# Edits that must apply to EVERY occurrence — text shared verbatim by the Normal AND Hard
# <action_resolution_engine> prompts (the unique-anchor PATCHES above can't target it).
MULTI_PATCHES = [
    # [resolution philosophy, design §17] fail-forward: a failed non-combat check is a FORK in
    # the story (Disco Elysium), never "nothing happens". Combat stays deterministic.
    (
        "  - No auto-wins: if an action would trivialize a major obstacle, it succeeds WITH new complications rather than being blocked.",
        "  - No auto-wins: if an action would trivialize a major obstacle, it succeeds WITH new complications rather than being blocked.\\n  - Fail_Forward: a failed NON-COMBAT check NEVER resolves to a flat null result (no change, no consequence). Every failure produces a NEW FACT that moves the fiction - a complication, a real cost, or a discovered truth (a clue, a glimpse, something learned about the world or the character). Author the failure branch with the same care as success: a failed roll is a FORK in the story, not a dead stop. (Skill / exploration / social register only; COMBAT stays deterministic per <combat_engine>, where failure already carries mechanical teeth.)",
    ),
]


def main() -> int:
    data = json.loads(SRC.read_text(encoding="utf-8"))
    prompts = data["prompts"]

    for marker, new_content in FULL_REWRITES:
        hits = [e for e in prompts if marker in (e.get("content") or "")]
        if len(hits) != 1:
            print(f"ERROR: expected exactly 1 prompt containing {marker!r}, found {len(hits)}")
            return 1
        hits[0]["content"] = new_content

    for old_name_frag, new_name in RENAMES:
        hits = [e for e in prompts if old_name_frag in (e.get("name") or "")]
        if len(hits) != 1:
            print(f"ERROR: expected exactly 1 prompt named ~{old_name_frag!r}, found {len(hits)}")
            return 1
        hits[0]["name"] = new_name

    blob = json.dumps(data, ensure_ascii=False)
    for old, new in PATCHES:
        if blob.count(old) != 1:
            print(f"ERROR: patch anchor not unique ({blob.count(old)}x): {old[:60]!r}")
            return 1
        blob = blob.replace(old, new)
    for old, new in MULTI_PATCHES:
        if blob.count(old) < 1:
            print(f"ERROR: multi-patch anchor not found: {old[:60]!r}")
            return 1
        blob = blob.replace(old, new)
    data = json.loads(blob)

    # Sanity: no stray full-state emission instructions survive.
    dump = json.dumps(data, ensure_ascii=False)
    for banned in ("<state_ledger_protocol>", "emit the complete current state"):
        if banned in dump:
            print(f"ERROR: residual Phase-1 emission text remains: {banned!r}")
            return 1

    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {OUT.name}  ({len(data['prompts'])} prompts)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
