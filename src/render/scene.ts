import { clamp, damp } from '@/core/math';
import type { QualitySettings } from '@/core/device';
import { CRITICAL_HEALTH_RATIO } from '@/game/constants';
import type { Fighter } from '@/game/fighter';
import type { World } from '@/game/world';
import type { HitEvent } from '@/game/combat';
import { BackgroundRenderer } from './background';
import { Camera2D, HORIZON_Y } from './camera2d';
import { EffectLayer } from './effects';
import { Hud } from './hud';
import { ParticleSystem } from './particles';
import { createPostFxState, PostProcessor } from './postfx';
import { DESIGN_HEIGHT, DESIGN_WIDTH, Renderer } from './renderer';
import { ClothSystem } from './ribbons';
import { SilhouetteRenderer } from './silhouette';
import { TrailSystem } from './trails';
import { WeatherSystem } from './weather';
import { alpha, Palette } from './theme';

/**
 * The fight scene.
 *
 * Owns every visual subsystem and, more importantly, owns the **draw order**,
 * which in a 2D game is most of what "looking good" means:
 *
 *   sky → parallax layers → floor → far weather → contact shadows →
 *   fighters (cloth behind, body, cloth in front) → trails → particles →
 *   near weather → effects → bloom → lens → grade → HUD → letterbox
 *
 * Trails go *over* the bodies deliberately. Physically a fist's afterimage
 * should be occluded by the arm that made it; visually, putting it on top is
 * what makes a punch look fast. This is the one place the scene knowingly
 * lies, and it is worth it.
 */

/**
 * Resolution the backdrop is rendered at before being scaled back up.
 *
 * 0.45 is the point where the blur reads as depth rather than as a low-quality
 * image; much below it the horizon line and the floor rim start to smear.
 */
const DEPTH_OF_FIELD_SCALE = 0.45;

export interface SceneOptions {
  renderer: Renderer;
  quality: QualitySettings;
}

interface FighterVisuals {
  cloth: ClothSystem;
  trails: TrailSystem;
}

export class FightScene {
  readonly camera = new Camera2D();
  readonly background = new BackgroundRenderer();
  readonly weather = new WeatherSystem();
  readonly particles: ParticleSystem;
  readonly effects = new EffectLayer();
  readonly hud = new Hud();
  readonly postfx = new PostProcessor();

  private readonly silhouette = new SilhouetteRenderer();
  private readonly renderer: Renderer;
  private quality: QualitySettings;

  private world: World | null = null;
  private visuals: [FighterVisuals, FighterVisuals] | null = null;
  private unsubscribe: (() => void)[] = [];

  readonly postState = createPostFxState();

  /** Cinematic letterbox target, eased towards each frame. */
  private letterboxTarget = 0;

  /** Momentary bloom boost, from big hits. */
  private bloomBoost = 0;
  /** Momentary lens split, from big hits. */
  private aberrationBoost = 0;

  /** Clock for the drifting light shafts. */
  private shaftTime = 0;

  /**
   * Half-resolution canvas the background is drawn into.
   *
   * Rendering the backdrop small and scaling it back up costs one blit and
   * gives a soft, even blur for free, courtesy of the browser's own bilinear
   * filtering. That is depth of field: the fighters stay razor sharp against a
   * backdrop that visibly sits behind them, which is most of what separates a
   * scene that looks composed from one that looks flat.
   */
  private readonly backdropLayer = document.createElement('canvas');
  private readonly backdropCtx = this.backdropLayer.getContext('2d');

  /** Tracks the previous frame's foot heights, to place landing dust. */
  private readonly wasAirborne: [boolean, boolean] = [false, false];

  /**
   * Whether full-screen flashes are allowed.
   *
   * Off is a genuine accessibility need, not a taste setting, so it is honoured
   * at the single point where every flash is issued rather than at each call
   * site — one place to be wrong instead of a dozen.
   */
  allowFlashes = true;

  /** Whether floating damage numbers are drawn. */
  allowDamageNumbers = true;

  constructor(options: SceneOptions) {
    this.renderer = options.renderer;
    this.quality = options.quality;
    this.particles = new ParticleSystem(options.quality.maxParticles);
    this.postfx.setQuality(options.quality);
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.particles.maxParticles = quality.maxParticles;
    this.postfx.setQuality(quality);
    if (this.world) this.background.setArena(this.world.arena, quality.parallaxLayers);
  }

