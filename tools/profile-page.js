/**
 * Runs inside the page, injected by `profile.mjs`.
 *
 * Takes over the frame loop so every render can be bracketed with a GPU timer query, then
 * measures a list of configurations and a per-pass breakdown of the balanced preset.
 */
async function __profile({ scale = 1, quick = false } = {}) {
  const bc = window.botsBay || window.botCrossing
  const { engine, colony, settings, rig } = bc
  const renderer = engine.renderer
  const gl = renderer.getContext()
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  const gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')

  // Deterministic conditions: no governor, a fixed time of day with the sun well up, the
  // default overview camera, and the requested render scale.
  engine.stop()
  settings.set('autoQuality', false)
  settings.set('clockTime', false)
  settings.set('autoTime', false)
  settings.set('timeOfDay', 0.42)
  rig.resetView()
  rig.distance = rig.desiredDistance
  rig.azimuth = rig.desiredAzimuth
  rig.polar = rig.desiredPolar

  const raf = () => new Promise((r) => requestAnimationFrame(r))

  /** One simulated + rendered frame, exactly as the engine's loop does it, with a query round it. */
  function frame(q) {
    engine.timer.update()
    const dt = Math.min(engine.timer.getDelta(), 0.1)
    engine.elapsed += dt
    for (const u of engine.updaters) u.update?.(dt, engine.elapsed)
    const t0 = performance.now()
    if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q)
    engine.renderFrame()
    if (q) gl.endQuery(ext.TIME_ELAPSED_EXT)
    return performance.now() - t0
  }

  /** Collect finished timer queries into milliseconds. */
  function harvest(pending, out) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const q = pending[i]
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) out.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6)
        gl.deleteQuery(q)
        pending.splice(i, 1)
      }
    }
  }

  const stats = (arr) => {
    if (!arr.length) return null
    const s = [...arr].sort((a, b) => a - b)
    const mean = s.reduce((a, b) => a + b, 0) / s.length
    return { mean: +mean.toFixed(2), p50: +s[Math.floor(s.length * 0.5)].toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2), n: s.length }
  }

  async function measure(label, warm = 25, sample = 90) {
    for (let i = 0; i < warm; i++) {
      frame(null)
      await raf()
    }
    const wall = []
    const cpu = []
    const gpu = []
    const pending = []
    let last = performance.now()
    for (let i = 0; i < sample; i++) {
      const q = ext ? gl.createQuery() : null
      cpu.push(frame(q))
      if (q) pending.push(q)
      harvest(pending, gpu)
      await raf()
      const now = performance.now()
      wall.push(now - last)
      last = now
    }
    for (let i = 0; i < 10 && pending.length; i++) {
      frame(null)
      await raf()
      harvest(pending, gpu)
    }
    const info = renderer.info
    return { label, wallMs: stats(wall), cpuRenderMs: stats(cpu), gpuMs: stats(gpu), calls: info.render.calls, triangles: info.render.triangles, buffer: `${engine.viewport.bw}x${engine.viewport.bh}` }
  }

  const base = { renderScale: scale, bloom: true, tiltShift: true, shadows: 'low', ibl: true, particles: 'low', scatterDensity: 0.6, antialias: false, stars: true }
  const apply = (over) => {
    for (const [k, v] of Object.entries({ ...base, ...over })) settings.set(k, v)
  }

  const all = [
    ['balanced, full scale', {}],
    ['no bloom', { bloom: false }],
    ['no tilt-shift', { tiltShift: false }],
    ['no post at all', { bloom: false, tiltShift: false }],
    ['no shadows', { shadows: 'off' }],
    ['no environment light', { ibl: false }],
    ['no particles', { particles: 'off' }],
    ['no scatter', { scatterDensity: 0 }],
    ['everything off', { bloom: false, tiltShift: false, shadows: 'off', ibl: false, particles: 'off', scatterDensity: 0 }],
    ['balanced at 75% scale', { renderScale: scale * 0.75 }],
    ['balanced at 55% scale', { renderScale: scale * 0.55 }],
  ]
  const list = quick ? [all[0], all[3], all[8]] : all

  const results = []
  for (const [label, over] of list) {
    apply(over)
    results.push(await measure(label))
  }

  // Close up, where the ground fills the frame and the fine builders are drawn.
  apply({})
  rig.desiredDistance = 22
  rig.distance = 22
  results.push(await measure('balanced, camera at 22'))
  rig.resetView()
  rig.distance = rig.desiredDistance

  // Per-pass breakdown: each composer pass bracketed on its own, then the shadow pass on a
  // run of its own (it nests inside the render pass, and timer queries cannot nest).
  // The build minifies class names, so a pass is recognised by what it carries.
  const passName = (pass) =>
    pass.name ||
    (pass.scene && pass.camera ? 'render (scene + shadows)' : pass.nMips ? 'bloom' : pass.edgesRT ? 'smaa' : pass._toneMapping !== undefined ? 'output' : pass.constructor.name)

  const passes = {}
  if (ext && engine.composer) {
    const wrapped = []
    for (const pass of engine.composer.passes) {
      const name = passName(pass)
      const orig = pass.render
      const bucket = (passes[name] = { pending: [], ms: [] })
      pass.render = function (...a) {
        if (!this.enabled) return orig.apply(this, a)
        const q = gl.createQuery()
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q)
        orig.apply(this, a)
        gl.endQuery(ext.TIME_ELAPSED_EXT)
        bucket.pending.push(q)
      }
      wrapped.push([pass, orig])
    }
    for (let i = 0; i < 100; i++) {
      frame(null)
      await raf()
      for (const b of Object.values(passes)) harvest(b.pending, b.ms)
    }
    for (const [pass, orig] of wrapped) pass.render = orig
    for (let i = 0; i < 10; i++) {
      frame(null)
      await raf()
      for (const b of Object.values(passes)) harvest(b.pending, b.ms)
    }
  }
  const passStats = Object.fromEntries(Object.entries(passes).map(([k, v]) => [k, stats(v.ms.slice(10))]))

  let shadowStats = null
  if (ext) {
    const sm = renderer.shadowMap
    const orig = sm.render
    const bucket = { pending: [], ms: [] }
    sm.render = function (...a) {
      const q = gl.createQuery()
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q)
      orig.apply(this, a)
      gl.endQuery(ext.TIME_ELAPSED_EXT)
      bucket.pending.push(q)
    }
    for (let i = 0; i < 100; i++) {
      frame(null)
      await raf()
      harvest(bucket.pending, bucket.ms)
    }
    sm.render = orig
    for (let i = 0; i < 10; i++) {
      frame(null)
      await raf()
      harvest(bucket.pending, bucket.ms)
    }
    shadowStats = stats(bucket.ms.slice(10))
  }

  let scatter = 0
  for (const m of colony.scatterGroup?.children || []) scatter += m.count || 0

  engine.start()
  return {
    gpuName,
    timerQueries: Boolean(ext),
    dpr: window.devicePixelRatio,
    css: `${engine.viewport.w}x${engine.viewport.h}`,
    buffer: `${engine.viewport.bw}x${engine.viewport.bh}`,
    scene: { crew: colony.astronauts.agents.length, buildings: colony.buildings.size, plots: colony.plots.size, scatter },
    results,
    passes: passStats,
    shadowPass: shadowStats,
  }
}
