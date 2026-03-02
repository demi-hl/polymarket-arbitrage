import { useState, useEffect, useRef } from 'react'

export default function useAnimatedNumber(value, duration = 600) {
  const [display, setDisplay] = useState(value)
  const prev = useRef(value)

  useEffect(() => {
    const from = prev.current
    const to = value
    prev.current = to
    if (from === to || typeof to !== 'number' || isNaN(to)) {
      setDisplay(to)
      return
    }
    const start = performance.now()
    let raf
    function tick(now) {
      const p = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      setDisplay(from + (to - from) * eased)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])

  return display
}
