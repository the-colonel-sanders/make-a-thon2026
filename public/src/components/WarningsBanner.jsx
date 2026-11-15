import { dangerRangeLabel, formatDuration, formatThreshold } from '../lib/format.js'
import { getSettings } from '../lib/settings.js'

/**
 * Summary of items needing attention: red (spoiled) first, then yellow
 * (in danger: the fridge is in the danger zone right now).
 */
export function WarningsBanner({ rows, inZoneNow }) {
  const LIMIT = formatThreshold(getSettings().redExposureMs)
  const critical = rows.filter((r) => r.status === 'critical')
  const warning = rows.filter((r) => r.status === 'warning')
  if (!critical.length && !warning.length && !inZoneNow) return null

  return (
    <div className="banners" role="alert">
      {critical.length > 0 && (
        <div className="banner banner--critical">
          <span className="banner__icon" aria-hidden="true">✕</span>
          <div>
            <strong>
              {critical.length} item{critical.length > 1 ? 's have' : ' has'} spoiled ({LIMIT} or more in
              the danger zone).
            </strong>
            <p>Discard: {critical.map((r) => r.item.name).join(', ')}</p>
          </div>
        </div>
      )}
      {(warning.length > 0 || inZoneNow) && (
        <div className="banner banner--warning">
          <span className="banner__icon" aria-hidden="true">!</span>
          <div>
            <strong>
              {inZoneNow
                ? `The fridge is in the danger zone (${dangerRangeLabel()}).`
                : 'Some items are in danger.'}
            </strong>
            {warning.length > 0 && (
              <p>
                In danger (spoiled at {LIMIT}):{' '}
                {warning.map((r) => `${r.item.name} (${formatDuration(r.exposureMs)})`).join(', ')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
