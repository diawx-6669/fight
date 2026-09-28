/**
 * Simulation constants.
 *
 * World units are metres and the arena is viewed from the side, exactly like
 * the shadow duels this game is modelled on. Keeping the unit real makes the
 * physics numbers legible: gravity really is ~9.8 m/s², a fighter really is
 * 1.8 m tall, and a push kick really does move someone about a metre.
 *
 * Time is measured in *frames* at a fixed 60 Hz tick, because frame data is the
 * language fighting games are balanced in. "7 frames of startup" is a number
 * players can feel and compare; "116 milliseconds" is not.
 */

/** Simulation ticks per second. Everything in `moves.ts` is expressed in these. */
export const TICK_RATE = 60;
export const TICK_SECONDS = 1 / TICK_RATE;

/** Converts a frame count to seconds. */
export function frames(count: number): number {
  return count / TICK_RATE;
}

// --- arena -----------------------------------------------------------------

/** Half-width of the playable floor, in metres. Fighters cannot pass it. */
export const ARENA_HALF_WIDTH = 7.5;

/** Ground plane. Everything stands on y = 0 and jumps to positive y. */
export const GROUND_Y = 0;

/** How close two fighters may get before bodies push each other apart. */
export const BODY_RADIUS = 0.42;

/** Distance at which the camera starts to pull back to keep both in frame. */
export const CAMERA_COMFORT_DISTANCE = 5.5;

// --- body ------------------------------------------------------------------

/** Nominal fighter height in metres, before per-character scaling. */
export const FIGHTER_HEIGHT = 1.8;

/** Hip height while standing, in metres. The rig's origin. */
export const HIP_HEIGHT = 0.98;

/** Height of the head centre above the hips. */
export const HEAD_OFFSET = 0.62;

// --- physics ---------------------------------------------------------------

export const GRAVITY = 22;

/** Terminal downward speed, so a long fall does not become uncontrollable. */
export const MAX_FALL_SPEED = 18;

/** Horizontal walking speed in metres per second at full input. */
export const WALK_SPEED = 3.2;

/** Backing away is deliberately slower — retreating should cost something. */
export const BACKPEDAL_SPEED = 2.4;

/** Initial upward velocity of a jump, tuned for ~0.62s of air time. */
export const JUMP_VELOCITY = 7.6;

/** Horizontal drag applied while airborne, per second. */
export const AIR_DRAG = 0.6;

/** Horizontal drag applied on the ground when no input is given. */
export const GROUND_FRICTION = 12;

// --- combat ----------------------------------------------------------------

export const MAX_HEALTH = 1000;
export const MAX_STAMINA = 100;
export const MAX_METER = 100;

/** Stamina regained per second while not attacking. */
export const STAMINA_REGEN = 22;

/** Stamina regained per second while holding a guard — deliberately less. */
export const STAMINA_REGEN_GUARDING = 8;

/** A guard that runs out of stamina breaks, leaving the fighter wide open. */
export const GUARD_BREAK_STUN_FRAMES = 42;

/** Fraction of damage that gets through a correct block. */
export const CHIP_DAMAGE_RATIO = 0.12;

/** Blocking the wrong height takes this much of the full damage. */
export const WRONG_GUARD_RATIO = 0.75;

/** Damage multiplier applied to a hit that lands during the opponent's startup. */
export const COUNTER_HIT_MULTIPLIER = 1.35;

/** Damage multiplier while the attacker's super meter is full and burning. */
export const RAGE_MULTIPLIER = 1.5;

/** Meter gained per point of damage dealt. */
export const METER_PER_DAMAGE_DEALT = 0.045;

/** Meter gained per point of damage taken — losing should build comeback fuel. */
export const METER_PER_DAMAGE_TAKEN = 0.07;

/** Frames of invulnerability granted by a committed dodge. */
export const DODGE_IFRAMES = 11;

/** Frames of invulnerability after a successful parry, plus the counter window. */
export const PARRY_IFRAMES = 8;
export const PARRY_COUNTER_WINDOW = 24;

/** Below this health a fighter enters the bloodied state the renderer reacts to. */
export const CRITICAL_HEALTH_RATIO = 0.25;

// --- feel ------------------------------------------------------------------

/**
 * Hit-stop: both fighters freeze for a few frames on impact. It is the single
 * cheapest trick in the genre for making a punch feel like it connected with
 * something solid rather than passing through fog.
 */
export const HITSTOP_LIGHT = 4;
export const HITSTOP_MEDIUM = 7;
export const HITSTOP_HEAVY = 11;
export const HITSTOP_SUPER = 18;

/** Screen shake magnitude, in metres of camera offset. */
export const SHAKE_LIGHT = 0.05;
export const SHAKE_MEDIUM = 0.11;
export const SHAKE_HEAVY = 0.2;

/** Combo scaling: each extra hit in a chain deals this fraction less. */
export const COMBO_SCALING = 0.88;

/** Damage never scales below this fraction, so long combos still matter. */
export const MIN_COMBO_SCALE = 0.25;

/** Frames without a hit before a combo is considered dropped. */
export const COMBO_TIMEOUT_FRAMES = 48;

// --- match -----------------------------------------------------------------

export const ROUNDS_TO_WIN = 2;
export const ROUND_TIME_SECONDS = 99;
export const ROUND_INTRO_FRAMES = 110;
export const ROUND_OUTRO_FRAMES = 140;

/** Frames the loser spends on the floor before the round formally ends. */
export const KNOCKOUT_FREEZE_FRAMES = 90;
