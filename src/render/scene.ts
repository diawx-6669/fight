import { clamp, damp } from '@/core/math';
import type { QualitySettings } from '@/core/device';
import { CRITICAL_HEALTH_RATIO } from '@/game/constants';
import type { Fighter } from '@/game/fighter';
import type { World } from '@/game/world';
import type { HitEvent } from '@/game/combat';
import { BackgroundRenderer } from './background';
import { Camera2D } from './camera2d';
import { EffectLayer } from './effects';
import { Hud } from './hud';
import { ParticleSystem } from './particles';
import { createPostFxState, PostProcessor } from './postfx';
import { Renderer } from './renderer';
import { ClothSystem } from './ribbons';
import { SilhouetteRenderer } from './silhouette';
import { TrailSystem } from './trails';
import { WeatherSystem } from './weather';
import { Palette } from './theme';

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

  /** Tracks the previous frame's foot heights, to place landing dust. */
  private readonly wasAirborne: [boolean, boolean] = [false, false];

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
        this.effects.flash(0.3, Palette.ember);
      }),
      world.events.on('knockout', ({ winner, perfect }) => {
        this.hud.announce(perfect ? 'ИДЕАЛЬНО' : 'НОКАУТ', Palette.blood, 2.2);
        this.letterboxTarget = 1;
        this.effects.flash(0.85, Palette.white);
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
      this.effects.flash(severity * 0.25, color);
      this.aberrationBoost = Math.max(this.aberrationBoost, severity * 4);
    }

    this.effects.damage(x, y + 0.2, event.damage, event.zone === 'head' ? Palette.gold : Palette.paper, event.result === 'counter');

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
    this.effects.flash(0.4, Palette.gold);
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

  draw(): void {
    const world = this.world;
    if (!world || !this.visuals) return;

    const ctx = this.renderer.ctx;

    this.background.draw(ctx, this.camera);

    // Weather splits around the fighters: the far half sits behind them so the
    // silhouettes never get lost in the middle of a snowstorm.
    ctx.save();
    ctx.globalAlpha = 0.5;
    this.weather.draw(ctx);
    ctx.restore();

    // Draw the fighter further from the camera first. "Further" here means the
    // one on the left, since the virtual camera sits slightly to the right.
    const order = world.p1.x <= world.p2.x ? [0, 1] : [1, 0];

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
