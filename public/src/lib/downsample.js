/** Average consecutive readings into at most `max` points so long ranges chart quickly. */
export function downsample(readings, max) {
  if (readings.length <= max) return readings
  const size = Math.ceil(readings.length / max)
  const out = []
  for (let i = 0; i < readings.length; i += size) {
    const chunk = readings.slice(i, i + size)
    const avg = (key) => chunk.reduce((s, r) => s + r[key], 0) / chunk.length
    out.push({ id: chunk[0].id, time: avg('time'), temperature_c: avg('temperature_c') })
  }
  return out
}
