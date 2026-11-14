// Every localStorage key the dashboard uses, in one place so backup/restore
// and "erase all data" on the Settings page can't miss one.
export const STORAGE_KEYS = {
  items: 'fridge-dashboard.food-items.v1',
  profiles: 'fridge-dashboard.profiles.v1',
  activeProfile: 'fridge-dashboard.active-profile.v1',
  notifications: 'fridge-dashboard.notifications.v1',
  settings: 'fridge-dashboard.settings.v1',
}