  /** Attaches to a world, wiring effects to its events. */
  attach(world: World): void {
    this.detach();
    this.world = world;

    this.background.setArena(world.arena, this.quality.parallaxLayers);
    this.weather.setArena(world.arena, this.quality.maxParticles / 700);

    this.visuals = [
      {
        cloth: new ClothSystem(world.p1, this.quality.clothSegments, 0x11),
        trails: new TrailSystem(this.quality.trailSegments),
      },
      {
        cloth: new ClothSystem(world.p2, this.quality.clothSegments, 0x22),
        trails: new TrailSystem(this.quality.trailSegments),
      },
    ];
    this.visuals[0].cloth.resetTo(world.p1);
    this.visuals[1].cloth.resetTo(world.p2);

    this.camera.snapTo(world.focus.x, world.focus.y, world.focus.zoom);
    this.hud.reset();

    this.unsubscribe = [
      world.events.on('hit', (event) => this.onHit(event)),
      world.events.on('block', (event) => this.onBlock(event)),
      world.events.on('parry', (event) => this.onParry(event)),
      world.events.on('knockdown', ({ fighter }) => this.onKnockdown(fighter)),
      world.events.on('guardBreak', ({ fighter }) => this.onGuardBreak(fighter)),
      world.events.on('roundStart', ({ round }) => {
        this.hud.announce(`РАУНД ${round}`, Palette.paper, 1.6);
        this.letterboxTarget = 1;
        this.particles.clear();
        this.effects.clear();
        if (this.visuals && this.world) {
          this.visuals[0].cloth.resetTo(this.world.p1);
          this.visuals[1].cloth.resetTo(this.world.p2);
          this.visuals[0].trails.clear();
          this.visuals[1].trails.clear();
        }
      }),
      world.events.on('fightStart', () => {
        this.hud.announce('БЕЙ!', Palette.ember, 1.1);
        this.letterboxTarget = 0;
        this.flash(0.3, Palette.ember);
      }),
      world.events.on('knockout', ({ winner, perfect }) => {
        this.hud.announce(perfect ? 'ИДЕАЛЬНО' : 'НОКАУТ', Palette.blood, 2.2);
        this.letterboxTarget = 1;
        this.flash(0.85, Palette.white);
        this.bloomBoost = 1;
        this.aberrationBoost = 7;
        void winner;
      }),
      world.events.on('timeWarning', () => {
        this.hud.announce('10 СЕКУНД', Palette.gold, 1.2);
      }),
    ];
  }

  detach(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.world = null;
    this.visuals = null;
    this.particles.clear();
    this.effects.clear();
  }

  // --- event handlers -------------------------------------------------------

  /** Single gate for every full-screen flash in the game. */
  private flash(strength: number, color: string): void {
    if (!this.allowFlashes) return;
    this.effects.flash(strength, color);
  }

  private onHit(event: HitEvent): void {
    const { attacker, defender, severity, x, y } = event;
    const color = attacker.character.visuals.spark;
    const direction = Math.atan2(0.2, defender.x - attacker.x);

    this.particles.impact(x, y, severity, color, direction);
    this.effects.ring(x, y, severity, color);

    if (severity > 0.5) {
      this.effects.slash(x, y, direction, severity, attacker.character.visuals.trail);
    }
    if (severity > 0.75) {
      this.effects.burst(x, y, severity, Palette.white);
      this.flash(severity * 0.25, color);
      this.aberrationBoost = Math.max(this.aberrationBoost, severity * 4);
    }

    if (this.allowDamageNumbers) {
      this.effects.damage(
        x,
        y + 0.2,
        event.damage,
        event.zone === 'head' ? Palette.gold : Palette.paper,
        event.result === 'counter',
      );
    }

    if (event.result === 'counter') {
      this.effects.banner(x, y + 0.7, 'КОНТРА', Palette.gold);
    }

    this.bloomBoost = Math.max(this.bloomBoost, severity * 0.6);
    this.camera.addPunch(severity * 0.045);
    this.weather.addGust(severity * 140 * Math.sign(defender.x - attacker.x));
  }

