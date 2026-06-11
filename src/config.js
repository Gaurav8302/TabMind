export const CONFIG = {
  SCHEMA_VERSION: 1,
  EXPORT_VERSION: 2,
  STORAGE_KEYS: {
    WORKSPACES: 'tabmind_workspaces',
    META: 'tabmind_schema_meta',
    SORT_PREFERENCE: 'tabmind_sort_preference',
  },
  SORT_OPTIONS: {
    NEWEST: 'newest',
    OLDEST: 'oldest',
    AZ: 'az',
    ZA: 'za',
    MOST_TABS: 'most_tabs',
    LEAST_TABS: 'least_tabs',
  },
  LIMITS: {
    MAX_WORKSPACES: 50,
    MAX_NOTES_LENGTH: 1000,
  },
};
