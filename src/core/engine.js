import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { SHADOW_SIZES } from './settings.js'
import { createTiltShift } from './tiltshift.js'

/** Safari and friends — not Chrome, which also says "Safari" in its user agent. */
const IS_WEBKIT =
  typeof navigator !== 'undefined' &&
  /apple/i.test(navigator.vendor || '') &&
  !/chrome|chromium|edg\//i.test(navigator.userAgent || '')

/**
 * How large the bloom's own buffers are, as a share of the drawing buffer.
 *
 * Bloom is a glow: it is blurred down through five levels and back up again, and whether
 * the first of those levels is half the frame or a third of it is not something the eye
 * can tell — but on an integrated GPU the difference was two milliseconds a frame,
 * measured. The pass still reads the full-resolution frame for its bright pixels and
 * still adds its result back at full resolution, so nothing lit gets softer than before.
 */
const BLOOM_SCALE = 0.7

/**
 * Frame rates the quality governor moves on.
 *
 * Below `SLOW` for three seconds running, it drops a step; above `FAST` for eight, it
 * climbs. Everything between is where it holds still. The old floor was 45, which meant a
 * machine could sit at fifty frames a second for as long as the window was open and the
 * governor would call that settled — on a sixty-hertz panel that is a doubled frame every
 * few, which reads as a stutter rather than as slowness.
 *
 * It was then raised to 55, and on the Intel UHD 630 with a live roster that put the frame
 * rate right on the line: every wobble read as slow, and the governor walked the picture
 * down to 35% — mush — chasing frames an ambient map does not need. 50 is the compromise:
 * a few dropped frames on a sixty-hertz panel, against a picture that can be read. The
 * resolution floor (`MIN_SCALE`) is the other half of that bargain.
 */
const SLOW_FPS = 50
const FAST_FPS = 58

/** Lowest share of the display's resolution the governor will go to. Below this, text is gone. */
const MIN_SCALE = 0.6

/**
 * Seconds after starting, waking or resizing during which the governor only watches. Those
 * frames are shader compiles and a boat-load of builders arriving, not the steady state, and
 * reading them as a slow machine is what dropped a fresh page three steps in its first five
 * seconds and then spent a minute climbing back.
 */
const WARMUP_MS = 8000

/**
 * How long a scale that proved too slow stays off limits. Without this the governor climbs
 * back to it after its cooldown, fails, drops, and does it again for as long as the page is
 * open — every round a visible sharpen and blur.
 */
const TOO_SLOW_MS = 10 * 60 * 1000

/**
 * Renderer, post chain, and the frame loop.
 *
 * Two things here are load-bearing for performance:
 *
 * 1. **The post chain is built lazily and torn down when off.** With bloom disabled the
 *    composer is not merely skipped — it is disposed, so its float render targets stop
 *    costing memory and bandwidth. Turning HDR off on a weak machine has to actually
 *    give the memory back, not just stop drawing.
 * 2. **Render scale is separate from device pixel ratio.** `setPixelRatio` alone cannot go
 *    below 1 usefully on a retina panel, so the drawing buffer is sized directly. That is
 *    the single biggest lever there is, and it is what the auto-quality governor pulls.
 *
 *    The setting is a fraction of *the display's own resolution*, not of CSS pixels: 100%
 *    on a retina panel is 2 buffer pixels per CSS pixel. Reading it as CSS pixels is what
 *    the earlier version did, and it quietly rendered every retina machine at half
 *    resolution — text on the name plates and the badge glyphs magnify hardest, so they
 *    are where a soft buffer shows up first.
 */