  private onBlock(event: HitEvent): void {
    this.particles.block(event.x, event.y, Palette.frostSoft);
    this.effects.ring(event.x, event.y, event.severity * 0.5, Palette.frostSoft);
    this.camera.addPunch(event.severity * 0.015);
  }

  private onParry(event: HitEvent): void {
    this.effects.ring(event.x, event.y, 1, Palette.gold);
    this.effects.burst(event.x, event.y, 1, Palette.gold);
    this.effects.banner(event.x, event.y + 0.6, 'ПАРИРОВАНИЕ', Palette.gold);
    this.flash(0.4, Palette.gold);
    this.particles.emit({
      x: event.x,
      y: event.y,
      count: 26,
      speed: 6,
      life: 0.5,
      size: 0.03,
      color: Palette.gold,
      shape: 'streak',
      weight: 0.4,
      drag: 2.6,
    });
    this.bloomBoost = 0.9;
  }

  private onKnockdown(fighter: Fighter): void {
    this.effects.banner(fighter.x, 1.4, 'СБИТ', Palette.blood);
    this.particles.dust(fighter.x, 0, 1, Palette.ash400);
    this.bloomBoost = Math.max(this.bloomBoost, 0.5);
  }

  private onGuardBreak(fighter: Fighter): void {
    this.effects.banner(fighter.x, 1.6, 'БЛОК ПРОБИТ', Palette.rose);
    this.effects.burst(fighter.x, 1.2, 1, Palette.rose);
    this.particles.emit({
      x: fighter.x,
      y: 1.2,
      count: 22,
      speed: 5,
      life: 0.55,
      size: 0.035,
      color: Palette.rose,
      shape: 'shard',
      weight: 0.8,
      drag: 1.8,
    });
  }

  // --- frame ----------------------------------------------------------------

  update(dt: number): void {
    const world = this.world;
    if (!world || !this.visuals) return;

    this.camera.follow(world.focus.x, world.focus.y, world.focus.zoom, dt);
    this.camera.setShake(world.shake.x, world.shake.y);
    this.camera.update(dt);
    this.camera.clampToArena();

    this.background.update(dt);
    this.weather.update(dt, this.camera);
    this.shaftTime += dt;

    for (let i = 0; i < 2; i++) {
      const fighter = world.fighters[i];
      const visuals = this.visuals[i];
      visuals.cloth.update(fighter, dt);
      visuals.trails.update(fighter, dt);

      // Landing dust: cheap, and it makes a jump end with a thump.
      const airborne = fighter.isAirborne;
      if (this.wasAirborne[i] && !airborne) {
        this.particles.dust(fighter.x, 0, clamp(Math.abs(fighter.vy) / 8, 0.2, 1), Palette.ash500);
      }
      this.wasAirborne[i] = airborne;
    }

    this.particles.update(dt);
    this.effects.update(dt);
    this.hud.update(world.fighters, dt);

    this.updatePostState(world, dt);
  }

  private updatePostState(world: World, dt: number): void {
    const state = this.postState;

    this.bloomBoost = damp(this.bloomBoost, 0, 0.14, dt);
    this.aberrationBoost = damp(this.aberrationBoost, 0, 0.1, dt);

    state.bloom = clamp(0.4 + this.bloomBoost, 0, 1.4);
    state.aberration = this.aberrationBoost;
    state.grain = 0.05;
    state.vignette = 0.55;

    // The screen reacts to the *local* player's condition, not both. In a
    // versus match on one machine there is no single player to react to, so the
    // wash is driven by whoever is closest to losing.
    const local = world.localFighter ?? world.fighters[0];
    const danger = clamp(1 - local.healthRatio / CRITICAL_HEALTH_RATIO, 0, 1);
    state.damageWash = damp(state.damageWash, danger * 0.8, 0.3, dt);
    state.desaturation = damp(state.desaturation, danger * 0.25, 0.4, dt);

    // Slow motion pulls the bars in, which is how the game says "look at this".
    const slowMotion = world.timeScale < 0.9 ? 1 : this.letterboxTarget;
    state.letterbox = damp(state.letterbox, slowMotion, 0.16, dt);
  }

