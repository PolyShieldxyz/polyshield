interface SparklineProps {
  data: number[]
  width?: number
  height?: number
  color?: string
  fill?: boolean
  strokeWidth?: number
}

export function Sparkline({ data, width = 120, height = 32, color = 'var(--cyan)', fill = true, strokeWidth = 1.25 }: SparklineProps) {
  const min = Math.min(...data)
  const max = Math.max(...data)
  const xs = (i: number) => (i / (data.length - 1)) * width
  const ys = (v: number) => height - ((v - min) / (max - min || 1)) * (height - 2) - 1
  const points = data.map((v, i) => `${xs(i)},${ys(v)}`).join(' ')
  const area = `M0,${height} L${points.split(' ').join(' L')} L${width},${height} Z`
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {fill && <path d={area} fill={color} opacity="0.10" />}
      <polyline points={points} fill="none" stroke={color} strokeWidth={strokeWidth} />
    </svg>
  )
}