export class Engine {
  constructor(settings) {
    this.settings = settings
    // Timer replaces the deprecated Clock. Connecting it to the document means a tab that
    // has been in the background reports a zero delta rather than one enormous catch-up
    // frame, so nothing in the colony teleports when you come back to it.
    this.timer = new THREE.Timer()
    this.timer.connect(document)
    this.elapsed = 0
    this.updaters = []
    this.running = false

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(settings.get('fov'), 1, 0.5, 900)

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // handled by SMAA in the post chain, or not at all
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      /**
       * Off everywhere it can be: preserving the buffer costs a full copy on every frame,
       * forever, and the screenshot path already works around needing it.
       *
       * On WebKit it has to be on. Safari treats a window with another app in front of it
       * as *hidden*, stops driving `requestAnimationFrame`, and then composites the canvas
       * anyway — and a drawing buffer nobody has drawn into since the last composite is
       * transparent black. The symptom is the whole colony blinking out for a frame every
       * few seconds, but only while something is layered over the window, which is exactly
       * the case where nothing is repainting it.
       */
      preserveDrawingBuffer: IS_WEBKIT,
    })
    this.renderer.setPixelRatio(1) // the drawing buffer is sized by hand, see resize()
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = settings.get('exposure')
    // PCFSoftShadowMap is deprecated and silently downgraded by three anyway.
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.info.autoReset = false

    this.canvas = this.renderer.domElement
    this.canvas.classList.add('botsbay-canvas')

    /**
     * What is actually drawing this page, as the driver names it — "ANGLE (Intel, Intel(R)
     * UHD Graphics 630 …)". A laptop with two GPUs very often hands the browser the slow
     * one, and nothing a page can ask for changes that; it can only say so. Read once, here,
     * so the HUD can name the chip when the governor has had to back off.
     */
    this.gpuName = ''
    try {
      const gl = this.renderer.getContext()
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      this.gpuName = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '')
    } catch {
      /* a browser that hides its renderer string is a browser that hides it */
    }
    /** Called once, the first time the governor drops below the chosen scale. */
    this.onAutoScaled = null

    this.composer = null
    this.bloomPass = null
    this.smaaPass = null
    this.tiltShift = null
    /** How far the view is orbiting; the focal plane sits here. Fed by the frame loop. */
    this._focusDistance = 30

    /** True from `webglcontextlost` until the browser hands the context back. */
    this.contextLost = false
    this._overlay = null
    this._onContextLost = (e) => this._contextLost(e)
    this._onContextRestored = () => this._contextRestored()
    this.canvas.addEventListener('webglcontextlost', this._onContextLost)
    this.canvas.addEventListener('webglcontextrestored', this._onContextRestored)

    this.perf = new PerfMonitor()
    this._boundLoop = this._loop.bind(this)
    this._onResize = () => this.resize()

    this.applySettings()
  }

  mount(parent) {
    parent.appendChild(this.canvas)
    window.addEventListener('resize', this._onResize)
    // A window dragged between a retina and a non-retina display changes DPR with no resize.
    this._dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    this._dprQuery.addEventListener?.('change', this._onResize)
    // A page that loads in a background tab has a zero-width parent and no `resize` event
    // coming, which would leave a one-pixel drawing buffer until the window happened to
    // move. The observer fires the moment the element is actually laid out.
    this._observer = new ResizeObserver(this._onResize)
    this._observer.observe(parent)

    // Coming back from hidden — a tab switch, or another window moving off this one — the
    // compositor can ask for the canvas before the frame loop has run once. Drawing here
    // rather than waiting for the next animation frame is what stops that moment being a
    // black flash.
    this._onWake = () => {
      if (document.hidden || !this.running) return
      this.resize()
      this.renderFrame()
      this.warmUp()
    }
    document.addEventListener('visibilitychange', this._onWake)
    window.addEventListener('focus', this._onWake)
    window.addEventListener('pageshow', this._onWake)

    this.resize()
    return this
  }

  add(updater) {
    this.updaters.push(updater)
    return updater
  }

  /** Rebuilds only what a settings change actually invalidated. */
  applySettings() {
    const s = this.settings
    const renderer = this.renderer

    const size = SHADOW_SIZES[s.get('shadows')] || 0
    renderer.shadowMap.enabled = size > 0
    // A shadow map that changes size has to be thrown away or three keeps the old target.
    if (this._shadowSize !== size) {
      this._shadowSize = size
      this.scene.traverse((o) => {
        if (o.isLight && o.shadow?.map) {
          o.shadow.map.dispose()
          o.shadow.map = null
          if (size) o.shadow.mapSize.setScalar(size)
        }
      })
      renderer.shadowMap.needsUpdate = true
    }

    renderer.toneMappingExposure = s.get('exposure')
    this.camera.fov = s.get('fov')
    this.camera.updateProjectionMatrix()

    const wantsPost = s.get('bloom') || s.get('antialias') || s.get('tiltShift')
    if (wantsPost) this._ensureComposer()
    else this._disposeComposer()

    if (this.composer) {
      if (this.bloomPass) {
        this.bloomPass.enabled = s.get('bloom')
        this.bloomPass.strength = s.get('bloomStrength')
      }
      if (this.smaaPass) this.smaaPass.enabled = s.get('antialias')
      if (this.tiltShift) {
        this.tiltShift.enabled = s.get('tiltShift')
        this.tiltShift.setStrength(s.get('tiltShiftStrength'))
        this.tiltShift.setAngle(s.get('tiltShiftAngle'))
        this.tiltShift.setCamera(this.camera)
      }
      // Exactly one pass finishes the frame, and which one depends on what follows it.
      this._syncOutputPass()
    }

    this.resize()
  }

  _ensureComposer() {
    if (this.composer) return
    // Everything below is built at 1x1 and sized by the resize that follows, so the size
    // cache has to forget what it last applied or that resize will decide it has nothing to do.
    this._sizedAt = null
    // A depth texture on the target is what lets tilt-shift be a real depth of field rather
    // than a screen-space smear. It costs one attachment, where asking three's own BokehPass
    // for the same thing costs a second pass over the entire scene.
    const depthTexture = new THREE.DepthTexture(1, 1)
    depthTexture.type = THREE.UnsignedIntType
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, // HDR: values above 1 survive to the bloom pass
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: 0,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
    })
    const composer = new EffectComposer(this.renderer, target)
    composer.addPass(new RenderPass(this.scene, this.camera))

    // A high threshold is what keeps this an accent rather than a haze: only the eyes,
    // lamps, sparks and the sun's disc clear it, so lit surfaces stay crisp.
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), this.settings.get('bloomStrength'), 0.55, 0.92)
    composer.addPass(this.bloomPass)

    // After bloom, so an out-of-focus lamp keeps its glow and the glow goes soft with it
    // — blurring first would drop those pixels under the bloom threshold and switch the
    // glow off exactly where the eye expects the most of it. It blurs linear HDR values,
    // and its final composite is also where tone mapping and sRGB happen while it is on.
    this.tiltShift = createTiltShift()
    for (const pass of this.tiltShift.passes) composer.addPass(pass)
    // RenderPass and the bloom pass both leave their result in the composer's *read* buffer
    // and neither asks for a swap, so renderTarget2 is what actually holds the scene — and
    // its depth texture is the clone that got written, not the one handed in above.
    // Deliberately not bound to a fixed target here — see `_syncDepthTexture`.
    this.tiltShift.enabled = this.settings.get('tiltShift')
    this.tiltShift.setStrength(this.settings.get('tiltShiftStrength'))
    this.tiltShift.setAngle(this.settings.get('tiltShiftAngle'))
    this.tiltShift.setCamera(this.camera)
    this.tiltShift.setFocusDistance(this._focusDistance)

    // OutputPass applies tone mapping + sRGB once, at the end of the chain. It is switched
    // off only when the tilt-shift's own composite has already done both, which it does
    // exactly when it is the last pass — see `_syncOutputPass`.
    this.outputPass = new OutputPass()
    composer.addPass(this.outputPass)

    this.smaaPass = new SMAAPass(1, 1)
    composer.addPass(this.smaaPass)

    this.composer = composer
    this._syncOutputPass()
  }

  /**
   * Decide which pass finishes the frame.
   *
   * The tilt-shift's composite tone maps and encodes on its way out, saving a second pass
   * over every pixel — but three only compiles a material to tone map when that material
   * draws to the *screen*, so the composite can only do this while it is the last pass in
   * the chain. Antialiasing puts SMAA after it, and then the composite draws into a render
   * target, leaves the frame in linear HDR, and the output pass has to do the job instead.
   *
   * Getting this wrong is not subtle: the composite named a tone-mapping function three had
   * not emitted, its fragment shader failed to compile, and the pass drew nothing — a black
   * canvas on the two presets that turn antialiasing on, and only those two.
   */
  _syncOutputPass() {
    if (!this.outputPass) return
    const tiltFinishes = Boolean(this.tiltShift?.enabled) && !this.smaaPass?.enabled
    this.outputPass.enabled = !tiltFinishes
  }

  _disposeComposer() {
    if (!this.composer) return
    this.composer.renderTarget1?.dispose()
    this.composer.renderTarget2?.dispose()
    for (const pass of this.composer.passes) pass.dispose?.()
    this.composer = null
    this.bloomPass = null
    this.smaaPass = null
    this.tiltShift = null
    this.outputPass = null
  }

  /**
   * Size the drawing buffer to the element.
   *
   * The scale is *not* re-derived from the setting here, and that is the whole point. The
   * governor scales **under** whatever was chosen, and it owns `viewport.scale` between
   * resizes; reasserting the ceiling would hand the buffer back at full size every time
   * anything called this — a window resize, a DPR change, waking from a hidden tab — and
   * leave the governor to walk it back down a step a second, reallocating the buffer and
   * every float target in the post chain at each step. That churn is visible: measured, the
   * buffer never settled, running 951 → 1632 → 1056 → 768 → 672 inside twenty seconds.
   *
   * A ceiling that has genuinely moved is different. Raising the quality setting, or
   * dragging the window to a display with another pixel ratio, is a new instruction rather
   * than a layout change, so the governor starts again from it.
   */
  resize() {
    const parent = this.canvas.parentElement
    if (!parent) return
    const w = Math.max(1, parent.clientWidth)
    const h = Math.max(1, parent.clientHeight)

    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()

    const ceiling = this._targetScale()
    const settled = this.viewport?.scale
    const ceilingMoved = this._ceiling === undefined || Math.abs(this._ceiling - ceiling) > 0.001
    if (ceilingMoved) this._resetGovernor()
    this._ceiling = ceiling
    const scale = settled == null || ceilingMoved ? ceiling : Math.min(settled, ceiling)

    // The element's own size, which the pointer maths reads. Only the drawing buffer is
    // sized below; the element is left to the CSS (`position: absolute; inset: 0`), because
    // a hand-written width is a second opinion about how big the canvas is — and the moment
    // the two disagree, the scene is drawn to one rectangle while every panel is positioned
    // against the other.
    this.viewport = { ...this.viewport, w, h }
    this._applyBufferSize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), scale)
  }

  /**
   * Resize every target, then put something in them before the compositor can look.
   *
   * `setSize` on the renderer and the composer throws away their attachments and allocates
   * new ones, and a newly allocated target holds nothing. Whether the frame that lands in
   * between reads as a flash depends on the browser — but there is no reason to leave it to
   * chance when drawing once here closes the window entirely. It is the same trick `_onWake`
   * already used for coming back from a hidden tab.
   */
  _applyBufferSize(bw, bh, scale) {
    // Measured against what was last actually applied, not against the viewport: a composer
    // that has just been rebuilt is 1×1 and needs sizing even when the buffer itself has not
    // moved a pixel, so `_ensureComposer` clears this to say so.
    if (this._sizedAt && this._sizedAt.bw === bw && this._sizedAt.bh === bh) {
      this.viewport = { ...this.viewport, scale }
      return
    }
    this._sizedAt = { bw, bh }
    this.renderer.setSize(bw, bh, false)
    this.composer?.setSize(bw, bh)
    // After the composer, which has just sized the bloom to the whole buffer.
    this.bloomPass?.setSize(Math.max(1, Math.round(bw * BLOOM_SCALE)), Math.max(1, Math.round(bh * BLOOM_SCALE)))
    this.tiltShift?.setSize(bw, bh)
    this.tiltShift?.setCamera(this.camera)
    this.viewport = { ...this.viewport, bw, bh, scale }
    if (this.running) this.renderFrame()
  }

  /** Forget what the governor has learned — the thing it was scaling against has changed. */
  _resetGovernor() {
    this._slow = 0
    this._fast = 0
    this._climbAt = 0
    this._tooSlow = null
    this.autoScaled = false
    this.warmUp()
  }

  /** Watch, do not act, for a few seconds: what follows a start or a wake is not the steady state. */
  warmUp() {
    this._warmUntil = performance.now() + WARMUP_MS
    this._slow = 0
    this._fast = 0
  }

  /**
   * Buffer pixels per CSS pixel. `renderScale` is a share of what the display can actually
   * show, so 100% is native on any panel and 50% is half of it either way.
   */
  /**
   * Point the depth-of-field pass at the depth that was actually just written.
   *
   * This cannot be wired once at build time. `EffectComposer` keeps its read/write buffers
   * between frames, and this chain performs an odd number of swaps, so the two targets trade
   * places every frame — and `RenderPass` always draws into whichever is currently the *read*
   * buffer. Binding one target's depth texture permanently therefore samples the previous
   * frame's depth on every other frame, which shows up as the whole picture strobing between
   * sharp and smeared rather than as anything recognisable as a depth-of-field bug.
   */
  _syncDepthTexture() {
    if (this.tiltShift && this.composer) {
      this.tiltShift.setDepthTexture(this.composer.readBuffer.depthTexture)
    }
  }

  /** What the view is looking at, so the plane of focus can sit on it. */
  setFocusDistance(distance) {
    this._focusDistance = distance
    this.tiltShift?.setFocusDistance(distance)
  }

  _targetScale() {
    return this.settings.get('renderScale') * (window.devicePixelRatio || 1)
  }

  /**
   * The GPU took the context away — a driver reset, a TDR on an integrated part under load,
   * the browser reclaiming it from a background tab. Left alone the canvas stays black for as
   * long as the page is open, because a context is only ever given back to a page that said
   * it wants one: `preventDefault` is that request, and without it `webglcontextrestored`
   * never fires at all.
   *
   * The loop stops rather than drawing into a dead context (every call is a silent no-op,
   * and the governor would read the resulting thousand-fps frames as a machine with room to
   * spare). The simulation stops with it, which is fine: nothing here is real-time.
   *
   * Announced on `window` as `botsbay:graphics` with `detail.state` of `lost`, `restored` or
   * `failed`, for anything that wants to say so; the overlay below is this file's own.
   */
  _contextLost(e) {
    e.preventDefault()
    if (this.contextLost) return
    this.contextLost = true
    this._wasRunning = this.running
    this.renderer.setAnimationLoop(null)
    this._showOverlay(false)
    // A context that is not coming back is worth saying so about, rather than a spinner.
    clearTimeout(this._giveUp)
    this._giveUp = setTimeout(() => {
      if (this.contextLost) this._showOverlay(true)
    }, 6000)
    window.dispatchEvent(new CustomEvent('botsbay:graphics', { detail: { state: 'lost' } }))
  }

  /**
   * Three re-initialises its own state on restore (programs, buffers and textures are all
   * uploaded again on first use), but three things it cannot know about are empty: the sky's
   * prefiltered environment and the shadow map are render targets that held a picture, and
   * the post chain's targets and their depth texture were sized against the old context.
   * The chain is rebuilt from scratch — cheap, and the one way to be certain. The sky listens
   * for the same event and redraws its environment; anything on the updater list that keeps
   * GPU-side state of its own is told through `onContextRestored`.
   */
  _contextRestored() {
    if (!this.contextLost) return
    clearTimeout(this._giveUp)
    try {
      this._disposeComposer()
      this._sizedAt = null
      this._shadowSize = null
      this.applySettings()
      for (const u of this.updaters) u.onContextRestored?.()
      this.contextLost = false
      this._hideOverlay()
      if (this._wasRunning) {
        this.timer.reset()
        this.renderer.setAnimationLoop(this._boundLoop)
      }
      window.dispatchEvent(new CustomEvent('botsbay:graphics', { detail: { state: 'restored' } }))
    } catch (err) {
      // Restored, but not into anything we can draw with: offer the reload that will.
      console.error('Could not rebuild after a context loss', err)
      this._showOverlay(true)
      window.dispatchEvent(new CustomEvent('botsbay:graphics', { detail: { state: 'failed' } }))
    }
  }

  /** A small self-contained notice. Built on first use, so a healthy session never has it. */
  _showOverlay(offerReload) {
    if (!this._overlay) {
      const box = document.createElement('div')
      box.setAttribute('role', 'status')
      box.setAttribute('aria-live', 'polite')
      box.style.cssText =
        'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483000;' +
        'padding:14px 20px;border-radius:12px;background:rgba(14,18,34,0.92);color:#e8ecf8;' +
        'font:500 14px/1.4 system-ui,sans-serif;text-align:center;' +
        'box-shadow:0 8px 32px rgba(0,0,0,0.45);border:1px solid rgba(160,180,230,0.25)'
      const text = document.createElement('div')
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = 'Reload'
      button.style.cssText =
        'display:none;margin-top:10px;padding:6px 16px;border-radius:8px;cursor:pointer;' +
        'border:1px solid rgba(160,180,230,0.4);background:#2a3560;color:inherit;font:inherit'
      button.addEventListener('click', () => location.reload())
      box.append(text, button)
      document.body.appendChild(box)
      this._overlay = { box, text, button }
    }
    const { box, text, button } = this._overlay
    box.style.display = ''
    text.textContent = offerReload
      ? 'Graphics could not be restored. Reload to carry on.'
      : 'Graphics were reset — restoring…'
    button.style.display = offerReload ? 'inline-block' : 'none'
  }

  _hideOverlay() {
    if (this._overlay) this._overlay.box.style.display = 'none'
  }

  start() {
    if (this.running) return
    this.running = true
    this.timer.reset()
    this.warmUp()
    this.renderer.setAnimationLoop(this._boundLoop)
  }

  stop() {
    this.running = false
    this.renderer.setAnimationLoop(null)
  }

  _loop() {
    if (this.contextLost) return
    this.timer.update()
    // The timer already zeroes the delta across a hidden tab; the clamp is the backstop for
    // an ordinary long frame, so one stalled frame never jumps the whole colony forward.
    const dt = Math.min(this.timer.getDelta(), 0.1)
    this.elapsed += dt

    for (const u of this.updaters) u.update?.(dt, this.elapsed)

    this.renderer.info.reset()
    if (this.composer && (this.settings.get('bloom') || this.settings.get('antialias') || this.settings.get('tiltShift'))) {
      this._syncDepthTexture()
      this.composer.render(dt)
    } else {
      this.renderer.render(this.scene, this.camera)
    }

    this.perf.sample(dt, this.renderer.info)
    if (this.settings.get('autoQuality')) this._governQuality()
  }

  /**
   * Draw one frame without stepping the simulation. Used by the screenshot path, which has
   * to read the drawing buffer in the same task as the draw that filled it — the alternative
   * is `preserveDrawingBuffer`, which costs a full copy on every frame forever.
   */
  renderFrame() {
    if (this.contextLost) return
    this.renderer.info.reset()
    if (this.composer && (this.settings.get('bloom') || this.settings.get('antialias') || this.settings.get('tiltShift'))) {
      this._syncDepthTexture()
      this.composer.render(0)
    } else {
      this.renderer.render(this.scene, this.camera)
    }
  }

  /**
   * Adaptive render scale. Never touches the setting the user chose; it scales *under* it.
   *
   * Every move resizes the drawing buffer and rebuilds the post chain's render targets,
   * which is a visible event — on WebKit it can cost a black frame outright. So the bar for
   * moving is deliberately high: a full second between samples, several consecutive samples
   * agreeing before anything changes, and a long cooldown before it climbs back after a
   * drop. A governor that reacts to one bad second finds the boundary and then sits on it,
   * resizing back and forth for as long as you leave the window open.
   */
  _governQuality() {
    const now = performance.now()
    if (now - (this._lastGovern || 0) < 1000) return
    this._lastGovern = now

    if (now < (this._warmUntil || 0)) return
    const fps = this.perf.fps
    if (fps <= 0) return
    const ceiling = this._targetScale()
    const current = this.viewport?.scale ?? ceiling
    // The floor is half the display's own resolution, not half a CSS pixel: on a retina
    // panel the old absolute 0.5 was a quarter-resolution buffer, which reads as broken
    // rather than as a machine having a hard time.
    const floor = Math.min(ceiling, MIN_SCALE * (window.devicePixelRatio || 1))

    // Sustained evidence, not one sample: 3 slow seconds to drop, 8 fast ones to climb.
    this._slow = fps < SLOW_FPS ? (this._slow || 0) + 1 : 0
    this._fast = fps > FAST_FPS ? (this._fast || 0) + 1 : 0
    const dpr = window.devicePixelRatio || 1

    // Climbing stops short of the last scale that could not hold the frame rate.
    if (this._tooSlow && now >= this._tooSlow.until) this._tooSlow = null
    const cap = this._tooSlow ? Math.min(ceiling, this._tooSlow.scale - 0.05 * dpr) : ceiling

    let next = current
    if (this._slow >= 3) {
      // Far below the line, go straight to where it should land rather than a step at a time:
      // pixel cost goes with the square of the scale, so the square root of the shortfall is
      // the estimate. Three visible resolution changes in a row read worse than one.
      next = Math.max(floor, Math.min(current - 0.15 * dpr, current * Math.sqrt(fps / FAST_FPS)))
      this._slow = 0
      // Having just proved this machine cannot hold the higher scale, do not go back and
      // ask it again ten seconds later — that is the oscillation.
      this._climbAt = now + 30000
      this._tooSlow = { scale: current, until: now + TOO_SLOW_MS }
    } else if (this._fast >= 8 && current < cap - 0.01 && now >= (this._climbAt || 0)) {
      next = Math.min(cap, current + 0.1 * dpr)
      this._fast = 0
    }

    if (Math.abs(next - current) > 0.01) {
      const parent = this.canvas.parentElement
      if (!parent) return
      const bw = Math.max(1, Math.round(parent.clientWidth * next))
      const bh = Math.max(1, Math.round(parent.clientHeight * next))
      // Through the same path a resize takes, so the new targets are drawn into before the
      // compositor sees them — and so there is one place that knows how to change size.
      this._applyBufferSize(bw, bh, next)
      const was = this.autoScaled
      this.autoScaled = next < ceiling - 0.01
      if (this.autoScaled && !was) this.onAutoScaled?.()
    }
  }

  dispose() {
    this.stop()
    this.timer.dispose()
    window.removeEventListener('resize', this._onResize)
    this._dprQuery?.removeEventListener?.('change', this._onResize)
    this._observer?.disconnect()
    clearTimeout(this._giveUp)
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored)
    this._overlay?.box.remove()
    document.removeEventListener('visibilitychange', this._onWake)
    window.removeEventListener('focus', this._onWake)
    window.removeEventListener('pageshow', this._onWake)
    this._disposeComposer()
    this.renderer.dispose()
  }
}

/** Rolling frame stats — an EMA so the readout does not flicker on a single slow frame. */
class PerfMonitor {
  constructor() {
    this.fps = 0
    this.frameMs = 0
    this.drawCalls = 0
    this.triangles = 0
    this._frames = 0
  }

  sample(dt, info) {
    const ms = dt * 1000
    const k = this._frames < 10 ? 0.3 : 0.06
    this.frameMs += (ms - this.frameMs) * k
    this.fps = this.frameMs > 0 ? 1000 / this.frameMs : 0
    this._frames++
    if (this._frames % 10 === 0) {
      this.drawCalls = info.render.calls
      this.triangles = info.render.triangles
    }
  }
}