  /**
   * Draws the world, and says so when it could not.
   *
   * Returning a reason rather than `void` is the whole point. Every way this
   * method can fail to paint anything — no world attached, no per-fighter
   * visuals, a camera poisoned by a non-finite number — produces exactly the
   * same thing on screen: black, with a HUD on top of it, drawn by a method
   * that never touches the camera. Three different bugs, one indistinguishable
   * symptom, and nothing in the console. The caller can now put the reason on
   * screen instead of leaving the player to guess.
   */
  draw(): string | null {
    const world = this.world;
    if (!world) return 'сцена не привязана к бою';
    if (!this.visuals) return 'не созданы визуалы бойцов';
    if (this.camera.sanitize()) return 'камера получила некорректные числа';

    const ctx = this.renderer.ctx;

    this.drawBackdrop(ctx);
    this.drawLightShafts(ctx);

    // Weather splits around the fighters: the far half sits behind them so the
    // silhouettes never get lost in the middle of a snowstorm.
    ctx.save();
    ctx.globalAlpha = 0.5;
    this.weather.draw(ctx);
    ctx.restore();

    // Draw the fighter further from the camera first. "Further" here means the
    // one on the left, since the virtual camera sits slightly to the right.
    const order = world.p1.x <= world.p2.x ? [0, 1] : [1, 0];

    this.drawFloorReflections(ctx, order);

    for (const index of order) {
      const fighter = world.fighters[index];
      const visuals = this.visuals[index];

      // Cloth behind the body, then the body, so a sash reads as being worn.
      visuals.cloth.draw(ctx, this.camera, fighter);
      this.silhouette.draw(ctx, fighter, this.camera, {
        glow: 1,
        opacity: fighter.state === 'defeat' ? clamp(1 - fighter.stateFrame / 200, 0.35, 1) : 1,
      });
      visuals.trails.draw(ctx, this.camera, fighter);
    }

    this.particles.draw(ctx, this.camera);

    // The near half of the weather, over everything in the world.
    ctx.save();
    ctx.globalAlpha = 0.5;
    this.weather.draw(ctx);
    ctx.restore();

    this.effects.draw(ctx, this.camera);

    return null;
  }

  /** Draws the parallax backdrop, softened when the quality tier allows it. */
  private drawBackdrop(ctx: CanvasRenderingContext2D): void {
    const backdropCtx = this.backdropCtx;

    // Below "medium" the extra blit is not worth the milliseconds, and a sharp
    // background is a much smaller loss than a dropped frame.
    if (!backdropCtx || !this.quality.bloom) {
      this.background.draw(ctx, this.camera);
      return;
    }

    const scale = DEPTH_OF_FIELD_SCALE;
    const width = Math.round(DESIGN_WIDTH * scale);
    const height = Math.round(DESIGN_HEIGHT * scale);
    if (this.backdropLayer.width !== width || this.backdropLayer.height !== height) {
      this.backdropLayer.width = width;
      this.backdropLayer.height = height;
    }

    // Draw in design space, into a smaller buffer.
    backdropCtx.setTransform(scale, 0, 0, scale, 0, 0);
    backdropCtx.clearRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
    this.background.draw(backdropCtx, this.camera);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.backdropLayer, 0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
    ctx.restore();
  }

