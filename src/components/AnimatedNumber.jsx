import useAnimatedNumber from '../hooks/useAnimatedNumber'

export default function AnimatedNumber({
  value,
  prefix = '',
  suffix = '',
  decimals = 2,
  duration = 600,
  className = '',
}) {
  const animated = useAnimatedNumber(value || 0, duration)
  const formatted = typeof animated === 'number' && !isNaN(animated)
    ? animated.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })
    : '0'

  return (
    <span className={className}>
      {prefix}{formatted}{suffix}
    </span>
  )
}
