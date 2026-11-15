import { useMemo, useState } from 'react'
import { NavBar } from './components/NavBar.jsx'
import { Toasts } from './components/Toasts.jsx'
import { ProfilePicker } from './components/ProfilePicker.jsx'
import { DashboardPage } from './pages/DashboardPage.jsx'
import { HistoryPage } from './pages/HistoryPage.jsx'
import { ItemPage } from './pages/ItemPage.jsx'
import { AdminPage } from './pages/AdminPage.jsx'
import { SettingsPage } from './pages/SettingsPage.jsx'
import { LocatePage } from './pages/LocatePage.jsx'
import { getSettings, useSettings } from './lib/settings.js'
import { NotificationList } from './components/NotificationList.jsx'
import { useProfiles } from './hooks/useProfiles.js'
import { useBackend } from './hooks/useBackend.js'
import { useDangerAlerts } from './hooks/useDangerAlerts.js'
import { useDeviceDisplaySync } from './hooks/useDeviceDisplaySync.js'
import { useFoodItems } from './hooks/useFoodItems.js'
import { useHashRoute } from './hooks/useHashRoute.js'
import { useNow } from './hooks/useNow.js'
import { useSpoilTracking } from './hooks/useSpoilTracking.js'
import { useServerThresholds } from './hooks/useServerThresholds.js'
import { continuousZoneMs, deviceState, isInDangerZone } from './lib/safety.js'
import { formatDateTime, formatDuration, formatTemp } from './lib/format.js'
import { DEFAULT_APPLIANCE_ID } from './config.js'

/**
 * App shell. Polling, danger alerts and profiles live here so they keep
 * working whichever page is open.
 */
export default function App() {
  const route = useHashRoute()
  // Re-render the whole app when settings change (units, limits, appearance).
  const settings = useSettings()
  const [applianceId, setApplianceId] = useState(() => getSettings().defaultApplianceId ?? DEFAULT_APPLIANCE_ID)
  const now = useNow(1000)
  useServerThresholds()
  const backend = useBackend(applianceId)
  const foodItems = useFoodItems()
  const profiles = useProfiles()
  const exposures = useSpoilTracking(foodItems.items, backend.readings, applianceId, now, foodItems.markSpoiled)
  useDeviceDisplaySync(foodItems.items, backend.applianceIds, exposures)

  const latest = backend.readings.at(-1)
  const device = deviceState(latest, now, backend.lastCheckinAt) // 'on' | 'off' | 'unknown'
  // While the device is off we don't know the real temperature, so the last
  // reading doesn't count as "in the danger zone right now".
  const inZoneNow = device === 'on' && latest != null && isInDangerZone(latest.temperature_c)
  const zoneMs = device === 'on' ? continuousZoneMs(backend.readings, now) : 0
  const itemNames = useMemo(
    () => foodItems.items.filter((it) => it.appliance_id === applianceId && !it.removed_at).map((it) => it.name),
    [foodItems.items, applianceId],
  )
  const alerts = useDangerAlerts(latest, applianceId, zoneMs, itemNames, device)

  return (
    <>
      <NavBar
        route={route}
        online={backend.online}
        error={backend.error}
        lastFetched={backend.lastFetched}
        device={device}
        applianceId={applianceId}
        applianceIds={backend.applianceIds}
        onApplianceChange={setApplianceId}
        profileSlot={
          <ProfilePicker
            profiles={profiles.profiles}
            active={profiles.active}
            onSelect={profiles.setActiveId}
            onAdd={profiles.addProfile}
            onRemove={profiles.removeProfile}
          />
        }
      />

      <main className="app">
        {/* The History page has its own notification section. */}
        {route !== '/history' && (
          <NotificationList
            notifications={alerts.history}
            now={now}
            onDismiss={alerts.dismissHistory}
            onClear={alerts.clearHistory}
          />
        )}

        {route === '/admin' && backend.online === false && (
          <div className="banner banner--offline" role="status">
            <span className="banner__icon" aria-hidden="true">!</span>
            <div>
              <strong>Can’t reach the API.</strong>
              <p>
                Start it with <code>uvicorn main:app --host 0.0.0.0 --port 8000</code> in <code>api/</code>.
                {backend.readings.length > 0 && ' Showing the last data received.'}
              </p>
            </div>
          </div>
        )}

        {backend.online !== false && device === 'off' && (
          <div className="banner banner--device-off" role="status">
            <span className="banner__icon" aria-hidden="true">⏻</span>
            <div>
              <strong>Device off: fridge #{applianceId}’s sensor isn’t sending readings.</strong>
              <p>
                Last reading {formatTemp(latest.temperature_c)} at {formatDateTime(latest.time)} (
                {formatDuration(now - latest.time)} ago). Check the ESP32’s power and Wi-Fi.
              </p>
            </div>
          </div>
        )}

        {route === '/locate' ? (
          <LocatePage now={now} />
        ) : route === '/admin' ? (
          <AdminPage
            applianceId={applianceId}
            applianceIds={backend.applianceIds}
            onHistoryReset={backend.refresh}
            foodItems={foodItems}
            exposures={exposures}
            inZoneNow={inZoneNow}
          />
        ) : route === '/settings' ? (
          <SettingsPage
            profiles={profiles}
            foodItems={foodItems}
            applianceIds={backend.applianceIds}
            notificationCount={alerts.history.length}
            onClearNotifications={alerts.clearHistory}
          />
        ) : route === '/history' ? (
          <HistoryPage
            applianceId={applianceId}
            applianceIds={backend.applianceIds}
            notifications={alerts.history}
            now={now}
            onDismissNotification={alerts.dismissHistory}
            onClearNotifications={alerts.clearHistory}
          />
        ) : route.startsWith('/item/') ? (
          <ItemPage
            key={route}
            itemId={decodeURIComponent(route.slice('/item/'.length))}
            items={foodItems.items}
            now={now}
            liveReadings={backend.readings}
            liveApplianceId={applianceId}
            inZoneNow={inZoneNow}
            onRemove={(id) => foodItems.removeItem(id, profiles.active)}
            onRestore={foodItems.restoreItem}
            onRename={foodItems.renameItem}
          />
        ) : (
          <DashboardPage
            applianceId={applianceId}
            backend={backend}
            inZoneNow={inZoneNow}
            now={now}
            foodItems={foodItems}
            profile={profiles.active}
          />
        )}

        <footer className="footer muted small">
          Readings refresh every 2 s. Items and profiles are saved in this browser only.
        </footer>
      </main>

      {settings.popups && <Toasts toasts={alerts.toasts} onDismiss={alerts.dismiss} />}
    </>
  )
}
