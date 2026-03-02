import React, { useEffect, useRef } from 'react'

export default function DarkOrb({ size = 420, className = '' }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const s = size * dpr
    canvas.width = s
    canvas.height = s
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    ctx.scale(dpr, dpr)

    let t = 0
    let animId

    function draw() {
      t += 0.003
      ctx.clearRect(0, 0, size, size)
      const cx = size / 2
      const cy = size / 2
      const baseR = size * 0.32

      // Outer aurora halo
      for (let ring = 0; ring < 5; ring++) {
        const r = baseR + 30 + ring * 18
        const alpha = 0.025 - ring * 0.004
        const grad = ctx.createRadialGradient(cx, cy, r * 0.7, cx, cy, r)
        const hue = (200 + ring * 15 + t * 20) % 360
        grad.addColorStop(0, `hsla(${hue}, 80%, 60%, ${alpha})`)
        grad.addColorStop(0.5, `hsla(${hue + 30}, 70%, 50%, ${alpha * 0.5})`)
        grad.addColorStop(1, 'transparent')
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fillStyle = grad
        ctx.fill()
      }

      // Main dark sphere body with distortion
      const layers = 40
      for (let i = layers; i >= 0; i--) {
        const frac = i / layers
        const r = baseR * frac

        // Organic wobble via layered sine offsets
        const wobbleX = Math.sin(t * 1.7 + frac * 4) * 3 * (1 - frac)
        const wobbleY = Math.cos(t * 1.3 + frac * 3) * 3 * (1 - frac)

        const grad = ctx.createRadialGradient(
          cx + wobbleX - 20 * frac, cy + wobbleY - 25 * frac, 0,
          cx + wobbleX, cy + wobbleY, r
        )

        // Deep dark core with subtle color shift
        const coreLightness = 4 + frac * 8
        const coreHue = 240 + Math.sin(t + frac * 2) * 15
        const edgeHue = 200 + Math.sin(t * 0.7) * 20
        const edgeAlpha = 0.6 + frac * 0.4

        grad.addColorStop(0, `hsla(${coreHue}, 30%, ${coreLightness}%, 1)`)
        grad.addColorStop(0.6, `hsla(${coreHue}, 25%, ${coreLightness * 0.7}%, ${edgeAlpha})`)
        grad.addColorStop(0.85, `hsla(${edgeHue}, 50%, ${12 + frac * 6}%, ${edgeAlpha * 0.5})`)
        grad.addColorStop(1, 'transparent')

        ctx.beginPath()
        ctx.arc(cx + wobbleX, cy + wobbleY, r, 0, Math.PI * 2)
        ctx.fillStyle = grad
        ctx.fill()
      }

      // Surface energy tendrils
      const tendrilCount = 6
      for (let i = 0; i < tendrilCount; i++) {
        const angle = (i / tendrilCount) * Math.PI * 2 + t * 0.5
        const len = baseR * (0.85 + Math.sin(t * 2 + i * 1.3) * 0.15)

        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(angle)

        const tGrad = ctx.createLinearGradient(0, 0, len, 0)
        const hue = 200 + i * 25 + Math.sin(t + i) * 15
        tGrad.addColorStop(0, 'transparent')
        tGrad.addColorStop(0.3, `hsla(${hue}, 70%, 50%, 0.08)`)
        tGrad.addColorStop(0.6, `hsla(${hue}, 80%, 55%, 0.12)`)
        tGrad.addColorStop(1, 'transparent')

        ctx.beginPath()
        const thickness = 15 + Math.sin(t * 3 + i) * 5
        ctx.moveTo(baseR * 0.6, -thickness)
        ctx.quadraticCurveTo(
          len * 0.7, -thickness * (0.5 + Math.sin(t * 2 + i) * 0.3),
          len, 0
        )
        ctx.quadraticCurveTo(
          len * 0.7, thickness * (0.5 + Math.cos(t * 2 + i) * 0.3),
          baseR * 0.6, thickness
        )
        ctx.fillStyle = tGrad
        ctx.fill()
        ctx.restore()
      }

      // Specular highlight — breathing
      const specAlpha = 0.08 + Math.sin(t * 1.5) * 0.03
      const specGrad = ctx.createRadialGradient(
        cx - baseR * 0.25, cy - baseR * 0.3, 0,
        cx - baseR * 0.1, cy - baseR * 0.15, baseR * 0.5
      )
      specGrad.addColorStop(0, `rgba(180, 220, 255, ${specAlpha})`)
      specGrad.addColorStop(0.4, `rgba(100, 180, 255, ${specAlpha * 0.4})`)
      specGrad.addColorStop(1, 'transparent')
      ctx.beginPath()
      ctx.arc(cx, cy, baseR, 0, Math.PI * 2)
      ctx.fillStyle = specGrad
      ctx.fill()

      // Inner event horizon ring
      const ringR = baseR * (0.95 + Math.sin(t * 2) * 0.02)
      ctx.beginPath()
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(0, 212, 255, ${0.06 + Math.sin(t * 3) * 0.03})`
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Orbiting micro-particles
      for (let i = 0; i < 12; i++) {
        const orbitR = baseR * (1.1 + i * 0.04)
        const speed = 0.3 + i * 0.05
        const a = t * speed + (i / 12) * Math.PI * 2
        const px = cx + Math.cos(a) * orbitR
        const py = cy + Math.sin(a) * orbitR * (0.85 + Math.sin(t + i) * 0.1)
        const pr = 1 + Math.sin(t * 2 + i) * 0.5
        const pa = 0.15 + Math.sin(t + i * 0.7) * 0.1

        ctx.beginPath()
        ctx.arc(px, py, pr, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(0, 212, 255, ${pa})`
        ctx.fill()
      }

      animId = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(animId)
  }, [size])

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none ${className}`}
      style={{ filter: 'blur(0.5px)' }}
    />
  )
}