  /**
   * Fighters mirrored in the floor.
   *
   * The cheapest large upgrade available to a 2D scene. The floor stops being
   * a painted gradient and becomes a surface the fight is happening *on*, and
   * it costs one extra silhouette pass under a flipped transform.
   *
   * Drawn faint, squashed and darkening with distance: a mirror-perfect
   * reflection reads as ice, and the arenas are stone, sand and rooftops.
   */
  private drawFloorReflections(ctx: CanvasRenderingContext2D, order: number[]): void {
    const world = this.world;
    if (!world || !this.visuals || !this.quality.shadowBlur) return;

    const horizon = HORIZON_Y;

    ctx.save();
    // Confine everything to the floor. Without this the flipped fighter would
    // appear above the horizon, standing on their own head.
    ctx.beginPath();
    ctx.rect(0, horizon, DESIGN_WIDTH, DESIGN_HEIGHT - horizon);
    ctx.clip();

    // Mirror about the floor line, then foreshorten: a reflection seen at a
    // low angle is compressed, and the compression is most of what tells the
    // eye it is lying on a surface rather than hanging in the air.
    //
    // The transform has to satisfy y' = horizon·(1 + squash) − squash·y, which
    // pins the floor line to itself. Translating by `horizon · (1 + squash)`
    // before the flip is exactly that; getting it wrong by one term drops the
    // whole reflection off the bottom of the screen, which is what the first
    // version of this did.
    const squash = 0.62;
    ctx.translate(0, horizon * (1 + squash));
    ctx.scale(1, -squash);

    ctx.globalAlpha = 0.42;
    for (const index of order) {
      const fighter = world.fighters[index];
      this.silhouette.draw(ctx, fighter, this.camera, {
        glow: 0.35,
        opacity: 1,
      });
    }
    ctx.restore();

    // Fade the reflection out with distance from the floor line, using the
    // arena's own ground colour so it dissolves into the surface.
    const arena = world.arena;
    const fade = ctx.createLinearGradient(0, horizon, 0, horizon + 360);
    fade.addColorStop(0, alpha(arena.lighting.ground, 0));
    fade.addColorStop(0.45, alpha(arena.lighting.ground, 0.45));
    fade.addColorStop(1, alpha(arena.lighting.ground, 0.94));
    ctx.save();
    ctx.fillStyle = fade;
    ctx.fillRect(0, horizon, DESIGN_WIDTH, 360);
    ctx.restore();
  }

  /**
   * Light shafts from the arena's sun.
   *
   * Pure atmosphere, and the single most "expensive-looking" thing a flat
   * scene can have: the air itself becomes visible. Drawn additively as wedges
   * that sweep slowly, so the scene breathes instead of sitting still.
   */
  private drawLightShafts(ctx: CanvasRenderingContext2D): void {
    const world = this.world;
    if (!world || !this.quality.bloom) return;

    const lighting = world.arena.lighting;
    const sunX = lighting.sunX * DESIGN_WIDTH;
    const sunY = lighting.sunY * DESIGN_HEIGHT;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath();
    ctx.rect(0, 0, DESIGN_WIDTH, HORIZON_Y + 40);
    ctx.clip();

    const shafts = 7;
    for (let i = 0; i < shafts; i++) {
      // Each shaft drifts at its own rate; the spread keeps them from ever
      // lining up into a fan, which would read as a graphic rather than light.
      const phase = this.shaftTime * (0.05 + i * 0.011) + i * 1.7;
      const angle = Math.PI * 0.5 + Math.sin(phase) * 0.5 + (i - shafts / 2) * 0.13;
      const width = 0.05 + Math.sin(phase * 1.7) * 0.02;
      const reach = DESIGN_HEIGHT * 1.5;

      const gradient = ctx.createLinearGradient(sunX, sunY, sunX + Math.cos(angle) * reach, sunY + Math.sin(angle) * reach);
      gradient.addColorStop(0, alpha(lighting.sun, 0.1));
      gradient.addColorStop(0.45, alpha(lighting.sun, 0.035));
      gradient.addColorStop(1, alpha(lighting.sun, 0));

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(sunX, sunY);
      ctx.lineTo(sunX + Math.cos(angle - width) * reach, sunY + Math.sin(angle - width) * reach);
      ctx.lineTo(sunX + Math.cos(angle + width) * reach, sunY + Math.sin(angle + width) * reach);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  /** Called after `draw`, with the scene still on the canvas. */
  drawPost(): void {
    const ctx = this.renderer.ctx;
    const viewport = this.renderer.viewport;
    const state = this.postState;

    // Bloom and the lens split read the canvas back, so they must run outside
    // the design-space transform; both restore it themselves.
    this.renderer.end();
    this.postfx.applyBloom(ctx, this.renderer.canvas, viewport, state.bloom);
    this.postfx.applyAberration(ctx, this.renderer.canvas, viewport, state.aberration);
    this.renderer.begin();

    this.postfx.applyGrade(ctx, state);
    this.postfx.applyGrain(ctx, state.grain);
  }

  drawHud(showTimer = true, opacity = 1): void {
    const world = this.world;
    if (!world) return;
    this.hud.draw(this.renderer.ctx, world.fighters, world.match, { showTimer, opacity });
    this.postfx.applyLetterbox(this.renderer.ctx, this.postState.letterbox);
  }
}
